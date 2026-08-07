/**
 * Read-only indexer.
 *
 * Walks each configured library under MEDIA_ROOT and upserts the result into SQLite. Two library
 * formats, dispatched by `resolveLibraries()`:
 *   - channels: every `.info.json` with a sibling media file (ytdl-sub style) → channels of videos.
 *   - series:   every media file with a sibling Kodi/Emby `.nfo` (or a bare `SxxExx` filename), plus
 *               local poster/fanart/`-thumb.jpg` images (*arr style) → series of season/episode rows.
 * Series reuse the `channels`/`videos` tables: a series is a channel (`kind='series'`), an episode is
 * a video carrying `season_number`/`episode_number`.
 *
 * Incremental (unchanged sidecar mtime → skipped) and prunes rows whose files vanished. Nothing here
 * mutates the library. The walk is **async + batched**: it commits in small transactions and yields to
 * the event loop between batches, so a scan never freezes the server.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { MEDIA_ROOT } from './config';
import { db } from './db';
import { resolveLibraries, type Library } from './libraries';
import { gcShares } from './share';
import { applyNewChannelDefault } from './visibility';

const MEDIA_EXTS = ['.mp4', '.mkv', '.webm', '.m4v'];
const THUMB_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const POSTER_NAMES = ['poster.jpg', 'poster.png', 'poster.webp'];
const FANART_NAMES = ['fanart.jpg', 'fanart.png', 'fanart.webp', 'banner.jpg'];
const INFO_SUFFIX = '.info.json';
const NFO_SUFFIX = '.nfo';
const BATCH = 25; // files processed between event-loop yields

const rel = (p: string): string => path.relative(MEDIA_ROOT, p);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function firstExisting(dir: string, names: string[]): string | null {
	for (const name of names) {
		const candidate = path.join(dir, name);
		if (isFile(candidate)) return candidate;
	}
	return null;
}

/**
 * Locate a video's thumbnail, tolerating the naming variations different sources
 * produce. Case-insensitive, in priority order:
 * `<base>.<img>`, `<mediafile>.<img>` (Title.mp4.jpg), `<base>…​.<img>` (Title-thumb.jpg),
 * else the lone image in the dir.
 */
function findThumb(parent: string, base: string, mediaName: string): string | null {
	let entries: string[];
	try {
		entries = fs.readdirSync(parent);
	} catch {
		return null;
	}
	const images = entries.filter((n) => THUMB_EXTS.includes(path.extname(n).toLowerCase()));
	if (images.length === 0) return null;
	const stem = (n: string) => n.slice(0, n.length - path.extname(n).length).toLowerCase();
	const baseL = base.toLowerCase();
	const mediaL = mediaName.toLowerCase();
	const pick =
		images.find((n) => stem(n) === baseL) ??
		images.find((n) => stem(n) === mediaL) ??
		images.find((n) => stem(n).startsWith(baseL)) ??
		(images.length === 1 ? images[0] : undefined);
	return pick ? path.join(parent, pick) : null;
}

function toTimestamp(info: Record<string, unknown>): number | null {
	const ts = info.timestamp;
	if (typeof ts === 'number' && Number.isFinite(ts)) return Math.trunc(ts);
	const ud = info.upload_date;
	if (typeof ud === 'string' && /^\d{8}$/.test(ud)) {
		const y = +ud.slice(0, 4);
		const mo = +ud.slice(4, 6);
		const d = +ud.slice(6, 8);
		return Math.trunc(Date.UTC(y, mo - 1, d) / 1000);
	}
	return null;
}

const asInt = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

type Row = Record<string, string | number | null>;

