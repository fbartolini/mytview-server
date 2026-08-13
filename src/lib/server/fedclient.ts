/**
 * Consumer-side HTTP client for a peer's /api/fed/* surface. Every call is outbound (a NAT'd
 * consumer works), bearer-authed with the link secret, and time-limited. Failures are normalized
 * to FedError{kind} so callers can distinguish unreachable (sync: skip prune) from unauthorized
 * (surface to the owner) from a definitive 404 (revoked). Design: docs/federation-design.md.
 *
 * The transport is injectable (setFedFetch) — the two-server tests replay captured sharer
 * responses through it without any network.
 */
import { fedIdParts, linkByPrefix, type FedLink } from './federation';
import type { FedCatalogChannel, FedCatalogLibrary, FedVideoExport } from './fedserve';

export type FedFailureKind = 'network' | 'auth' | 'http';

export class FedError extends Error {
	constructor(
		public kind: FedFailureKind,
		public status?: number
	) {
		super(`fed ${kind}${status ? ` ${status}` : ''}`);
	}
}

let _fetch: typeof fetch = fetch;
/** Test seam: replace the transport (vi-style stub replaying captured responses). */
export function setFedFetch(f: typeof fetch): void {
	_fetch = f;
}

async function call(
	baseUrl: string,
	path: string,
	opts: { secret?: string; method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<Response> {
	let res: Response;
	try {
		res = await _fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
			method: opts.method ?? 'GET',
			headers: {
				...(opts.secret ? { authorization: `Bearer ${opts.secret}` } : {}),
				...(opts.body != null ? { 'content-type': 'application/json' } : {})
			},
			body: opts.body != null ? JSON.stringify(opts.body) : undefined,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000)
		});
	} catch {
		throw new FedError('network');
	}
	if (res.status === 401) throw new FedError('auth');
	if (!res.ok) throw new FedError('http', res.status);
	return res;
}

const asJson = async <T>(res: Response): Promise<T> => {
	try {
		return (await res.json()) as T;
	} catch {
		throw new FedError('http', res.status);
	}
};

export interface FedCatalog {
	serverId: string;
	libraries: FedCatalogLibrary[];
	channels: FedCatalogChannel[];
}

export interface FedPlaybackUrls {
	url: string;
	hlsUrl: string | null;
	ext: string;
}

const requireBase = (link: FedLink): string => {
	if (!link.base_url) throw new FedError('network'); // consumer link without an address — unusable
	return link.base_url;
};

/** Redeem an invite against the sharer (the one call that is NOT link-authed). */
export async function fedPair(
	baseUrl: string,
	body: { invite: string; serverId: string; name: string; baseUrl?: string }
): Promise<{ serverId: string; secret: string }> {
	return asJson(await call(baseUrl, '/api/fed/pair', { method: 'POST', body }));
}

export async function fedPing(link: FedLink): Promise<{ ok: boolean; serverId: string; serverVersion: string }> {
	return asJson(await call(requireBase(link), '/api/fed/ping', { secret: link.secret }));
}

export async function fedCatalog(link: FedLink): Promise<FedCatalog> {
	return asJson(await call(requireBase(link), '/api/fed/catalog', { secret: link.secret }));
}

export async function fedVideos(link: FedLink, remoteChannelId: string): Promise<{ items: FedVideoExport[] }> {
	return asJson(
		await call(requireBase(link), `/api/fed/videos?channel=${encodeURIComponent(remoteChannelId)}`, {
			secret: link.secret,
			timeoutMs: 60_000 // a big channel's metadata is one response
		})
	);
}

export async function fedUrls(link: FedLink, remoteVideoId: string): Promise<FedPlaybackUrls> {
	return asJson(
		await call(requireBase(link), '/api/fed/urls', {
			secret: link.secret,
			method: 'POST',
			body: { videoId: remoteVideoId }
		})
	);
}

// --- Playback URL resolution (descriptor path) --------------------------------------------------

/** ABSOLUTE playback URLs for a fed-namespaced video id: one /api/fed/urls round-trip per play
 *  start, single-flighted and cached 5 min (the peer's URLs are window-aligned, so a cached copy
 *  is byte-identical anyway — this just saves the round-trip on replay/autoplay). Throws FedError:
 *  'network' = peer unreachable (descriptor → 503), http 404 = revoked (descriptor → 404 + a
 *  background sync to self-heal the mirror). */
const _urlCache = new Map<string, { abs: FedPlaybackUrls; exp: number }>();
const _urlInflight = new Map<string, Promise<FedPlaybackUrls>>();
export async function fedPlaybackUrls(fedVideoId: string): Promise<FedPlaybackUrls> {
	const hit = _urlCache.get(fedVideoId);
	if (hit && hit.exp > Date.now()) return hit.abs;
	let job = _urlInflight.get(fedVideoId);
	if (!job) {
		job = (async () => {
			const parts = fedIdParts(fedVideoId);
			const link = parts ? linkByPrefix(parts.prefix, 'consumer') : null;
			if (!parts || !link) throw new FedError('http', 404);
			const rel = await fedUrls(link, parts.remoteId);
			const base = requireBase(link);
			const abs: FedPlaybackUrls = {
				// rel paths keep `.m3u8` before the `?` — the shape ExoPlayer's MIME sniff needs.
				url: base + rel.url,
				hlsUrl: rel.hlsUrl ? base + rel.hlsUrl : null,
				ext: rel.ext
			};
			_urlCache.set(fedVideoId, { abs, exp: Date.now() + 5 * 60_000 });
			return abs;
		})().finally(() => _urlInflight.delete(fedVideoId));
		_urlInflight.set(fedVideoId, job);
	}
	return job;
}

/** Raw image bytes (null on any failure — the art cache treats a miss as "no art for now"). */
export async function fedArtFetch(
	link: FedLink,
	kind: 'thumb' | 'poster' | 'fanart',
	ref: { video?: string; channel?: string }
): Promise<Uint8Array | null> {
	const q = ref.video
		? `video=${encodeURIComponent(ref.video)}`
		: `channel=${encodeURIComponent(ref.channel ?? '')}`;
	try {
		const res = await call(requireBase(link), `/api/fed/art?kind=${kind}&${q}`, {
			secret: link.secret,
			timeoutMs: 30_000
		});
		return new Uint8Array(await res.arrayBuffer());
	} catch {
		return null;
	}
}
