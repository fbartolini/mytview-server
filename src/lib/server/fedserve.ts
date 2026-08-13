/**
 * Sharer-side federation helpers: link authentication + the grant-filtered catalog exports the
 * /api/fed/* routes serve. Design: docs/federation-design.md §2–§6.
 *
 * Every export here filters `peer_id IS NULL` — a sharer never re-exports content it itself
 * mirrors from someone else (no transitive federation, design §2).
 */
import { json } from '@sveltejs/kit';
import path from 'node:path';
import { db } from './db';
import {
	linkBySecret,
	grantedChannelIds,
	grantedLibraryIds,
	touchLinkSeen,
	type FedLink
} from './federation';
import { listLibraries } from './libraries';

/** The EFFECTIVE grant set for a link: explicit per-channel grants ∪ every LOCAL channel of a
 *  whole-library grant (which therefore covers channels that appear in that library LATER —
 *  the "current and future" semantics of fed_library_grants). */
export function effectiveGrantedChannelIds(linkId: number): Set<string> {
	const granted = grantedChannelIds(linkId);
	const libs = grantedLibraryIds(linkId);
	if (libs.size > 0) {
		const inLibs = db()
			.prepare(
				`SELECT id FROM channels WHERE peer_id IS NULL AND library_id IN (${[...libs].map((n) => Math.trunc(n)).join(',')})`
			)
			.all() as { id: string }[];
		for (const r of inLibs) granted.add(r.id);
	}
	return granted;
}

/** Resolve the calling link from the Bearer secret. Returns a ready 401 JSON Response on failure
 *  (routes: `const link = authLink(request); if (link instanceof Response) return link;`). */
export function authLink(request: Request): FedLink | Response {
	const auth = request.headers.get('authorization');
	const secret = auth?.slice(0, 7).toLowerCase() === 'bearer ' ? auth.slice(7).trim() : '';
	const link = linkBySecret(secret);
	if (!link) return json({ error: 'unauthorized' }, { status: 401 });
	touchLinkSeen(link.id);
	return link;
}

export interface FedCatalogLibrary {
	id: number;
	name: string;
	format: string;
}

export interface FedCatalogChannel {
	id: string;
	library_id: number | null;
	kind: string;
	name: string;
	yt_channel_id: string | null;
	url: string | null;
	follower_count: number | null;
	genres: string | null; // JSON array string, verbatim from the index
	hasPoster: boolean;
	hasFanart: boolean;
	video_count: number;
	max_mtime: number | null;
}

/** The granted channels for a link, with per-channel change-detection stats (COUNT + MAX(mtime)
 *  over LOCAL videos — the consumer skips unchanged channels' video fetch). */
export function catalogChannels(linkId: number): FedCatalogChannel[] {
	const granted = effectiveGrantedChannelIds(linkId);
	if (granted.size === 0) return [];
	const rows = db()
		.prepare(
			`SELECT c.id, c.library_id, c.kind, c.name, c.yt_channel_id, c.url, c.follower_count, c.genres,
			        c.poster_path IS NOT NULL AS hasPoster, c.fanart_path IS NOT NULL AS hasFanart,
			        (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id AND v.peer_id IS NULL) AS video_count,
			        (SELECT MAX(v.mtime) FROM videos v WHERE v.channel_id = c.id AND v.peer_id IS NULL) AS max_mtime
			 FROM channels c WHERE c.peer_id IS NULL ORDER BY c.id`
		)
		.all() as (Omit<FedCatalogChannel, 'hasPoster' | 'hasFanart'> & {
		hasPoster: number;
		hasFanart: number;
	})[];
	return rows
		.filter((r) => granted.has(r.id))
		.map((r) => ({ ...r, hasPoster: !!r.hasPoster, hasFanart: !!r.hasFanart }));
}

/** The libraries the consumer's owner gets to MAP: any containing ≥1 granted channel, plus every
 *  whole-library grant (even while empty — so the consumer can map it before content lands). */
export function sharedLibraries(linkId: number): FedCatalogLibrary[] {
	const libIds = new Set(catalogChannels(linkId).map((c) => c.library_id));
	for (const id of grantedLibraryIds(linkId)) libIds.add(id);
	return listLibraries()
		.filter((l) => libIds.has(l.id))
		.map((l) => ({ id: l.id, name: l.name, format: l.format }));
}

/** Is this (local, non-mirrored) channel granted to the link? Re-checked on every by-id call. */
export function isGranted(linkId: number, channelId: string): boolean {
	const row = db()
		.prepare('SELECT peer_id FROM channels WHERE id = ?')
		.get(channelId) as { peer_id: string | null } | undefined;
	if (!row || row.peer_id != null) return false;
	return effectiveGrantedChannelIds(linkId).has(channelId);
}

export interface FedVideoExport {
	id: string;
	/** File EXTENSION only (`.mkv`…), never the path — keeps the consumer's `%.mkv` compat
	 *  predicates working while the sharer's directory layout stays private (design §5). */
	ext: string;
	hasThumb: boolean;
	hasPoster: boolean;
	title: string;
	description: string | null;
	upload_date: string | null;
	timestamp: number | null;
	duration: number | null;
	view_count: number | null;
	like_count: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	vcodec: string | null;
	acodec: string | null;
	tags: string | null; // JSON array string
	chapters: string | null; // JSON string
	webpage_url: string | null;
	season_number: number | null;
	episode_number: number | null;
	year: number | null;
	mtime: number;
}

/** Full metadata export for one granted channel's videos (grant checked by the route). */
export function exportVideos(channelId: string): FedVideoExport[] {
	const rows = db()
		.prepare(
			`SELECT id, video_path, thumb_path IS NOT NULL AS hasThumb, poster_path IS NOT NULL AS hasPoster,
			        title, description, upload_date, timestamp, duration, view_count, like_count,
			        width, height, fps, vcodec, acodec, tags, chapters, webpage_url,
			        season_number, episode_number, year, mtime
			 FROM videos WHERE channel_id = ? AND peer_id IS NULL ORDER BY id`
		)
		.all(channelId) as (Omit<FedVideoExport, 'ext' | 'hasThumb' | 'hasPoster'> & {
		video_path: string;
		hasThumb: number;
		hasPoster: number;
	})[];
	return rows.map(({ video_path, hasThumb, hasPoster, ...rest }) => ({
		...rest,
		ext: path.extname(video_path),
		hasThumb: !!hasThumb,
		hasPoster: !!hasPoster
	}));
}
