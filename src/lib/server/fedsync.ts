/**
 * Consumer sync engine: pull each peer's granted catalog and mirror it into the index tables as
 * peer-marked rows (`peer_id` = the link's namespace prefix), grouped under the owner's mapped
 * libraries. Every existing read (feed/search/tags/related/grids/visibility/watch) then includes
 * federated content with zero query changes. Design: docs/federation-design.md §11.
 *
 * Ownership split with the scanner: the scan owns `peer_id IS NULL` rows and never touches ours;
 * we prune ONLY rows of the synced link's prefix, and ONLY after a clean catalog response — a
 * network failure/5xx/auth error never prunes (unreachable ≠ revoked; the fed analogue of the
 * scanner's unmounted-NAS safety valve).
 */
import { db } from './db';
import { appMetaGet, appMetaSet } from './state';
import { noteExternalIndexChange } from './indexer';
import {
	listLinks,
	getLink,
	listLibraryMaps,
	touchLinkSeen,
	setLinkSyncError,
	cacheRemoteLibraries,
	fedId,
	fedIdParts,
	type FedLink
} from './federation';
import { fedCatalog, fedVideos, FedError } from './fedclient';
import type { FedCatalogChannel, FedVideoExport } from './fedserve';
import { getLibrary, type LibraryConfig } from './libraries';
import { applyNewChannelDefault } from './visibility';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// 429 backoff before the one retry; near-instant under vitest so tests don't stall on it.
const RETRY_429_MS = process.env.VITEST ? 25 : 5000;

// --- Untrusted-catalog sanitization (design §3): type-check + length-cap every field; a hostile
// or corrupted sharer drops rows, never crashes the sync or smuggles oversized blobs in.
const str = (v: unknown, max: number): string | null =>
	typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const jsonArrayStr = (v: unknown, maxItems: number, maxItem: number): string | null => {
	if (typeof v !== 'string' || v.length === 0) return null;
	try {
		const parsed: unknown = JSON.parse(v);
		if (!Array.isArray(parsed)) return null;
		const clean = parsed
			.filter((t): t is string => typeof t === 'string' && t.length <= maxItem)
			.slice(0, maxItems);
		return JSON.stringify(clean);
	} catch {
		return null;
	}
};

interface CleanChannel {
	id: string;
	library_id: number;
	kind: 'channel' | 'series' | 'movies';
	name: string;
	yt_channel_id: string | null;
	url: string | null;
	follower_count: number | null;
	genres: string | null;
	hasPoster: boolean;
	hasFanart: boolean;
	video_count: number;
	max_mtime: number | null;
}

function sanitizeChannel(raw: FedCatalogChannel): CleanChannel | null {
	const id = str(raw.id, 256);
	const name = str(raw.name, 256);
	const library_id = num(raw.library_id);
	const kind = raw.kind === 'series' || raw.kind === 'movies' ? raw.kind : 'channel';
	if (!id || !name || library_id == null) return null;
	return {
		id,
		library_id,
		kind,
		name,
		yt_channel_id: str(raw.yt_channel_id, 128),
		url: str(raw.url, 512),
		follower_count: num(raw.follower_count),
		genres: jsonArrayStr(raw.genres, 50, 64),
		hasPoster: !!raw.hasPoster,
		hasFanart: !!raw.hasFanart,
		video_count: num(raw.video_count) ?? 0,
		max_mtime: num(raw.max_mtime)
	};
}

interface CleanVideo {
	id: string;
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
	tags: string | null;
	chapters: string | null;
	webpage_url: string | null;
	season_number: number | null;
	episode_number: number | null;
	year: number | null;
	mtime: number;
}

