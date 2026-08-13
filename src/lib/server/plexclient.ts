/**
 * Plex HTTP client — plex.tv (account/PIN/resources) + the owner's PMS (library state, watch
 * writes). Verified against the official auth article, the community OpenAPI spec, python-plexapi
 * and Overseerr (2026-08; see docs/plex-sync.md). Facts this module encodes:
 * - The plex.tv/link PIN is the DEFAULT (weak) 4-char pin — never `strong=true` (that's the
 *   app.plex.tv hosted-auth flow's shape).
 * - Every plex.tv call carries a PER-USER X-Plex-Client-Identifier (`<server_id>-u<userId>`) —
 *   tokens/devices are registered per (account, identifier), so users never share one.
 * - PMS view state is per-account, selected by the token; shared accounts use the SERVER-SCOPED
 *   accessToken from /api/v2/resources, matched by the PMS machine id (tokenless /identity).
 * - Writes are plexapi-shaped GETs: /:/scrobble, /:/unscrobble, /:/progress (state=stopped).
 *   /:/progress ignores time<60000ms and time=0 entirely — callers must respect the floor.
 * - JSON everywhere via Accept: application/json; absent numeric attrs mean 0.
 *
 * Transport is injectable (setPlexFetch) — tests replay stubbed plex.tv/PMS responses. Token
 * ACQUISITION stays in plexlink.ts so Plex's in-progress JWT migration lands in one file.
 */

export type PlexErrorKind = 'network' | 'auth' | 'http';

export class PlexError extends Error {
	constructor(
		public kind: PlexErrorKind,
		public status?: number
	) {
		super(`plex ${kind}${status ? ` ${status}` : ''}`);
	}
}

let _fetch: typeof fetch = fetch;
/** Test seam: replace the transport. */
export function setPlexFetch(f: typeof fetch): void {
	_fetch = f;
}

const PLEXTV = 'https://plex.tv';

function headers(clientId: string, token?: string): Record<string, string> {
	return {
		accept: 'application/json',
		'x-plex-product': 'MytView',
		'x-plex-client-identifier': clientId,
		...(token ? { 'x-plex-token': token } : {})
	};
}

async function call(
	url: string,
	init: { method?: string; headers: Record<string, string>; timeoutMs?: number }
): Promise<Response> {
	let res: Response;
	try {
		res = await _fetch(url, {
			method: init.method ?? 'GET',
			headers: init.headers,
			signal: AbortSignal.timeout(init.timeoutMs ?? 15_000)
		});
	} catch {
		throw new PlexError('network');
	}
	if (res.status === 401) throw new PlexError('auth');
	if (!res.ok) throw new PlexError('http', res.status);
	return res;
}

const asJson = async <T>(res: Response): Promise<T> => {
	try {
		return (await res.json()) as T;
	} catch {
		throw new PlexError('http', res.status);
	}
};

// --- plex.tv ------------------------------------------------------------------------------------

export interface PlexPin {
	id: number;
	code: string;
	authToken: string | null;
	expiresAt: string; // ISO
}

/** Mint a 4-char linking PIN (the user enters it at https://plex.tv/link). */
export async function createPin(clientId: string): Promise<PlexPin> {
	return asJson(await call(`${PLEXTV}/api/v2/pins`, { method: 'POST', headers: headers(clientId) }));
}

/** Poll a PIN — `authToken` turns non-null once the user completes plex.tv/link. */
export async function checkPin(clientId: string, pinId: number): Promise<PlexPin> {
	return asJson(await call(`${PLEXTV}/api/v2/pins/${pinId}`, { headers: headers(clientId) }));
}

export interface PlexAccount {
	uuid: string;
	username: string;
	email?: string;
}

/** The linked account's identity — also the cheap token-validity probe (401 → auth). */
export async function plexUser(clientId: string, token: string): Promise<PlexAccount> {
	return asJson(await call(`${PLEXTV}/api/v2/user`, { headers: headers(clientId, token) }));
}

export interface PlexResource {
	clientIdentifier: string; // the server's machine id
	provides: string; // csv, contains "server"
	accessToken: string | null;
	owned: boolean;
	name?: string;
}

/** The account's reachable servers, each with its SERVER-SCOPED access token (for the owner the
 *  account token and access token coincide; for shared users they differ — always use this). */
export async function plexResources(clientId: string, token: string): Promise<PlexResource[]> {
	const list = await asJson<PlexResource[]>(
		await call(`${PLEXTV}/api/v2/resources?includeHttps=1&includeRelay=0`, {
			headers: headers(clientId, token)
		})
	);
	return (Array.isArray(list) ? list : []).filter((r) => r.provides?.includes('server'));
}

// --- PMS ----------------------------------------------------------------------------------------

interface MediaContainer<T> {
	MediaContainer: { size?: number; totalSize?: number; machineIdentifier?: string; Metadata?: T[]; Directory?: T[] };
}

