/**
 * Consumer-side federated artwork: fetched ONCE from the peer (link-authed /api/fed/art), cached
 * on disk, served same-origin by the normal /thumb|/poster|/fanart routes. Proxying art (never
 * media) keeps client image flows + OG previews + signed art URLs unchanged and CORS-free, and
 * dodges the peer's signed-URL expiry churning every client image cache. Design §8.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { FED_ART_DIR } from './config';
import { linkByPrefix, fedIdParts } from './federation';
import { fedArtFetch } from './fedclient';

type ArtKind = 'thumb' | 'poster' | 'fanart';

/** One cache entry per (peer, kind, remote ref) — refreshed only when the remote id/flag changes
 *  (staleness is a documented deferral, design §12). */
const cachePath = (prefix: string, kind: ArtKind, ref: string): string =>
	path.join(FED_ART_DIR, createHash('sha1').update(`${prefix}|${kind}|${ref}`).digest('hex') + '.img');

// In-flight dedupe: a cold grid requests the same poster many times at once — fetch it once.
const inflight = new Map<string, Promise<boolean>>();

async function ensureCached(
	prefix: string,
	kind: ArtKind,
	ref: { video?: string; channel?: string }
): Promise<string | null> {
	const key = cachePath(prefix, kind, ref.video ?? ref.channel ?? '');
	try {
		await stat(key);
		return key; // hit
	} catch {
		/* miss → fetch */
	}
	let job = inflight.get(key);
	if (!job) {
		job = (async () => {
			const link = linkByPrefix(prefix, 'consumer');
			if (!link) return false;
			const bytes = await fedArtFetch(link, kind, ref);
			if (!bytes || bytes.length === 0) return false;
			await mkdir(FED_ART_DIR, { recursive: true });
			const tmp = `${key}.${process.pid}.${Math.trunc(Math.random() * 1e9)}.tmp`;
			await writeFile(tmp, bytes);
			await rename(tmp, key); // atomic publish (⇔ imagecache.ts)
			return true;
		})().finally(() => inflight.delete(key));
		inflight.set(key, job);
	}
	return (await job) ? key : null;
}

/** Cached art file for a FED-NAMESPACED video id (thumb or per-movie poster). Null = no art. */
export async function fedVideoArt(
	fedVideoId: string,
	kind: 'thumb' | 'poster'
): Promise<{ absPath: string; stat: Stats } | null> {
	const parts = fedIdParts(fedVideoId);
	if (!parts) return null;
	const p = await ensureCached(parts.prefix, kind, { video: parts.remoteId });
	return p ? { absPath: p, stat: await stat(p) } : null;
}

/** Cached art for a FED-NAMESPACED channel id (poster or fanart). Null = no art. (The merged
 *  movies channel deliberately has no channel art — design: the wall renders per-film posters.) */
export async function fedChannelArt(
	fedChannelId: string,
	kind: 'poster' | 'fanart'
): Promise<{ absPath: string; stat: Stats } | null> {
	const parts = fedIdParts(fedChannelId);
	if (!parts) return null;
	const p = await ensureCached(parts.prefix, kind, { channel: parts.remoteId });
	return p ? { absPath: p, stat: await stat(p) } : null;
}