function sanitizeVideo(raw: FedVideoExport): CleanVideo | null {
	const id = str(raw.id, 256);
	const title = str(raw.title, 512);
	if (!id || !title) return null;
	const ext = typeof raw.ext === 'string' && /^\.[A-Za-z0-9]{1,8}$/.test(raw.ext) ? raw.ext : '';
	return {
		id,
		ext,
		hasThumb: !!raw.hasThumb,
		hasPoster: !!raw.hasPoster,
		title,
		description: str(raw.description, 8192),
		upload_date: str(raw.upload_date, 16),
		timestamp: num(raw.timestamp),
		duration: num(raw.duration),
		view_count: num(raw.view_count),
		like_count: num(raw.like_count),
		width: num(raw.width),
		height: num(raw.height),
		fps: num(raw.fps),
		vcodec: str(raw.vcodec, 64),
		acodec: str(raw.acodec, 64),
		tags: jsonArrayStr(raw.tags, 100, 64),
		chapters: typeof raw.chapters === 'string' && raw.chapters.length <= 65536 ? raw.chapters : null,
		webpage_url: str(raw.webpage_url, 512),
		season_number: num(raw.season_number),
		episode_number: num(raw.episode_number),
		year: num(raw.year),
		mtime: num(raw.mtime) ?? 0
	};
}

/** Cap on sanitized items accepted per channel — the pagination deferral trigger (design §12). */
const MAX_ITEMS_PER_CHANNEL = 20_000;

export interface FedSyncStats {
	links: number;
	channels: number;
	videos: number;
	upserted: number;
	pruned: number;
	errors: number;
}

let _syncing = false;
let _last: FedSyncStats | null = null;
/** Per-(link, remote channel) change-skip fingerprints ({video_count}:{max_mtime}) — in-memory,
 *  so a restart just refetches once. Deliberately NOT derived from local mirrored counts: dedupe
 *  skips locally-present videos, so local counts no longer equal the remote's. */
const _fingerprints = new Map<string, string>();

export function fedSyncStatus(): { syncing: boolean; last: FedSyncStats | null } {
	return { syncing: _syncing, last: _last };
}

/** Auto-sync cadence in minutes — an OWNER SETTING (/admin/federation, app_meta 'fed_sync_min'),
 *  not an env var. 0 = manual only; clamped to ≥5 on write (a typo'd 1 would hammer someone
 *  else's home server). Default 30. */
export function fedSyncMinutes(): number {
	const n = parseInt(appMetaGet('fed_sync_min') ?? '30', 10);
	if (!Number.isFinite(n) || n < 0) return 30;
	return n === 0 ? 0 : Math.max(n, 5);
}
export function setFedSyncMinutes(n: number): void {
	const v = !Number.isFinite(n) || n <= 0 ? 0 : Math.max(Math.trunc(n), 5);
	appMetaSet('fed_sync_min', String(v));
}

/** Minute-tick driver (hooks init): syncs when the setting's interval has elapsed — so cadence
 *  changes apply immediately, no restart. First call after boot syncs at once (convergence). */
let _lastAuto = 0;
export async function maybeAutoFedSync(): Promise<void> {
	const minutes = fedSyncMinutes();
	if (minutes === 0) return;
	if (Date.now() - _lastAuto < minutes * 60_000) return;
	_lastAuto = Date.now();
	await runFedSync();
}

/** Coalesce a burst of sync requests (mapping several libraries back-to-back each wants a sync)
 *  into ONE run shortly after the last call — instead of five syncs hammering the peer's catalog
 *  endpoint in as many seconds. */
const _scheduled = new Map<number, ReturnType<typeof setTimeout>>();
export function scheduleFedSync(linkId: number, delayMs = 2000): void {
	clearTimeout(_scheduled.get(linkId));
	_scheduled.set(
		linkId,
		setTimeout(() => {
			_scheduled.delete(linkId);
			void runFedSync(linkId);
		}, delayMs)
	);
}

/** Sync one link (by id) or every consumer link. Returns null when a sync is already running
 *  (admin "Sync now" during the timer — just report busy; the next tick covers it). */
export async function runFedSync(linkId?: number): Promise<FedSyncStats | null> {
	if (_syncing) return null;
	_syncing = true;
	const stats: FedSyncStats = { links: 0, channels: 0, videos: 0, upserted: 0, pruned: 0, errors: 0 };
	try {
		const links = (linkId != null ? [getLink(linkId)] : listLinks('consumer')).filter(
			(l): l is FedLink => !!l && l.role === 'consumer'
		);
		for (const link of links) {
			stats.links++;
			try {
				const changed = await syncLink(link, stats);
				if (changed) noteExternalIndexChange();
			} catch (e) {
				stats.errors++;
				// Unreachable/refused ≠ revoked: record, keep every mirrored row (design §10).
				const msg =
					e instanceof FedError
						? e.kind === 'auth'
							? 'unauthorized — link revoked by the peer?'
							: e.kind === 'network'
								? 'peer unreachable'
								: `peer error (HTTP ${e.status})`
						: e instanceof Error
							? e.message
							: String(e);
				setLinkSyncError(link.id, msg);
				console.error(`[mytview] fedsync: ${link.peer_name}: ${msg}`);
			}
			await tick();
		}
	} finally {
		_syncing = false;
	}
	_last = stats;
	return stats;
}