/** Tokenless server identity — machine id (matched against /api/v2/resources) + version. */
export async function pmsIdentity(baseUrl: string): Promise<{ machineIdentifier: string; version?: string }> {
	const j = await asJson<MediaContainer<never> & { MediaContainer: { version?: string } }>(
		await call(`${baseUrl.replace(/\/+$/, '')}/identity`, { headers: { accept: 'application/json' } })
	);
	const mc = j.MediaContainer;
	if (!mc?.machineIdentifier) throw new PlexError('http', 500);
	return { machineIdentifier: mc.machineIdentifier, version: mc.version };
}

function pmsUrl(baseUrl: string, path: string, params: Record<string, string | number>): string {
	const u = new URL(baseUrl.replace(/\/+$/, '') + path);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
	return u.toString();
}

const pmsHeaders = (token: string): Record<string, string> => ({
	accept: 'application/json',
	'x-plex-token': token
});

export interface PlexSection {
	key: string;
	type: string; // 'movie' | 'show' | ...
	title: string;
}

export async function pmsSections(baseUrl: string, token: string): Promise<PlexSection[]> {
	const j = await asJson<MediaContainer<PlexSection>>(
		await call(pmsUrl(baseUrl, '/library/sections', {}), { headers: pmsHeaders(token) })
	);
	return j.MediaContainer?.Directory ?? [];
}

/** One leaf item as the sync consumes it. Absent numeric attrs mean 0 (Plex omits zeroes). */
export interface PlexItem {
	ratingKey: string;
	viewCount?: number;
	viewOffset?: number; // ms
	lastViewedAt?: number; // unix seconds
	// matching pulls only:
	guid?: string; // legacy agent single guid
	Guid?: { id: string }[]; // new-agent tmdb://|tvdb://|imdb:// entries
	grandparentGuid?: string; // episode: the SHOW's guid (legacy matching)
	parentIndex?: number; // season number
	index?: number; // episode number
	Media?: { Part?: { file?: string }[] }[];
}

/** One page of a section's leaves (type 1 = movies, 4 = episodes). `forMatching` adds Guids +
 *  file paths (bigger payload — used by the infrequent matching pull, not the per-cycle state pull). */
export async function pmsSectionItems(
	baseUrl: string,
	token: string,
	sectionKey: string,
	type: 1 | 4,
	start: number,
	size: number,
	forMatching = false
): Promise<{ items: PlexItem[]; totalSize: number }> {
	const params: Record<string, string | number> = {
		type,
		'X-Plex-Container-Start': start,
		'X-Plex-Container-Size': size
	};
	if (forMatching) params.includeGuids = 1;
	const j = await asJson<MediaContainer<PlexItem>>(
		await call(pmsUrl(baseUrl, `/library/sections/${encodeURIComponent(sectionKey)}/all`, params), {
			headers: pmsHeaders(token),
			timeoutMs: 30_000
		})
	);
	const mc = j.MediaContainer;
	return { items: mc?.Metadata ?? [], totalSize: mc?.totalSize ?? mc?.size ?? 0 };
}

/** Read one item back after a push — Plex's timestamp stamping is unpredictable, so the snapshot
 *  records what the server ACTUALLY stored, never what we predicted. */
export async function pmsMetadata(baseUrl: string, token: string, ratingKey: string): Promise<PlexItem | null> {
	const j = await asJson<MediaContainer<PlexItem>>(
		await call(pmsUrl(baseUrl, `/library/metadata/${encodeURIComponent(ratingKey)}`, {}), {
			headers: pmsHeaders(token)
		})
	);
	return j.MediaContainer?.Metadata?.[0] ?? null;
}

const IDENTIFIER = 'com.plexapp.plugins.library';

/** Mark watched for the TOKEN's account. Only call on a 0→1 transition (repeats inflate viewCount). */
export async function pmsScrobble(baseUrl: string, token: string, ratingKey: string): Promise<void> {
	await call(pmsUrl(baseUrl, '/:/scrobble', { key: ratingKey, identifier: IDENTIFIER }), {
		headers: pmsHeaders(token)
	});
}

export async function pmsUnscrobble(baseUrl: string, token: string, ratingKey: string): Promise<void> {
	await call(pmsUrl(baseUrl, '/:/unscrobble', { key: ratingKey, identifier: IDENTIFIER }), {
		headers: pmsHeaders(token)
	});
}

/** Persist a resume offset (ms). PMS ignores time<60000 and time=0 — callers enforce the floor. */
export async function pmsProgress(baseUrl: string, token: string, ratingKey: string, timeMs: number): Promise<void> {
	await call(
		pmsUrl(baseUrl, '/:/progress', { key: ratingKey, identifier: IDENTIFIER, time: Math.round(timeMs), state: 'stopped' }),
		{ headers: pmsHeaders(token) }
	);
}