function buildVideoRow(
	info: Record<string, unknown>,
	id: string,
	channelId: string,
	media: string,
	thumb: string | null,
	infoPath: string,
	mtime: number
): Row {
	return {
		id,
		channel_id: channelId,
		season_number: null,
		episode_number: null,
		title: asStr(info.title) ?? asStr(info.fulltitle) ?? path.parse(media).name,
		description: asStr(info.description),
		upload_date: asStr(info.upload_date),
		timestamp: toTimestamp(info),
		duration: asInt(info.duration),
		view_count: asInt(info.view_count),
		like_count: asInt(info.like_count),
		width: asInt(info.width),
		height: asInt(info.height),
		fps: typeof info.fps === 'number' && Number.isFinite(info.fps) ? info.fps : null,
		vcodec: asStr(info.vcodec),
		acodec: asStr(info.acodec),
		tags: JSON.stringify(Array.isArray(info.tags) ? info.tags : []),
		chapters: JSON.stringify(Array.isArray(info.chapters) ? info.chapters : []),
		webpage_url: asStr(info.webpage_url),
		video_path: rel(media),
		thumb_path: thumb ? rel(thumb) : null,
		info_path: rel(infoPath),
		mtime
	};
}

const VIDEO_COLUMNS = [
	'id', 'channel_id', 'season_number', 'episode_number', 'title', 'description',
	'upload_date', 'timestamp', 'duration', 'view_count', 'like_count', 'width',
	'height', 'fps', 'vcodec', 'acodec', 'tags', 'chapters', 'webpage_url',
	'video_path', 'thumb_path', 'info_path', 'mtime'
];

/** Recursively yield every *.info.json path under a dir, dirs & files sorted. */
function* walkInfo(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
	const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
	for (const f of files) if (f.endsWith(INFO_SUFFIX)) yield path.join(dir, f);
	for (const d of dirs) yield* walkInfo(path.join(dir, d));
}

/** Recursively yield every media file under a dir (series episodes), dirs & files sorted. */
function* walkMedia(dir: string): Generator<string> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
	const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
	for (const f of files) if (MEDIA_EXTS.includes(path.extname(f).toLowerCase())) yield path.join(dir, f);
	for (const d of dirs) yield* walkMedia(path.join(dir, d));
}

// --- series: Kodi/Emby .nfo parsing (dep-free — the fields are flat, controlled *arr output) --------

function decodeXml(s: string): string {
	return s
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
		.replace(/&amp;/g, '&'); // last, so a literal "&amp;amp;" doesn't double-decode
}

/** Text of the first <name>…</name> (any attributes tolerated), XML-entity-decoded. */
function xmlTag(xml: string, name: string): string | null {
	const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
	return m ? decodeXml(m[1].trim()) : null;
}

/** <uniqueid type="tvdb" …>VALUE</uniqueid> for a given provider type. */
function xmlUniqueId(xml: string, type: string): string | null {
	const m = xml.match(new RegExp(`<uniqueid\\b[^>]*\\btype="${type}"[^>]*>([^<]+)</uniqueid>`, 'i'));
	return m ? m[1].trim() : null;
}

// Encoder/marketing names in NFOs → canonical codec ids (so the compat gate reasons consistently).
const V_CODEC: Record<string, string> = {
	x264: 'h264', avc: 'h264', h264: 'h264', x265: 'hevc', h265: 'hevc', hevc: 'hevc',
	vp9: 'vp9', vp09: 'vp9', av1: 'av1', av01: 'av1', mpeg2: 'mpeg2', xvid: 'mpeg4'
};
const A_CODEC: Record<string, string> = {
	eac3: 'eac3', ac3: 'ac3', aac: 'aac', dts: 'dts', truehd: 'truehd', flac: 'flac',
	opus: 'opus', mp3: 'mp3', vorbis: 'vorbis'
};
function normCodec(raw: string | null, map: Record<string, string>): string | null {
	if (!raw) return null;
	const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0];
	return map[key] ?? key;
}

interface EpisodeMeta {
	title: string | null;
	season: number | null;
	episode: number | null;
	aired: string | null;
	plot: string | null;
	tvdbId: string | null;
	width: number | null;
	height: number | null;
	vcodec: string | null;
	acodec: string | null;
	duration: number | null;
	fps: number | null;
}

const intOf = (s: string | null): number | null => (s && /^-?\d+$/.test(s) ? parseInt(s, 10) : null);