async function syncLink(link: FedLink, stats: FedSyncStats): Promise<boolean> {
	const database = db();
	const catalog = await fedCatalog(link);
	if (catalog.serverId !== link.peer_server_id) {
		throw new Error('peer identity changed — re-pair to continue');
	}
	cacheRemoteLibraries(link.id, JSON.stringify(catalog.libraries ?? []));

	const prefix = link.peer_prefix;
	const maps = new Map<number, LibraryConfig>();
	for (const m of listLibraryMaps(link.id)) {
		const lib = getLibrary(m.local_library_id);
		if (lib) maps.set(m.remote_library_id, lib);
	}

	const channels = (Array.isArray(catalog.channels) ? catalog.channels : [])
		.map(sanitizeChannel)
		.filter((c): c is CleanChannel => !!c);

	const expectedChannels = new Set<string>();
	const expectedVideos = new Set<string>();
	let wrote = 0;
	let fetchFailures = 0;

	const upsertChannel = database.prepare(
		`INSERT INTO channels (id, name, kind, library_id, peer_id, yt_channel_id, url, follower_count, poster_path, fanart_path, genres)
		 VALUES (@id, @name, @kind, @lib, @peer, @yt, @url, @fc, @poster, @fanart, @genres)
		 ON CONFLICT(id) DO UPDATE SET
		   name=excluded.name, kind=excluded.kind, library_id=excluded.library_id, peer_id=excluded.peer_id,
		   yt_channel_id=excluded.yt_channel_id, url=excluded.url, follower_count=excluded.follower_count,
		   poster_path=excluded.poster_path, fanart_path=excluded.fanart_path, genres=excluded.genres`
	);
	// The MERGED movies channel: created only if absent (a scan-owned local movies channel must
	// never be clobbered), then updated only while WE own it (peer_id set ⇒ virtual-backed).
	const ensureMoviesChannel = database.prepare(
		`INSERT OR IGNORE INTO channels (id, name, kind, library_id, peer_id, genres) VALUES (@id, @name, 'movies', @lib, @peer, @genres)`
	);
	const touchMoviesGenres = database.prepare(
		// Merge remote genres into a peer-owned merged channel (display aggregate only; local rows win otherwise).
		'UPDATE channels SET genres = @genres WHERE id = @id AND peer_id IS NOT NULL'
	);
	const wasSeen = database.prepare('SELECT 1 FROM state.channels_seen WHERE channel_id = ?');
	const markSeen = database.prepare(
		'INSERT OR IGNORE INTO state.channels_seen (channel_id, first_seen_at) VALUES (?, ?)'
	);
	const currentIds = database.prepare('SELECT id FROM videos WHERE peer_id = ? AND channel_id = ?');
	// DEDUPE (design §7): a remote video whose RAW id already exists as a LOCAL video is the same
	// content (yt/tvdb/tmdb-keyed ids are content identities) — the local copy WINS (it direct-plays
	// with no network hop) and the remote one is skipped everywhere.
	const localVideoExists = database.prepare('SELECT 1 FROM videos WHERE id = ? AND peer_id IS NULL');
	const localTwinChannel = database.prepare(
		'SELECT 1 FROM channels WHERE id = ? AND peer_id IS NULL AND library_id = ? AND kind = ?'
	);
	const upsertVideo = database.prepare(
		`INSERT INTO videos (id, channel_id, peer_id, season_number, episode_number, year, poster_path, title, description,
		                     upload_date, timestamp, duration, view_count, like_count, width, height, fps, vcodec, acodec,
		                     tags, chapters, webpage_url, video_path, thumb_path, info_path, mtime)
		 VALUES (@id, @channel_id, @peer_id, @season_number, @episode_number, @year, @poster_path, @title, @description,
		         @upload_date, @timestamp, @duration, @view_count, @like_count, @width, @height, @fps, @vcodec, @acodec,
		         @tags, @chapters, @webpage_url, @video_path, @thumb_path, @info_path, @mtime)
		 ON CONFLICT(id) DO UPDATE SET
		   channel_id=excluded.channel_id, peer_id=excluded.peer_id, season_number=excluded.season_number,
		   episode_number=excluded.episode_number, year=excluded.year, poster_path=excluded.poster_path,
		   title=excluded.title, description=excluded.description, upload_date=excluded.upload_date,
		   timestamp=excluded.timestamp, duration=excluded.duration, view_count=excluded.view_count,
		   like_count=excluded.like_count, width=excluded.width, height=excluded.height, fps=excluded.fps,
		   vcodec=excluded.vcodec, acodec=excluded.acodec, tags=excluded.tags, chapters=excluded.chapters,
		   webpage_url=excluded.webpage_url, video_path=excluded.video_path, thumb_path=excluded.thumb_path,
		   info_path=excluded.info_path, mtime=excluded.mtime`
	);
	const delTags = database.prepare('DELETE FROM video_tags WHERE video_id = ?');
	const insTag = database.prepare('INSERT INTO video_tags (video_id, tag) VALUES (?, ?)');

	for (const c of channels) {
		const lib = maps.get(c.library_id);
		if (!lib) continue; // unmapped remote library — surfaced in the admin UI, nothing mirrored
		stats.channels++;
		const isMoviesMerge = c.kind === 'movies' && lib.format === 'movies';
		// DEDUPE, channel level (design §7): a LOCAL channel with the SAME id + kind in the target
		// library is the same source (same folder / same show) — merge the remote's videos INTO it
		// instead of creating a duplicate tile. Local-vs-remote episode overlap is handled by the
		// per-video raw-id skip below (local wins; the remote fills gaps).
		const isTwinMerge = !isMoviesMerge && !!localTwinChannel.get(c.id, lib.id, c.kind);
		const localChannelId = isMoviesMerge ? `movies:${lib.id}` : isTwinMerge ? c.id : fedId(prefix, c.id);
		expectedChannels.add(localChannelId);

		// Channel row FIRST (the indexer's FK-order rule). A twin merge creates nothing — the
		// scan-owned local channel already exists and keeps its visibility/metadata.
		if (isMoviesMerge) {
			ensureMoviesChannel.run({ id: localChannelId, name: lib.name, lib: lib.id, peer: prefix, genres: c.genres });
			touchMoviesGenres.run({ id: localChannelId, genres: c.genres });
		} else if (!isTwinMerge) {
			upsertChannel.run({
				id: localChannelId,
				name: c.name,
				kind: c.kind,
				lib: lib.id,
				peer: prefix,
				yt: c.yt_channel_id,
				url: c.url,
				fc: c.follower_count,
				poster: c.hasPoster ? 'fed:poster' : null,
				fanart: c.hasFanart ? 'fed:fanart' : null,
				genres: c.genres
			});
		}
		if (!isTwinMerge && !wasSeen.get(localChannelId)) {
			markSeen.run(localChannelId, Date.now());
			// Visibility default follows the MAPPED library (⇔ the indexer's new-channel rule); the
			// owner adjusts per channel at /admin/visibility afterwards — fed channels are just channels.
			applyNewChannelDefault(localChannelId, lib.newPrivate);
		}

		// Change-skip on the REMOTE fingerprint (keyed to the mapping target too, so a remap
		// refetches). The skip additionally requires mirrored rows to actually exist — a purge/
		// unmap must refetch even though the remote didn't change — and refuses when a mirrored id
		// now collides with a newly-arrived local raw id (the refetch then drops the duplicate).
		// A fully-deduped twin (0 mirrored, remote non-empty) deliberately refetches every sync:
		// correctness over the saved metadata fetch.
		const fpKey = `${link.id}:${c.id}:${localChannelId}`;
		const fp = `${c.video_count}:${c.max_mtime ?? ''}`;
		if (_fingerprints.get(fpKey) === fp) {
			const current = currentIds.all(prefix, localChannelId) as { id: string }[];
			const collided = current.some((r) => {
				const parts = fedIdParts(r.id);
				return !!parts && !!localVideoExists.get(parts.remoteId);
			});
			if (!collided && (current.length > 0 || c.video_count === 0)) {
				for (const r of current) expectedVideos.add(r.id);
				stats.videos += current.length;
				continue;
			}
		}

		// Per-channel fetch with 429 resilience: a rate-limited call backs off once and retries; a
		// channel that STILL fails (or 5xx's) keeps its current mirror + is reported as a partial
		// sync, while the rest of the catalog continues — one throttled endpoint must not abort (or
		// worse, prune) an otherwise-healthy sync. Network/auth failures still abort the whole link
		// (unreachable ≠ revoked, design §10).
		let items: FedVideoExport[];
		try {
			items = await (async () => {
				try {
					return (await fedVideos(link, c.id)).items;
				} catch (e) {
					if (e instanceof FedError && e.kind === 'http' && e.status === 429) {
						await sleep(RETRY_429_MS);
						return (await fedVideos(link, c.id)).items;
					}
					throw e;
				}
			})();
		} catch (e) {
			if (e instanceof FedError && e.kind === 'http') {
				fetchFailures++;
				for (const r of currentIds.all(prefix, localChannelId) as { id: string }[]) {
					expectedVideos.add(r.id); // preserve the current mirror — prune stays safe
				}
				continue;
			}
			throw e;
		}
		const clean = (Array.isArray(items) ? items : [])
			.map(sanitizeVideo)
			.filter((v): v is CleanVideo => !!v)
			.slice(0, MAX_ITEMS_PER_CHANNEL);
		if (Array.isArray(items) && items.length > clean.length) {
			console.warn(
				`[mytview] fedsync: ${link.peer_name}/${c.name}: accepted ${clean.length} of ${items.length} items (sanitized/capped)`
			);
		}
		// Chunked transactions + event-loop yields (the async-indexer rule — sync writes, small batches).
		const CHUNK = 50;
		const writeChunk = database.transaction((rows: CleanVideo[]) => {
			for (const v of rows) {
				if (localVideoExists.get(v.id)) continue; // dedupe: the local copy wins (design §7)
				const vid = fedId(prefix, v.id);
				upsertVideo.run({
					id: vid,
					channel_id: localChannelId,
					peer_id: prefix,
					season_number: v.season_number,
					episode_number: v.episode_number,
					year: v.year,
					poster_path: v.hasPoster ? 'fed:poster' : null,
					title: v.title,
					description: v.description,
					upload_date: v.upload_date,
					timestamp: v.timestamp,
					duration: v.duration,
					view_count: v.view_count,
					like_count: v.like_count,
					width: v.width,
					height: v.height,
					fps: v.fps,
					vcodec: v.vcodec,
					acodec: v.acodec,
					tags: v.tags,
					chapters: v.chapters,
					webpage_url: v.webpage_url,
					// Sentinels: extension preserved so the `%.mkv` compat predicates keep working;
					// 'fed:'-prefixed so the binary routes can never resolve them under MEDIA_ROOT.
					video_path: `fed:${v.id}${v.ext}`,
					thumb_path: v.hasThumb ? 'fed:thumb' : null,
					info_path: 'fed:',
					mtime: v.mtime
				});
				delTags.run(vid);
				if (v.tags) {
					for (const t of JSON.parse(v.tags) as string[]) insTag.run(vid, t);
				}
				expectedVideos.add(vid);
			}
		});
		for (let i = 0; i < clean.length; i += CHUNK) {
			writeChunk(clean.slice(i, i + CHUNK));
			wrote += Math.min(CHUNK, clean.length - i);
			await tick();
		}
		stats.videos += clean.length;
		_fingerprints.set(fpKey, fp);
	}

	// Per-link prune — reached ONLY on a clean catalog (any FedError above threw before this point).
	const PRUNE_CHUNK = 200;
	const deadVideos = (database.prepare('SELECT id FROM videos WHERE peer_id = ?').all(prefix) as { id: string }[])
		.map((r) => r.id)
		.filter((id) => !expectedVideos.has(id));
	const deadChannels = (
		database.prepare('SELECT id FROM channels WHERE peer_id = ?').all(prefix) as { id: string }[]
	)
		.map((r) => r.id)
		.filter((id) => !expectedChannels.has(id));
	const delVideo = database.prepare('DELETE FROM videos WHERE id = ?');
	const delVideoChunk = database.transaction((ids: string[]) => ids.forEach((id) => delVideo.run(id)));
	for (let i = 0; i < deadVideos.length; i += PRUNE_CHUNK) {
		delVideoChunk(deadVideos.slice(i, i + PRUNE_CHUNK));
		await tick();
	}
	// Dead channels: a namespaced channel just goes; a MERGED movies channel (peer-marked
	// `movies:<libId>`) is deleted only when no fed videos remain — if another link still merges
	// into it, ownership is reassigned to that link's prefix instead (design §7).
	for (const cid of deadChannels) {
		const other = database
			.prepare('SELECT DISTINCT peer_id FROM videos WHERE channel_id = ? AND peer_id IS NOT NULL LIMIT 1')
			.get(cid) as { peer_id: string } | undefined;
		if (other) database.prepare('UPDATE channels SET peer_id = ? WHERE id = ?').run(other.peer_id, cid);
		else database.prepare('DELETE FROM channels WHERE id = ?').run(cid);
	}
	// video_count refresh for everything this link touches (merged movies channels count local+fed).
	database
		.prepare(
			`UPDATE channels SET video_count = (SELECT COUNT(*) FROM videos WHERE videos.channel_id = channels.id)
			 WHERE peer_id = ? OR id IN (SELECT DISTINCT channel_id FROM videos WHERE peer_id = ?)`
		)
		.run(prefix, prefix);

	stats.upserted += wrote;
	stats.pruned += deadVideos.length;
	touchLinkSeen(link.id);
	setLinkSyncError(
		link.id,
		fetchFailures > 0
			? `partial sync — ${fetchFailures} channel(s) throttled by the peer; retrying next sync`
			: null
	);
	if (wrote > 0 || deadVideos.length > 0 || deadChannels.length > 0) {
		console.log(
			`[mytview] fedsync: ${link.peer_name} — ${stats.videos} videos across ${expectedChannels.size} channels (${wrote} upserted, ${deadVideos.length} pruned)`
		);
		return true;
	}
	return false;
}

