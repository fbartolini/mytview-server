import type { Handle, ServerInit } from '@sveltejs/kit';
import { SCAN_ON_START, SCAN_INTERVAL_MIN } from '$lib/server/config';
import { db } from '$lib/server/db';
import { runScan } from '$lib/server/indexer';
import { maybeAutoFedSync } from '$lib/server/fedsync';
import { maybeAutoPlexSync } from '$lib/server/plexsync';
import { stateDb } from '$lib/server/state';
import { userForSession, touchSession, SESSION_COOKIE } from '$lib/server/auth';
import { shareGrantsMedia, shareGrantsThumb } from '$lib/server/share';
import { verifyMedia, type MediaKind } from '$lib/server/mediaToken';

let started = false;

// Runs once before the server handles its first request.
export const init: ServerInit = () => {
	if (started) return; // guard against dev HMR re-running this
	started = true;

	db(); // index schema
	stateDb(); // durable users/sessions/watch schema

	// Kick the first scan (async + batched, so it yields to the server as it runs).
	if (SCAN_ON_START) void runScan();

	// Periodic incremental rescan to pick up new downloads (cheap; mtime-gated).
	if (SCAN_INTERVAL_MIN > 0) setInterval(() => void runScan(), SCAN_INTERVAL_MIN * 60_000);

	// Federation catalog sync — cadence is an OWNER SETTING (app_meta 'fed_sync_min', default 30min
	// vs the scan's 5 — network I/O against someone else's home server), so the driver ticks every
	// minute and the setting decides; changes apply with no restart. First tick after boot syncs
	// immediately (convergence). No-op with no consumer links or cadence 0.
	void maybeAutoFedSync();
	setInterval(() => void maybeAutoFedSync(), 60_000);

	// Plex watch-progress sync — same minute-tick pattern (cadence is the app_meta 'plex_sync_min'
	// owner setting; no-op until the owner sets the PMS address). docs/plex-sync.md.
	void maybeAutoPlexSync();
	setInterval(() => void maybeAutoPlexSync(), 60_000);
};