function parseEpisodeNfo(xml: string): EpisodeMeta {
	const video = xml.match(/<video>([\s\S]*?)<\/video>/i)?.[1] ?? '';
	const audio = xml.match(/<audio>([\s\S]*?)<\/audio>/i)?.[1] ?? '';
	const fpsRaw = xmlTag(video, 'framerate');
	return {
		title: xmlTag(xml, 'title'),
		season: intOf(xmlTag(xml, 'season')),
		episode: intOf(xmlTag(xml, 'episode')),
		aired: xmlTag(xml, 'aired'),
		plot: xmlTag(xml, 'plot'),
		tvdbId: xmlUniqueId(xml, 'tvdb'),
		width: intOf(xmlTag(video, 'width')),
		height: intOf(xmlTag(video, 'height')),
		vcodec: normCodec(xmlTag(video, 'codec'), V_CODEC),
		acodec: normCodec(xmlTag(audio, 'codec'), A_CODEC),
		duration: intOf(xmlTag(video, 'durationinseconds')),
		fps: fpsRaw && Number.isFinite(+fpsRaw) ? Math.round(+fpsRaw * 1000) / 1000 : null
	};
}

// Fallback when a media file has no sibling .nfo: pull SxxExx + a title from the filename.
const SXXEXX = /\bS(\d{1,4})E(\d{1,4})\b/i;
const QUALITY_TAG = /\s+(?:WEB[-.]?DL|WEB[-.]?Rip|Blu[-.]?Ray|BDRip|BRRip|HDTV|DVDRip|REMUX|1080p|720p|2160p|480p)[-.\s].*$/i;
function parseEpisodeFilename(base: string): { season: number | null; episode: number | null; title: string | null } {
	const m = base.match(SXXEXX);
	if (!m || m.index == null) return { season: null, episode: null, title: null };
	let title = base.slice(m.index + m[0].length).replace(/^\s*-\s*/, '').replace(QUALITY_TAG, '').trim();
	return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), title: title || null };
}

function airedToTs(aired: string | null): number | null {
	const m = aired?.match(/^(\d{4})-(\d{2})-(\d{2})/);
	return m ? Math.trunc(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000) : null;
}