/** Purge every mirrored row of a link (unlink / unmap teardown). watch_state rows are KEPT —
 *  re-pairing the same peer regenerates identical ids, so resume/watched survive (design §7). */
export function purgeLinkRows(prefix: string, onlyLibraryId?: number): void {
	const database = db();
	const libClause = onlyLibraryId != null ? ' AND library_id = ' + Math.trunc(onlyLibraryId) : '';
	const chans = database
		.prepare(`SELECT id, kind FROM channels WHERE peer_id = ?${libClause}`)
		.all(prefix) as { id: string; kind: string }[];
	const delVideosOf = database.prepare('DELETE FROM videos WHERE peer_id = ? AND channel_id = ?');
	const delChannel = database.prepare('DELETE FROM channels WHERE id = ?');
	const reassignOrDrop = (cid: string): void => {
		const other = database
			.prepare('SELECT DISTINCT peer_id FROM videos WHERE channel_id = ? AND peer_id IS NOT NULL LIMIT 1')
			.get(cid) as { peer_id: string } | undefined;
		if (other) database.prepare('UPDATE channels SET peer_id = ? WHERE id = ?').run(other.peer_id, cid);
		else delChannel.run(cid);
	};
	database.transaction(() => {
		for (const c of chans) {
			delVideosOf.run(prefix, c.id);
			reassignOrDrop(c.id);
		}
		// Merged movies videos live under a LOCAL (scan-owned) channel id when the target library is
		// real — those rows carry our prefix but a peer_id-NULL channel; sweep them too.
		const strays = database
			.prepare(`SELECT DISTINCT channel_id AS id FROM videos WHERE peer_id = ?${onlyLibraryId != null ? ' AND channel_id IN (SELECT id FROM channels WHERE library_id = ' + Math.trunc(onlyLibraryId) + ')' : ''}`)
			.all(prefix) as { id: string }[];
		for (const s of strays) delVideosOf.run(prefix, s.id);
		database
			.prepare(
				'UPDATE channels SET video_count = (SELECT COUNT(*) FROM videos WHERE videos.channel_id = channels.id) ' +
					'WHERE id IN (SELECT id FROM channels)'
			)
			.run();
	})();
	noteExternalIndexChange();
}
