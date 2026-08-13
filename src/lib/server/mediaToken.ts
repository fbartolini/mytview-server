/**
 * Signed, short-lived media/image URLs for native players (AVPlayer / ExoPlayer) and AirPlay,
 * which can't cleanly attach `Authorization: Bearer` to byte-range fetches. A signed URL is a
 * capability for exactly one (kind, id) pair until it expires — mirroring the per-video `?s=`
 * share-token pattern (share.ts + hooks.server.ts), but derived from a server secret rather than a
 * stored row, so there's no DB write per URL and no cleanup.
 *
 * The URL is minted only for an ALREADY-authorized request (the /api/v1 list/detail endpoints call
 * it after the visibility check), so it carries that grant for its short TTL — the same trade-off
 * share tokens make. It is NOT a login and grants nothing but that one file.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { stateDb } from './state';
import type { ChannelSummary } from '$lib/types';

// media/thumb are keyed by VIDEO id; poster/fanart by CHANNEL id. The kind is part of the MAC, so a
// thumb URL can't be replayed as a media URL for the same id.
export type MediaKind = 'media' | 'thumb' | 'poster' | 'fanart' | 'hls';

// 12h: comfortably outlasts a viewing session (AVPlayer reuses the same URL for every range request
// + seek), while keeping a copied/lost URL useless within a day. The expiry is WINDOW-ALIGNED (see
// signedPath), so the same (kind,id) yields the SAME URL for every request in a window — stable enough
// for client image caches to actually hit, rather than a new URL per fetch.
const DEFAULT_TTL_S = 12 * 3600;

let _secret: Buffer | null = null;
function secret(): Buffer {
	if (_secret) return _secret;
	const fromEnv = env.MEDIA_URL_SECRET?.trim();
	if (fromEnv) return (_secret = Buffer.from(fromEnv, 'utf8'));
	// Zero-config fallback: a random secret persisted in state.db, stable across restarts.
	const read = () =>
		(stateDb().prepare(`SELECT value FROM app_meta WHERE key = 'media_url_secret'`).get() as
			| { value: string }
			| undefined)?.value;
	let hex = read();
	if (!hex) {
		stateDb()
			.prepare(`INSERT OR IGNORE INTO app_meta (key, value) VALUES ('media_url_secret', ?)`)
			.run(randomBytes(32).toString('hex'));
		hex = read(); // re-read: a concurrent request may have won the INSERT (ours became a no-op)
	}
	return (_secret = Buffer.from(hex as string, 'hex'));
}

function mac(kind: MediaKind, id: string, exp: number, tag = ''): string {
	// `tag` (federation link attribution — fedmeter.ts) is FOLDED INTO the MAC when present, so it
	// can be neither forged onto an untagged URL nor stripped from a tagged one. Absent tag keeps
	// the original MAC shape — every previously-minted URL stays valid.
	const body = tag ? `${kind}:${id}:${exp}:${tag}` : `${kind}:${id}:${exp}`;
	return createHmac('sha256', secret()).update(body).digest('base64url');
}

/** A signed relative URL for a media/image route, e.g. `/thumb/abc?k=…&exp=…`. */
export function signedPath(
	kind: MediaKind,
	id: string,
	opts: { ttlS?: number; tag?: string } = {}
): string {
	const ttl = opts.ttlS ?? DEFAULT_TTL_S;
	// Window-ALIGN the expiry rather than `now + ttl`. A per-request exp changed the signed URL on every
	// call, so the SAME image got a NEW URL on every list refetch. That changes the image model on the
	// client, misses its image cache (the URL is the cache key), and forces a full re-render + re-decode —
	// the Android nav-switch flash, and silently zero image caching on every client. Aligning to a
	// ttl-sized window makes the URL identical for every request in that window while still expiring: it
	// stays valid for between 1 and 2 ttls (+2 windows guarantees ≥1 ttl of validity even at a window's end).
	const now = Math.floor(Date.now() / 1000);
	const exp = (Math.floor(now / ttl) + 2) * ttl;
	const t = opts.tag ? `&t=${encodeURIComponent(opts.tag)}` : '';
	return `/${kind}/${encodeURIComponent(id)}?k=${mac(kind, id, exp, opts.tag ?? '')}&exp=${exp}${t}`;
}

// Window-aligned expiry (see signedPath) — a stable URL within the window.
function windowExp(ttlS: number): number {
	const now = Math.floor(Date.now() / 1000);
	return (Math.floor(now / ttlS) + 2) * ttlS;
}

/** Signed HLS media-playlist URL for a video: `/hls/v/<id>/index.m3u8?k=&exp=` (id = VIDEO id). AVPlayer/
 *  hls.js fetch it with no auth header. Segments carry a SEPARATE signature keyed by the session id — see
 *  `hlsQuery`, used to sign each segment line the playlist emits. */
export function signedHlsIndex(videoId: string, ttlS = DEFAULT_TTL_S, tag?: string): string {
	const exp = windowExp(ttlS);
	const t = tag ? `&t=${encodeURIComponent(tag)}` : '';
	return `/hls/v/${encodeURIComponent(videoId)}/index.m3u8?k=${mac('hls', videoId, exp, tag ?? '')}&exp=${exp}${t}`;
}

/** The signed `k=…&exp=…` query for a session's HLS segment URLs (id = SESSION id). One signature covers
 *  every segment of the session; the session id is the unguessable capability, handed out only by an
 *  already-authorized index.m3u8. */
export function hlsQuery(sid: string, ttlS = DEFAULT_TTL_S): string {
	const exp = windowExp(ttlS);
	return `k=${mac('hls', sid, exp)}&exp=${exp}`;
}

/** Annotate a channel with ready-to-render signed poster/fanart URLs (null when the art is absent).
 *  poster/fanart are keyed by CHANNEL id. Shared by the channels list + channel detail endpoints so
 *  they can't drift on how the art is signed. */
export function signChannelArt<T extends ChannelSummary>(
	c: T
): T & { poster: string | null; fanart: string | null } {
	return {
		...c,
		poster: c.poster_path ? signedPath('poster', c.id) : null,
		fanart: c.fanart_path ? signedPath('fanart', c.id) : null
	};
}

/** Does this request's `?k=&exp=` sign this exact (kind, id) and is it still unexpired? Fail-closed
 *  on any missing/malformed field. Called by the auth hook and by each binary route. */
export function verifyMedia(kind: MediaKind, id: string, url: URL): boolean {
	const k = url.searchParams.get('k');
	const expRaw = url.searchParams.get('exp');
	if (!k || !expRaw) return false;
	const exp = parseInt(expRaw, 10);
	if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
	const a = Buffer.from(k);
	const b = Buffer.from(mac(kind, id, exp, url.searchParams.get('t') ?? ''));
	return a.length === b.length && timingSafeEqual(a, b);
}