/** Stable, URL-safe fallback id for an episode with no provider uniqueid — keyed off its path. */
function pathId(relPath: string): string {
	return 'ep-' + crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

function buildEpisodeRow(
	meta: EpisodeMeta | null,
	fname: { season: number | null; episode: number | null; title: string | null },
	id: string,
	seriesId: string,
	media: string,
	thumb: string | null,
	infoPath: string,
	mtime: number
): Row {
	const aired = meta?.aired ?? null;
	return {
		id,
		channel_id: seriesId,
		season_number: meta?.season ?? fname.season,
		episode_number: meta?.episode ?? fname.episode,
		title: meta?.title ?? fname.title ?? path.parse(media).name,
		description: meta?.plot ?? null,
		upload_date: aired ? aired.replace(/-/g, '') : null,
		timestamp: airedToTs(aired),
		duration: meta?.duration ?? null,
		view_count: null,
		like_count: null,
		width: meta?.width ?? null,
		height: meta?.height ?? null,
		fps: meta?.fps ?? null,
		vcodec: meta?.vcodec ?? null,
		acodec: meta?.acodec ?? null,
		tags: '[]',
		chapters: '[]',
		webpage_url: null,
		video_path: rel(media),
		thumb_path: thumb ? rel(thumb) : null,
		info_path: rel(infoPath),
		mtime
	};
}

export interface ScanStats {
	channels: number;
	videos: number;
	indexed: number;
	pruned: number;
	/** Set when the empty-library safety valve fired: the walk saw 0 videos where the index holds
	 *  some (suspected dead mount), so the prune was skipped. See scan(). */
	pruneSkipped?: boolean;
	elapsed_s: number;
}

/** Shared per-scan state threaded into the per-format indexers. */
interface ScanCtx {
	full: boolean;
	existing: Map<string, { id: string; mtime: number }>;
	seenVideos: Set<string>;
	seenChannels: Set<string>;
	upsertBatch: (rows: Row[]) => void;
	stubChannel: Database.Statement;
	enrichChannel: Database.Statement;
	wasSeenBefore: Database.Statement; // durable state.channels_seen probe — "is this channel new?"
	markSeen: Database.Statement; // record a channel id in state.channels_seen (INSERT OR IGNORE)
	counters: { indexed: number; processed: number };
}

/**
 * Full walk + incremental upsert + prune. Async so it yields between batches.
 *
 * `full` = re-parse every item even when its sidecar mtime is unchanged. The default (incremental)
 * skips unchanged items for speed, but that means a `thumb_path` (or any derived field) recorded when
 * a file existed is never re-checked if the source later renames/removes it — so a vanished thumbnail
 * 404s forever. A full rescan re-runs detection for everything and self-heals such stale references,
 * without deleting index.db. Exposed via `POST /api/scan?full=1`.
 */
export async function scan(full = false): Promise<ScanStats> {
	const start = Date.now();
	const database = db();

	let ok = false;
	try {
		ok = fs.statSync(MEDIA_ROOT).isDirectory();
	} catch {
		ok = false;
	}
	if (!ok) throw new Error(`MEDIA_ROOT does not exist or is not a directory: ${MEDIA_ROOT}`);

	const upsertVideo = database.prepare(
		`INSERT INTO videos (${VIDEO_COLUMNS.join(', ')}) ` +
			`VALUES (${VIDEO_COLUMNS.map((c) => '@' + c).join(', ')}) ` +
			`ON CONFLICT(id) DO UPDATE SET ` +
			VIDEO_COLUMNS.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(', ')
	);
	// Keep the video_tags index in lock-step with each upserted video (replace-in-place).
	const delTags = database.prepare('DELETE FROM video_tags WHERE video_id = ?');
	const insTags = database.prepare(
		'INSERT INTO video_tags (video_id, tag) SELECT ?, value FROM json_each(?)'
	);
	const upsertBatch = database.transaction((rows: Row[]) => {
		for (const row of rows) {
			upsertVideo.run(row);
			delTags.run(row.id as string);
			insTags.run(row.id as string, row.tags as string);
		}
	});

	// Stub: ensure the row exists + refresh kind/poster/fanart from disk, but DON'T touch the
	// display name (so an incremental scan of an all-cached channel keeps its real name).
	const stubChannel = database.prepare(
		`INSERT INTO channels (id, name, kind, library_id, poster_path, fanart_path) VALUES (@id, @id, @kind, @lib, @poster, @fanart)
		 ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, library_id=excluded.library_id, poster_path=excluded.poster_path, fanart_path=excluded.fanart_path`
	);
	// Enrich: run only when we parsed a video this scan (so we have a real name).
	const enrichChannel = database.prepare(
		`INSERT INTO channels (id, name, kind, library_id, yt_channel_id, url, follower_count, poster_path, fanart_path)
		 VALUES (@id, @name, @kind, @lib, @yt, @url, @fc, @poster, @fanart)
		 ON CONFLICT(id) DO UPDATE SET
		   name=excluded.name,
		   kind=excluded.kind,
		   library_id=excluded.library_id,
		   yt_channel_id=COALESCE(excluded.yt_channel_id, channels.yt_channel_id),
		   url=COALESCE(excluded.url, channels.url),
		   follower_count=COALESCE(excluded.follower_count, channels.follower_count),
		   poster_path=excluded.poster_path,
		   fanart_path=excluded.fanart_path`
	);

	const existing = new Map<string, { id: string; mtime: number }>();
	for (const r of database.prepare('SELECT id, info_path, mtime FROM videos').all() as {
		id: string;
		info_path: string;
		mtime: number;
	}[]) {
		existing.set(r.info_path, { id: r.id, mtime: r.mtime });
	}

	// "Is this channel NEW?" is answered from DURABLE state.channels_seen, never from this disposable
	// index: deleting index.db is a documented-safe op, and if the check read the index a rebuild would
	// make every channel "new" again and re-apply the library visibility default over choices the owner
	// already made (a channel opened up on a private-default library would silently flip back private).
	const wasSeenBefore = database.prepare('SELECT 1 FROM state.channels_seen WHERE channel_id = ?');
	const markSeen = database.prepare(
		'INSERT OR IGNORE INTO state.channels_seen (channel_id, first_seen_at) VALUES (?, ?)'
	);

	const ctx: ScanCtx = {
		full,
		existing,
		seenVideos: new Set<string>(),
		seenChannels: new Set<string>(),
		upsertBatch,
		stubChannel,
		enrichChannel,
		wasSeenBefore,
		markSeen,
		counters: { indexed: 0, processed: 0 }
	};

	await tick(); // return control to the server before any heavy per-file work

	const libs = resolveLibraries();
	for (const lib of libs) {
		if (lib.format === 'series') await indexSeries(lib, ctx);
		else await indexChannels(lib, ctx, childLibraryDirs(lib, libs));
	}

	const { seenVideos, seenChannels } = ctx;

	// SAFETY VALVE: a scan that previously indexed videos but now sees NONE is far more likely a dead
	// mount than a deliberately emptied library — the MEDIA_ROOT stat above passes for an EMPTY mount
	// point (the classic unmounted-NAS Docker failure). Pruning here would wipe the whole index for
	// nothing (it self-heals on remount, but watch-state joins, shares, and channel pages all break
	// meanwhile). Keep the stale index, log loudly, and let the owner force a real wipe with the
	// owner-gated POST /api/scan?full=1 if the library truly is empty now.
	if (!full && existing.size > 0 && seenVideos.size === 0) {
		console.error(
			`[mytview] scan saw 0 videos where the index holds ${existing.size} — suspected unmounted/` +
				'empty library; skipping prune. If the library really is empty, force with POST /api/scan?full=1.'
		);
		return {
			channels: seenChannels.size,
			videos: seenVideos.size,
			indexed: ctx.counters.indexed,
			pruned: 0,
			pruneSkipped: true,
			elapsed_s: Math.round((Date.now() - start) / 10) / 100
		};
	}

	const prune = database.transaction((): number => {
		let pruned = 0;
		const delVideo = database.prepare('DELETE FROM videos WHERE id = ?');
		for (const r of database.prepare('SELECT id FROM videos').all() as { id: string }[]) {
			if (!seenVideos.has(r.id)) {
				delVideo.run(r.id);
				pruned++;
			}
		}
		const delChannel = database.prepare('DELETE FROM channels WHERE id = ?');
		for (const r of database.prepare('SELECT id FROM channels').all() as { id: string }[]) {
			if (!seenChannels.has(r.id)) delChannel.run(r.id);
		}
		database
			.prepare(
				'UPDATE channels SET video_count = ' +
					'(SELECT COUNT(*) FROM videos WHERE videos.channel_id = channels.id)'
			)
			.run();
		return pruned;
	});
	const pruned = prune();
	gcShares(); // drop expired share links

	return {
		channels: seenChannels.size,
		videos: seenVideos.size,
		indexed: ctx.counters.indexed,
		pruned,
		elapsed_s: Math.round((Date.now() - start) / 10) / 100
	};
}

/** Immediate-child subdir names of a channels library that are themselves ANOTHER library's root, so
 *  channels-at-root + a series subfolder don't collide (the series folder isn't scanned as a channel). */
function childLibraryDirs(lib: Library, all: Library[]): Set<string> {
	const out = new Set<string>();
	const base = lib.prefix ? lib.prefix + '/' : '';
	for (const o of all) {
		if (o === lib || !o.prefix) continue;
		if (base && !o.prefix.startsWith(base)) continue;
		const rest = o.prefix.slice(base.length);
		if (rest && !rest.includes('/')) out.add(rest); // immediate child only
	}
	return out;
}

/**
 * Channels library: each immediate subdir of the library root is a channel; every `.info.json` with a
 * sibling media file is a video. `excluded` holds any immediate subdir that is another library's root
 * (e.g. a series folder under a channels-at-root library), so it isn't mistaken for a channel.
 */
async function indexChannels(lib: Library, ctx: ScanCtx, excluded: Set<string>): Promise<void> {
	const topDirs = fs
		.readdirSync(lib.root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !excluded.has(e.name))
		.map((e) => e.name)
		.sort();

	for (const cid of topDirs) {
		const channelDir = path.join(lib.root, cid);
		const poster = firstExisting(channelDir, POSTER_NAMES);
		const fanart = firstExisting(channelDir, FANART_NAMES);
		const posterRel = poster ? rel(poster) : null;
		const fanartRel = fanart ? rel(fanart) : null;
		let name = cid;
		let url: string | null = null;
		let followers: number | null = null;
		let ytId: string | null = null;
		let foundAny = false;
		let enriched = false;
		let batch: Row[] = [];

		// Genuinely-new channels get the library's default (lib.newPrivate). "New" is judged against the
		// DURABLE channels_seen record — not this disposable index — so existing channels keep their
		// visibility even across an index.db rebuild. See visibility.ts / state.ts.
		const isNewChannel = !ctx.wasSeenBefore.get(cid);
		ctx.stubChannel.run({ id: cid, kind: 'channel', lib: lib.id, poster: posterRel, fanart: fanartRel });
		ctx.markSeen.run(cid, Date.now());
		if (isNewChannel) applyNewChannelDefault(cid, lib.newPrivate);

		for (const infoPath of walkInfo(channelDir)) {
			let mtime: number;
			try {
				mtime = fs.statSync(infoPath).mtimeMs / 1000;
			} catch {
				continue;
			}
			const relInfo = rel(infoPath);
			const cached = ctx.existing.get(relInfo);
			if (!ctx.full && cached && cached.mtime === mtime) {
				ctx.seenVideos.add(cached.id);
				foundAny = true;
			} else {
				const base = path.basename(infoPath).slice(0, -INFO_SUFFIX.length);
				const parent = path.dirname(infoPath);
				const media = firstExisting(parent, MEDIA_EXTS.map((e) => base + e));
				if (media) {
					let info: Record<string, unknown> | null = null;
					try {
						info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
					} catch {
						info = null;
					}
					if (info) {
						const thumb = findThumb(parent, base, path.basename(media));
						const vidId = String(info.id ?? base);
						batch.push(buildVideoRow(info, vidId, cid, media, thumb, infoPath, mtime));
						ctx.seenVideos.add(vidId);
						ctx.counters.indexed++;
						foundAny = true;
						enriched = true;
						name = asStr(info.channel) ?? asStr(info.uploader) ?? name;
						url = asStr(info.channel_url) ?? asStr(info.uploader_url) ?? url;
						ytId = asStr(info.channel_id) ?? ytId;
						if (typeof info.channel_follower_count === 'number') {
							followers = Math.trunc(info.channel_follower_count);
						}
					}
				}
			}
			if (++ctx.counters.processed % BATCH === 0) {
				if (batch.length) {
					ctx.upsertBatch(batch);
					batch = [];
				}
				await tick();
			}
		}
		if (batch.length) ctx.upsertBatch(batch);
		if (foundAny) {
			ctx.seenChannels.add(cid);
			if (enriched) {
				ctx.enrichChannel.run({
					id: cid, name, kind: 'channel', lib: lib.id, yt: ytId, url, fc: followers, poster: posterRel, fanart: fanartRel
				});
			}
		}
		await tick();
	}
}

/**
 * Series library: each immediate subdir of the library root is a series (a `kind='series'` channel);
 * every media file under it is an episode. Metadata comes from a sibling Kodi/Emby `.nfo` (preferred)
 * or the `SxxExx` filename (fallback); season/episode posters + `-thumb.jpg` come from local images.
 */
async function indexSeries(lib: Library, ctx: ScanCtx): Promise<void> {
	const showDirs = fs
		.readdirSync(lib.root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();

	for (const showName of showDirs) {
		const showDir = path.join(lib.root, showName);
		const seriesId = 'series:' + showName; // namespaced so it can't collide with a channel id
		const poster = firstExisting(showDir, POSTER_NAMES);
		const fanart = firstExisting(showDir, FANART_NAMES);
		const posterRel = poster ? rel(poster) : null;
		const fanartRel = fanart ? rel(fanart) : null;

		// tvshow.nfo (optional) gives the display name; else fall back to the folder name.
		let name = showName;
		const showNfo = path.join(showDir, 'tvshow.nfo');
		if (isFile(showNfo)) {
			try {
				name = xmlTag(fs.readFileSync(showNfo, 'utf-8'), 'title') ?? showName;
			} catch {
				/* keep folder name */
			}
		}

		// Same durable "new" check as indexChannels — never the disposable index.
		const isNew = !ctx.wasSeenBefore.get(seriesId);
		ctx.stubChannel.run({ id: seriesId, kind: 'series', lib: lib.id, poster: posterRel, fanart: fanartRel });
		ctx.markSeen.run(seriesId, Date.now());
		if (isNew) applyNewChannelDefault(seriesId, lib.newPrivate);

		let foundAny = false;
		let batch: Row[] = [];

		for (const media of walkMedia(showDir)) {
			const parent = path.dirname(media);
			const base = path.parse(media).name;
			const nfoPath = path.join(parent, base + NFO_SUFFIX);
			const hasNfo = isFile(nfoPath);
			const sidecar = hasNfo ? nfoPath : media; // what we track for the incremental mtime skip

			let mtime: number;
			try {
				mtime = fs.statSync(sidecar).mtimeMs / 1000;
			} catch {
				continue;
			}
			const relSidecar = rel(sidecar);
			const cached = ctx.existing.get(relSidecar);
			if (!ctx.full && cached && cached.mtime === mtime) {
				ctx.seenVideos.add(cached.id);
				foundAny = true;
			} else {
				let meta: EpisodeMeta | null = null;
				if (hasNfo) {
					try {
						meta = parseEpisodeNfo(fs.readFileSync(nfoPath, 'utf-8'));
					} catch {
						meta = null;
					}
				}
				const fname = parseEpisodeFilename(base);
				const thumb = findThumb(parent, base, path.basename(media));
				const id = meta?.tvdbId ? 'tvdb-' + meta.tvdbId : pathId(rel(media));
				batch.push(buildEpisodeRow(meta, fname, id, seriesId, media, thumb, sidecar, mtime));
				ctx.seenVideos.add(id);
				ctx.counters.indexed++;
				foundAny = true;
			}
			if (++ctx.counters.processed % BATCH === 0) {
				if (batch.length) {
					ctx.upsertBatch(batch);
					batch = [];
				}
				await tick();
			}
		}
		if (batch.length) ctx.upsertBatch(batch);
		if (foundAny) {
			ctx.seenChannels.add(seriesId);
			ctx.enrichChannel.run({
				id: seriesId, name, kind: 'series', lib: lib.id, yt: null, url: null, fc: null, poster: posterRel, fanart: fanartRel
			});
		}
		await tick();
	}
}

// --- scan orchestration: a lock + last-run state for status + auto-rescan ------

let _scanning = false;
let _last: ScanStats | null = null;
let _lastError: string | null = null;

export interface ScanStatus {
	scanning: boolean;
	everScanned: boolean;
	error: string | null;
	last: ScanStats | null;
}

export function scanStatus(): ScanStatus {
	return { scanning: _scanning, everScanned: _last !== null, error: _lastError, last: _last };
}

/** Run a scan unless one is already in progress. Returns stats, or null if skipped/failed. */
export async function runScan(full = false): Promise<ScanStats | null> {
	if (_scanning) return null;
	_scanning = true;
	try {
		_last = await scan(full);
		_lastError = null;
		return _last;
	} catch (e) {
		_lastError = (e as Error).message;
		console.error('[mytview] scan failed:', _lastError);
		return null;
	} finally {
		_scanning = false;
	}
}