// Populate locals.user from the session cookie and gate everything behind login.
export const handle: Handle = async ({ event, resolve }) => {
	// Native clients send a bearer token; the web sends the session cookie — same token type.
	const auth = event.request.headers.get('authorization');
	const bearer = auth?.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : undefined;
	const token = event.cookies.get(SESSION_COOKIE) ?? bearer;
	event.locals.user = userForSession(token);
	// Stash the authenticating token so endpoints can name/revoke THIS session; bump its last-seen
	// (throttled) so the manage-devices list shows recency.
	event.locals.sessionToken = event.locals.user ? token : undefined;
	if (event.locals.user && token) touchSession(token);

	const { pathname } = event.url;
	const authRoute =
		pathname === '/login' ||
		pathname === '/signup' ||
		pathname === '/reset' || // owner-issued single-use reset link, opened while logged OUT (auth.ts)
		pathname === '/link/web' || // self-authenticates via a single-use punch-out code (auth.ts)
		pathname === '/api/v1/auth/login' ||
		pathname === '/api/v1/auth/device/start' ||
		pathname === '/api/v1/auth/device/poll' ||
		// Server↔server federation surface: every endpoint self-authenticates (pair via a single-use
		// invite; the rest via the link secret in the Bearer header — which is NOT a session token, so
		// userForSession above already yielded null). See fedserve.ts / docs/federation-design.md.
		pathname.startsWith('/api/fed/');

	// Public share links: the /s/[token] viewer page, and token-scoped media/thumb for the ONE
	// shared video. The token must match the exact id in the path — this is never a blanket
	// media bypass, and it grants nothing else (no library, no other video).
	let shareOk = pathname.startsWith('/s/');
	if (!shareOk) {
		const tok = event.url.searchParams.get('s');
		const m = tok ? pathname.match(/^\/(media|thumb)\/([^/]+)$/) : null;
		if (tok && m) {
			let id: string | null = null;
			try {
				id = decodeURIComponent(m[2]); // malformed %-encoding → fail closed, don't throw a 500
			} catch {
				id = null;
			}
			if (id) {
				// The thumbnail is grantable by token alone — it's already public on the /s/[token]
				// page and link-unfurl bots (no cookie) need it for the OG preview image. The video
				// STREAM additionally requires the per-viewer cookie for a capped share, so the cap
				// can't be defeated by copying the raw /media URL.
				shareOk =
					m[1] === 'thumb'
						? shareGrantsThumb(tok, id)
						: shareGrantsMedia(tok, id, event.cookies.get(`mv_share_${tok}`) === '1');
			}
		}
	}

	// Signed media/image URLs (native players / AirPlay — mediaToken.ts): a valid `?k=&exp=` grants
	// login-exempt access to exactly this (kind, id) file, like a share token but derived from the
	// server secret. media/thumb are a video's; poster/fanart are a channel's. Only checked when
	// there's no session (a logged-in request is already authorized) and no share token matched.
	let signedOk = false;
	if (!event.locals.user && !shareOk && event.url.searchParams.has('k')) {
		const m = pathname.match(/^\/(media|thumb|poster|fanart)\/([^/]+)$/);
		if (m) {
			let id: string | null = null;
			try {
				id = decodeURIComponent(m[2]); // malformed %-encoding → fail closed
			} catch {
				id = null;
			}
			if (id) signedOk = verifyMedia(m[1] as MediaKind, id, event.url);
		} else {
			// HLS on-the-fly transcode: /hls/v/<videoId>/index.m3u8 (id=videoId) or
			// /hls/s/<sid>/seg….ts (id=sid) — both signed with the 'hls' kind; the session id is also an
			// unguessable capability, handed out only by an already-authed index.m3u8.
			const h =
				pathname.match(/^\/hls\/v\/([^/]+)\/index\.m3u8$/) ??
				pathname.match(/^\/hls\/s\/([^/]+)\/seg\d+\.ts$/);
			if (h) {
				let id: string | null = null;
				try {
					id = decodeURIComponent(h[1]);
				} catch {
					id = null;
				}
				if (id) signedOk = verifyMedia('hls', id, event.url);
			}
		}
	}

	if (!event.locals.user && !authRoute && !shareOk && !signedOk) {
		// APIs / media answer 401; page requests get bounced to the login screen.
		if (pathname.startsWith('/api/') || /^\/(media|thumb|poster|fanart|hls)\//.test(pathname)) {
			// The media 401 carries CORS too (below) so a federated hls.js reads a real 401, not an
			// opaque CORS failure, when a signature expires.
			const headers = /^\/(hls|media)\//.test(pathname)
				? { 'access-control-allow-origin': '*' }
				: undefined;
			return new Response('Unauthorized', { status: 401, headers });
		}
		// Bounce WITH the return path (login's safeNext brings them back after signing in) — e.g. a
		// logged-out phone opening the TV pairing QR (/link?code=…) must land back on /link with the
		// code intact, not on the homepage.
		const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + event.url.search)}`;
		return new Response(null, { status: 303, headers: { location: `/login${next}` } });
	}

	const res = await resolve(event);
	// Authenticated JSON must never be stored by a shared cache — a `Cookie` request header does NOT
	// inhibit caching the way `Authorization` does (RFC 9111), so behind a caching proxy one user's
	// watch state / sessions list could be served to another. Routes that set their own policy (the
	// HLS no-store) are left alone.
	if (pathname.startsWith('/api/') && !res.headers.has('cache-control')) {
		res.headers.set('cache-control', 'no-store');
	}
	// Cross-origin federated playback (design §9): hls.js on a CONSUMER's web origin XHRs this
	// server's signed /hls playlist + segments (GET, no custom headers → no preflight; the `?k=`
	// signature is the credential — allow-origin:* leaks nothing). /media included for
	// <video crossorigin> / future MSE paths. Plain <video src>/<img> never needed CORS.
	if (/^\/(hls|media)\//.test(pathname)) {
		res.headers.set('access-control-allow-origin', '*');
	}
	return res;
};
