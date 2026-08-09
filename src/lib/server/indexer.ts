/**
 * Read-only indexer.
 *
 * Walks each configured library under MEDIA_ROOT and upserts the result into SQLite. Three library
 * formats, dispatched by `resolveLibraries()`:
 *   - channels: every `.info.json` with a sibling media file (ytdl-sub style) → channels of videos.
 *   - series:   every media file with a sibling Kodi/Emby `.nfo` (or a bare `SxxExx` filename), plus
 *               local poster/fanart/`-thumb.jpg` images (*arr style) → series of season/episode rows.
 *   - movies:   `Name (Year)/` folders with a `movie.nfo` + poster/fanart (Radarr/Kodi style) → ONE
 *               synthetic channel (`kind='movies'`, named after the library) holding every movie.
 * Series/movies reuse the `channels`/`videos` tables: a series is a channel (`kind='series'`), an
 * episode is a video carrying `season_number`/`episode_number`; a movie is a video carrying `year` +
 * `poster_path` (its `thumb_path` holds the FANART so movie cards stay 16:9 in the Recent feed).
 *
 * Incremental (unchanged sidecar mtime → skipped) and prunes rows whose files vanished. Nothing here
 * mutates the library. The walk is **async + batched**: ALL filesystem I/O goes through `fs.promises`
 * (the libuv pool — a slow disk/NAS stat parks a worker thread, never the event loop), sqlite writes
 * stay synchronous but are committed in small transactions with an explicit yield between batches, and
 * the prune deletes in chunks — so a scan never freezes the server, no matter how big or slow the
 * library is. Keep it that way: a single stray `*Sync` fs call in a hot loop reintroduces the
 * UI-goes-sluggish-during-scan bug this layout exists to prevent.
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
import { warmImage } from './imagecache';
import { resolveInMediaRoot } from './files';

const MEDIA_EXTS = ['.mp4', '.mkv', '.webm', '.m4v'];
const THUMB_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const POSTER_NAMES = ['poster.jpg', 'poster.png', 'poster.webp'];
const FANART_NAMES = ['fanart.jpg', 'fanart.png', 'fanart.webp', 'banner.jpg'];
const INFO_SUFFIX = '.info.json';
const NFO_SUFFIX = '.nfo';
const BATCH = 25; // files processed between event-loop yields

const rel = (p: string): string => path.relative(MEDIA_ROOT, p);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const fsp = fs.promises;

async function isFile(p: string): Promise<boolean> {
	try {
		return (await fsp.stat(p)).isFile();
	} catch {
		return false;
	}
}

async function firstExisting(dir: string, names: string[]): Promise<string | null> {
	for (const name of names) {
		const candidate = path.join(dir, name);
		if (await isFile(candidate)) return candidate;
	}
	return null;
}

/**
 * Locate a video's thumbnail, tolerating the naming variations different sources
 * produce. Case-insensitive, in priority order:
 * `<base>.<img>`, `<mediafile>.<img>` (Title.mp4.jpg), `<base>…​.<img>` (Title-thumb.jpg),
 * else the lone image in the dir.
 */
async function findThumb(parent: string, base: string, mediaName: string): Promise<string | null> {
	let entries: string[];
	try {
		entries = await fsp.readdir(parent);
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
		year: null,
		poster_path: null,
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
		// Uploader tags + YouTube's own `categories` (a fixed ~15-value taxonomy, e.g. "Science &
		// Technology") — folding categories in gives channel videos a genre-ish axis through the
		// existing /tag browsing for free. Deduped; both are plain user-visible tags.
		tags: JSON.stringify([
			...new Set([
				...(Array.isArray(info.tags) ? info.tags : []),
				...(Array.isArray(info.categories) ? info.categories : [])
			])
		]),
		chapters: JSON.stringify(Array.isArray(info.chapters) ? info.chapters : []),
		webpage_url: asStr(info.webpage_url),
		video_path: rel(media),
		thumb_path: thumb ? rel(thumb) : null,
		info_path: rel(infoPath),
		mtime
	};
}

const VIDEO_COLUMNS = [
	'id', 'channel_id', 'season_number', 'episode_number', 'year', 'poster_path', 'title', 'description',
	'upload_date', 'timestamp', 'duration', 'view_count', 'like_count', 'width',
	'height', 'fps', 'vcodec', 'acodec', 'tags', 'chapters', 'webpage_url',
	'video_path', 'thumb_path', 'info_path', 'mtime'
];

/** Recursively yield every *.info.json path under a dir, dirs & files sorted. */
async function* walkInfo(dir: string): AsyncGenerator<string> {
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
	const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
	for (const f of files) if (f.endsWith(INFO_SUFFIX)) yield path.join(dir, f);
	for (const d of dirs) yield* walkInfo(path.join(dir, d));
}

/** Recursively yield every media file under a dir (series episodes), dirs & files sorted. */
async function* walkMedia(dir: string): AsyncGenerator<string> {
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
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

/** width/height/codecs/duration/fps from a Kodi `<streamdetails>` block — episode and movie NFOs
 *  share the exact structure, so both parsers spread this. */
function streamMeta(xml: string): {
	width: number | null;
	height: number | null;
	vcodec: string | null;
	acodec: string | null;
	duration: number | null;
	fps: number | null;
} {
	const video = xml.match(/<video>([\s\S]*?)<\/video>/i)?.[1] ?? '';
	const audio = xml.match(/<audio>([\s\S]*?)<\/audio>/i)?.[1] ?? '';
	const fpsRaw = xmlTag(video, 'framerate');
	return {
		width: intOf(xmlTag(video, 'width')),
		height: intOf(xmlTag(video, 'height')),
		vcodec: normCodec(xmlTag(video, 'codec'), V_CODEC),
		acodec: normCodec(xmlTag(audio, 'codec'), A_CODEC),
		duration: intOf(xmlTag(video, 'durationinseconds')),
		fps: fpsRaw && Number.isFinite(+fpsRaw) ? Math.round(+fpsRaw * 1000) / 1000 : null
	};
}

function parseEpisodeNfo(xml: string): EpisodeMeta {
	return {
		title: xmlTag(xml, 'title'),
		season: intOf(xmlTag(xml, 'season')),
		episode: intOf(xmlTag(xml, 'episode')),
		aired: xmlTag(xml, 'aired'),
		plot: xmlTag(xml, 'plot'),
		tvdbId: xmlUniqueId(xml, 'tvdb'),
		...streamMeta(xml)
	};
}

// Fallback when a media file has no sibling .nfo: pull SxxExx + a title from the filename.
const SXXEXX = /\bS(\d{1,4})E(\d{1,4})\b/i;
// Separator-tolerant ([-. ] not just space: scene names are dot-separated) and end-anchored-or-more,
// so `Some.Movie.1080p` and `Title WEBDL-1080p …` both strip from the first quality token on.
const QUALITY_TAG =
	/[\s.-]+(?:WEB[-.]?DL|WEB[-.]?Rip|Blu[-.]?Ray|BDRip|BRRip|HDTV|DVDRip|REMUX|1080p|720p|2160p|480p)(?:[-.\s].*)?$/i;
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

/** Stable, URL-safe fallback id for an episode/movie with no provider uniqueid — keyed off its path. */
function pathId(relPath: string): string {
	return 'ep-' + crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

// --- movies: Kodi/Radarr <movie> .nfo + `Name (Year)` folders --------------------------------------

const MOVIE_NFO = 'movie.nfo';
/** Trailers/samples living beside the main file are not the movie (Radarr writes `<base>-trailer`). */
const NON_FEATURE = /(^|[-. ])(trailer|sample)$/i;

/** Every `<name>…</name>` occurrence, entity-decoded — Kodi lists genres as repeated `<genre>` tags. */
function xmlTags(xml: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
	for (const m of xml.matchAll(re)) {
		const v = decodeXml(m[1].trim());
		if (v) out.push(v);
	}
	return out;
}

interface MovieMeta {
	title: string | null;
	year: number | null;
	premiered: string | null; // yyyy-mm-dd
	plot: string | null;
	genres: string[];
	/** Top-billed cast (≤5, by <order>) + director(s) — relatedness signals, not display data. */
	people: string[];
	/** Kodi <set> collection name (franchise membership) — the strongest relatedness signal. */
	setName: string | null;
	runtimeMin: number | null; // <runtime> minutes — fallback when streamdetails has no duration
	tmdbId: string | null;
	imdbId: string | null;
	width: number | null;
	height: number | null;
	vcodec: string | null;
	acodec: string | null;
	duration: number | null;
	fps: number | null;
}

/** Top-billed cast: `<actor>` blocks sorted by `<order>` (document order when absent), first `cap`. */
function movieActors(xml: string, cap = 5): string[] {
	const blocks = [...xml.matchAll(/<actor(?:\s[^>]*)?>([\s\S]*?)<\/actor>/gi)].map((m) => m[1]);
	const named = blocks
		.map((b, i) => ({ name: xmlTag(b, 'name'), order: intOf(xmlTag(b, 'order')) ?? i }))
		.filter((a): a is { name: string; order: number } => !!a.name);
	named.sort((a, b) => a.order - b.order);
	return named.slice(0, cap).map((a) => a.name);
}

function parseMovieNfo(xml: string): MovieMeta {
	const premiered = xmlTag(xml, 'premiered');
	// <set> is either a block with an inner <name> (modern Kodi/Radarr) or bare text (older writers).
	const setBlock = xmlTag(xml, 'set');
	const setName = setBlock ? (xmlTag(setBlock, 'name') ?? (setBlock.includes('<') ? null : setBlock)) : null;
	return {
		title: xmlTag(xml, 'title'),
		year: intOf(xmlTag(xml, 'year')) ?? (premiered ? intOf(premiered.slice(0, 4)) : null),
		premiered,
		plot: xmlTag(xml, 'plot') ?? xmlTag(xml, 'outline'),
		genres: xmlTags(xml, 'genre'),
		people: [...new Set([...movieActors(xml), ...xmlTags(xml, 'director')])],
		setName,
		runtimeMin: intOf(xmlTag(xml, 'runtime')),
		tmdbId: xmlUniqueId(xml, 'tmdb'),
		imdbId: xmlUniqueId(xml, 'imdb'),
		...streamMeta(xml)
	};
}

// `Heat (1995)` — the Radarr/Kodi naming convention; the parenthesised year is the anchor.
const NAME_YEAR = /^(.+?)[ .]\(((?:19|20)\d{2})\)/;
// Un-renamed scene releases: dot/underscore-separated with a BARE year token
// (`American.Reunion.2012.UNRATED.BluRay.1080p.DTS-HD…`). GREEDY title so the LAST year-like token
// anchors (`Blade.Runner.2049.2017` → year 2017), and everything after it (edition/quality/group)
// drops. Known tradeoff (same as Plex/Jellyfin): a yearless title ENDING in a year-like number
// (`Wonder Woman 1984`) mis-splits — an NFO or `Name (Year)` naming always wins over this fallback.
const SCENE_YEAR = /^(.+)[. _-]((?:19|20)\d{2})(?=[. _-]|$)/;
// Leading release-site prefix (`www.Site.org - Title 2013`) — pure junk before the real name.
const SITE_PREFIX = /^www\.\S+\s*-\s*/i;
/** Dots/underscores → spaces, collapse runs, drop trailing separators. */
const cleanTitle = (s: string): string =>
	s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/[\s-]+$/, '').trim();
function parseMovieFilename(base: string): { title: string | null; year: number | null } {
	const stripped = base.replace(SITE_PREFIX, '');
	const m = stripped.match(NAME_YEAR) ?? stripped.match(SCENE_YEAR);
	if (!m) return { title: cleanTitle(stripped.replace(QUALITY_TAG, '')) || null, year: null };
	return { title: cleanTitle(m[1]) || null, year: parseInt(m[2], 10) };
}

/**
 * Movie art: generic `poster.*`/`fanart.*` in the movie's own folder, else Radarr's per-file
 * `<base>-poster.*`/`<base>-fanart.*` variants. `genericOk=false` for loose files in the library
 * ROOT, where a folder-level poster.jpg would otherwise wrongly attach to every loose movie.
 */
async function movieArt(
	dir: string,
	base: string,
	genericOk: boolean
): Promise<{ poster: string | null; fanart: string | null }> {
	let poster = genericOk ? await firstExisting(dir, POSTER_NAMES) : null;
	let fanart = genericOk ? await firstExisting(dir, FANART_NAMES) : null;
	if (!poster || !fanart) {
		let entries: string[] = [];
		try {
			entries = await fsp.readdir(dir);
		} catch {
			/* unreadable dir → no art */
		}
		const baseL = base.toLowerCase();
		const find = (suffix: string): string | undefined =>
			entries.find((n) => {
				const ext = path.extname(n).toLowerCase();
				if (!THUMB_EXTS.includes(ext)) return false;
				const stem = n.slice(0, n.length - ext.length).toLowerCase();
				return stem === baseL + suffix || (genericOk && stem.endsWith(suffix));
			});
		if (!poster) {
			const p = find('-poster');
			poster = p ? path.join(dir, p) : null;
		}
		if (!fanart) {
			const f = find('-fanart');
			fanart = f ? path.join(dir, f) : null;
		}
	}
	return { poster, fanart };
}

/** The main feature in a movie folder: the LARGEST media file in its root (multi-file folders carry
 *  editions/extras — size beats name heuristics), trailers/samples excluded, subfolders ignored. */
async function mainFeature(dir: string): Promise<string | null> {
	let entries: string[];
	try {
		entries = await fsp.readdir(dir);
	} catch {
		return null;
	}
	let best: string | null = null;
	let bestSize = -1;
	for (const n of entries) {
		if (!MEDIA_EXTS.includes(path.extname(n).toLowerCase())) continue;
		if (NON_FEATURE.test(path.parse(n).name)) continue;
		const p = path.join(dir, n);
		let size: number;
		try {
			size = (await fsp.stat(p)).size;
		} catch {
			continue;
		}
		if (size > bestSize) {
			bestSize = size;
			best = p;
		}
	}
	return best;
}

function buildMovieRow(
	meta: MovieMeta | null,
	fname: { title: string | null; year: number | null },
	id: string,
	channelId: string,
	media: string,
	addedSec: number,
	art: { poster: string | null; fanart: string | null },
	infoPath: string,
	mtime: number
): Row {
	return {
		id,
		channel_id: channelId,
		season_number: null,
		episode_number: null,
		year: meta?.year ?? fname.year,
		poster_path: art.poster ? rel(art.poster) : null,
		title: meta?.title ?? fname.title ?? path.parse(media).name,
		description: meta?.plot ?? null,
		upload_date: meta?.premiered ? meta.premiered.replace(/-/g, '') : null,
		// Recent = "recently ADDED" for movies — the DURABLE first-seen date (state.videos_seen; seeded
		// from the file's mtime on first sight, frozen after), NOT the live mtime: a touched/re-encoded
		// file must not resurface as new. The premiere lives in `year`/`upload_date` for display.
		timestamp: Math.trunc(addedSec),
		duration: meta?.duration ?? (meta?.runtimeMin ? meta.runtimeMin * 60 : null),
		view_count: null,
		like_count: null,
		width: meta?.width ?? null,
		height: meta?.height ?? null,
		fps: meta?.fps ?? null,
		vcodec: meta?.vcodec ?? null,
		acodec: meta?.acodec ?? null,
		// Genres ride the tag system (genre browsing via /tag works everywhere for free). Cast/director
		// (`person:`) and collection (`set:`) ride the SAME index as NAMESPACED entries — pure
		// relatedness signals: the idf weighting in moviesRelated naturally ranks a shared collection
		// (df≈3) above a shared actor (df≈10) above a broad genre (df≈100s), and getVideo strips the
		// namespaced entries so tag chips only ever show genres.
		tags: JSON.stringify([
			...(meta?.genres ?? []),
			...(meta?.people ?? []).map((p) => 'person:' + p),
			...(meta?.setName ? ['set:' + meta.setName] : [])
		]),
		chapters: '[]',
		webpage_url: null,
		video_path: rel(media),
		// The 16:9 card-art rule: fanart fills the thumb slot so movie cards look native in Recent's
		// landscape grid; the 2:3 poster is its OWN column for poster-shaped surfaces (library grid,
		// detail). Poster-only folders fall back to the poster rather than no art at all.
		thumb_path: art.fanart ? rel(art.fanart) : art.poster ? rel(art.poster) : null,
		info_path: rel(infoPath),
		mtime
	};
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
		year: null,
		poster_path: null,
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

/** Live progress of the scan in flight — the server-owned feedback every client renders (contract:
 *  /api/status + /api/v1/status ship it verbatim). `library` is the one currently walking; null =
 *  the end-of-scan cleanup (prune) phase. `videos` counts everything recognized so far this scan
 *  (cached + re-parsed), `indexed` only the re-parsed. */
export interface ScanProgress {
	library: string | null;
	videos: number;
	indexed: number;
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
	markVideoSeen: Database.Statement; // durable dateAdded: INSERT OR IGNORE into state.videos_seen (seed = file mtime)
	getVideoSeen: Database.Statement; // read the frozen first_seen_at back (ms)
	counters: { indexed: number; processed: number };
	/** Called by the walkers at every batch boundary AND at each library's end: refreshes the
	 *  library's channel `video_count`s (so nav tabs/visibility appear while the walk is still
	 *  running — they're gated on video_count > 0) and publishes live ScanProgress. */
	onBatch: (lib: Library) => void;
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
		ok = (await fsp.stat(MEDIA_ROOT)).isDirectory();
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
	// `genres` is COALESCEd in both statements: series pass theirs (tvshow.nfo, known at stub time),
	// the movies channel gets its aggregate at enrich time, ytdl channels always pass null — and a
	// null never wipes a previously-stored list (e.g. an incremental scan that re-parsed nothing).
	const stubChannel = database.prepare(
		`INSERT INTO channels (id, name, kind, library_id, poster_path, fanart_path, genres) VALUES (@id, @id, @kind, @lib, @poster, @fanart, @genres)
		 ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, library_id=excluded.library_id, poster_path=excluded.poster_path, fanart_path=excluded.fanart_path, genres=COALESCE(excluded.genres, channels.genres)`
	);
	// Enrich: run only when we parsed a video this scan (so we have a real name).
	const enrichChannel = database.prepare(
		`INSERT INTO channels (id, name, kind, library_id, yt_channel_id, url, follower_count, poster_path, fanart_path, genres)
		 VALUES (@id, @name, @kind, @lib, @yt, @url, @fc, @poster, @fanart, @genres)
		 ON CONFLICT(id) DO UPDATE SET
		   name=excluded.name,
		   kind=excluded.kind,
		   library_id=excluded.library_id,
		   yt_channel_id=COALESCE(excluded.yt_channel_id, channels.yt_channel_id),
		   url=COALESCE(excluded.url, channels.url),
		   follower_count=COALESCE(excluded.follower_count, channels.follower_count),
		   poster_path=excluded.poster_path,
		   fanart_path=excluded.fanart_path,
		   genres=COALESCE(excluded.genres, channels.genres)`
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
	// Durable per-video "entered the library" (Plex-style dateAdded): written once, frozen forever —
	// a touched file / upgrade / index rebuild can't resurface an old item as "recently added".
	const markVideoSeen = database.prepare(
		'INSERT OR IGNORE INTO state.videos_seen (video_id, first_seen_at) VALUES (?, ?)'
	);
	const getVideoSeen = database.prepare('SELECT first_seen_at AS t FROM state.videos_seen WHERE video_id = ?');
	const markSeen = database.prepare(
		'INSERT OR IGNORE INTO state.channels_seen (channel_id, first_seen_at) VALUES (?, ?)'
	);

	const seenVideos = new Set<string>();
	const seenChannels = new Set<string>();
	const counters = { indexed: 0, processed: 0 };
	// `IS ?` (not `= ?`) so the implicit default library (library_id NULL) matches too.
	const refreshCounts = database.prepare(
		'UPDATE channels SET video_count = ' +
			'(SELECT COUNT(*) FROM videos WHERE videos.channel_id = channels.id) WHERE library_id IS ?'
	);
	const onBatch = (lib: Library): void => {
		refreshCounts.run(lib.id);
		_progress = { library: lib.name, videos: seenVideos.size, indexed: counters.indexed };
	};

	const ctx: ScanCtx = {
		full,
		existing,
		seenVideos,
		seenChannels,
		upsertBatch,
		stubChannel,
		enrichChannel,
		wasSeenBefore,
		markSeen,
		markVideoSeen,
		getVideoSeen,
		counters,
		onBatch
	};

	await tick(); // return control to the server before any heavy per-file work

	const libs = resolveLibraries();
	// Never-indexed libraries walk FIRST: right after an owner adds one, its content starts appearing
	// within seconds — the (full) re-parse of the established libraries queues BEHIND it, not in front
	// of it. Order is otherwise stable. First boot (nothing indexed) trivially keeps table order.
	const hasRows = database.prepare(
		'SELECT 1 FROM channels c WHERE c.library_id IS ? AND EXISTS ' +
			'(SELECT 1 FROM videos v WHERE v.channel_id = c.id) LIMIT 1'
	);
	const isNewLib = (l: Library): boolean => !hasRows.get(l.id);
	const ordered = [...libs.filter(isNewLib), ...libs.filter((l) => !isNewLib(l))];
	console.log(
		`[mytview] scan: started${full ? ' (full)' : ''} — ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'}` +
			(ordered.length ? ` [${ordered.map((l) => l.name).join(', ')}]` : ' (nothing to index)')
	);
	for (const lib of ordered) {
		_progress = { library: lib.name, videos: seenVideos.size, indexed: counters.indexed };
		const before = seenVideos.size;
		if (lib.format === 'series') await indexSeries(lib, ctx);
		else if (lib.format === 'movies') await indexMovies(lib, ctx);
		else await indexChannels(lib, ctx, childLibraryDirs(lib, libs));
		ctx.onBatch(lib); // final count refresh for libraries smaller than one batch
		console.log(`[mytview] scan: ${lib.name} (${lib.format}) — ${seenVideos.size - before} items`);
	}

	// Cleanup phase (prune + counts): no current library.
	_progress = { library: null, videos: seenVideos.size, indexed: counters.indexed };

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

	// Prune in CHUNKS, yielding between them: one all-encompassing transaction held the write lock (and
	// the event loop) for the whole sweep, which on a large deletion (library moved/reorganised) froze
	// every request mid-scan. Chunked deletes mean a reader can briefly see a half-pruned index — the
	// same progressive visibility the batched upserts above already have.
	const PRUNE_CHUNK = 200;
	const deadVideos = (database.prepare('SELECT id FROM videos').all() as { id: string }[])
		.map((r) => r.id)
		.filter((id) => !seenVideos.has(id));
	const deadChannels = (database.prepare('SELECT id FROM channels').all() as { id: string }[])
		.map((r) => r.id)
		.filter((id) => !seenChannels.has(id));
	const delVideo = database.prepare('DELETE FROM videos WHERE id = ?');
	const delChannel = database.prepare('DELETE FROM channels WHERE id = ?');
	const delVideoChunk = database.transaction((ids: string[]) => ids.forEach((id) => delVideo.run(id)));
	const delChannelChunk = database.transaction((ids: string[]) => ids.forEach((id) => delChannel.run(id)));
	for (let i = 0; i < deadVideos.length; i += PRUNE_CHUNK) {
		delVideoChunk(deadVideos.slice(i, i + PRUNE_CHUNK));
		await tick();
	}
	for (let i = 0; i < deadChannels.length; i += PRUNE_CHUNK) {
		delChannelChunk(deadChannels.slice(i, i + PRUNE_CHUNK));
		await tick();
	}
	database
		.prepare(
			'UPDATE channels SET video_count = ' +
				'(SELECT COUNT(*) FROM videos WHERE videos.channel_id = channels.id)'
		)
		.run();
	const pruned = deadVideos.length;
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
	const topDirs = (await fsp.readdir(lib.root, { withFileTypes: true }))
		.filter((e) => e.isDirectory() && !excluded.has(e.name))
		.map((e) => e.name)
		.sort();

	for (const cid of topDirs) {
		const channelDir = path.join(lib.root, cid);
		const poster = await firstExisting(channelDir, POSTER_NAMES);
		const fanart = await firstExisting(channelDir, FANART_NAMES);
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
		ctx.stubChannel.run({ id: cid, kind: 'channel', lib: lib.id, poster: posterRel, fanart: fanartRel, genres: null });
		ctx.markSeen.run(cid, Date.now());
		if (isNewChannel) applyNewChannelDefault(cid, lib.newPrivate);

		for await (const infoPath of walkInfo(channelDir)) {
			let mtime: number;
			try {
				mtime = (await fsp.stat(infoPath)).mtimeMs / 1000;
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
				const media = await firstExisting(parent, MEDIA_EXTS.map((e) => base + e));
				if (media) {
					let info: Record<string, unknown> | null = null;
					try {
						info = JSON.parse(await fsp.readFile(infoPath, 'utf-8'));
					} catch {
						info = null;
					}
					if (info) {
						const thumb = await findThumb(parent, base, path.basename(media));
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
				ctx.onBatch(lib);
				await tick();
			}
		}
		if (batch.length) ctx.upsertBatch(batch);
		if (foundAny) {
			ctx.seenChannels.add(cid);
			if (enriched) {
				ctx.enrichChannel.run({
					id: cid, name, kind: 'channel', lib: lib.id, yt: ytId, url, fc: followers, poster: posterRel, fanart: fanartRel, genres: null
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
	const showDirs = (await fsp.readdir(lib.root, { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();

	for (const showName of showDirs) {
		const showDir = path.join(lib.root, showName);
		const seriesId = 'series:' + showName; // namespaced so it can't collide with a channel id
		const poster = await firstExisting(showDir, POSTER_NAMES);
		const fanart = await firstExisting(showDir, FANART_NAMES);
		const posterRel = poster ? rel(poster) : null;
		const fanartRel = fanart ? rel(fanart) : null;

		// tvshow.nfo (optional) gives the display name + the show's <genre> list; else the folder name.
		let name = showName;
		let showGenres: string | null = null;
		const showNfo = path.join(showDir, 'tvshow.nfo');
		if (await isFile(showNfo)) {
			try {
				const xml = await fsp.readFile(showNfo, 'utf-8');
				name = xmlTag(xml, 'title') ?? showName;
				// Genres live on the CHANNEL (the show) for the shows-grid filter — never exploded onto
				// episodes, which would flood /tag pages with every episode of every drama.
				const g = xmlTags(xml, 'genre');
				showGenres = g.length ? JSON.stringify(g) : null;
			} catch {
				/* keep folder name */
			}
		}

		// Same durable "new" check as indexChannels — never the disposable index.
		const isNew = !ctx.wasSeenBefore.get(seriesId);
		ctx.stubChannel.run({ id: seriesId, kind: 'series', lib: lib.id, poster: posterRel, fanart: fanartRel, genres: showGenres });
		ctx.markSeen.run(seriesId, Date.now());
		if (isNew) applyNewChannelDefault(seriesId, lib.newPrivate);

		let foundAny = false;
		let batch: Row[] = [];

		for await (const media of walkMedia(showDir)) {
			const parent = path.dirname(media);
			const base = path.parse(media).name;
			const nfoPath = path.join(parent, base + NFO_SUFFIX);
			const hasNfo = await isFile(nfoPath);
			const sidecar = hasNfo ? nfoPath : media; // what we track for the incremental mtime skip

			let mtime: number;
			try {
				mtime = (await fsp.stat(sidecar)).mtimeMs / 1000;
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
						meta = parseEpisodeNfo(await fsp.readFile(nfoPath, 'utf-8'));
					} catch {
						meta = null;
					}
				}
				const fname = parseEpisodeFilename(base);
				const thumb = await findThumb(parent, base, path.basename(media));
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
				ctx.onBatch(lib);
				await tick();
			}
		}
		if (batch.length) ctx.upsertBatch(batch);
		if (foundAny) {
			ctx.seenChannels.add(seriesId);
			ctx.enrichChannel.run({
				id: seriesId, name, kind: 'series', lib: lib.id, yt: null, url: null, fc: null, poster: posterRel, fanart: fanartRel, genres: showGenres
			});
		}
		await tick();
	}
}

/**
 * Movies library: ONE synthetic channel (`kind='movies'`, named after the library) holds every movie —
 * a movies library IS the collection, so it gets a poster wall, not a channels page. Each immediate
 * subdir is a movie folder (Radarr layout: main file + `movie.nfo`/`<base>.nfo` + poster/fanart);
 * loose media files in the library root count too. Extras/ subfolders and `-trailer`/`-sample`
 * files are deliberately skipped. Ids prefer tmdb/imdb uniqueids (stable across moves/renames; two
 * copies of the same movie collide last-scanned-wins, same rule as tvdb episodes) else the path hash.
 */
async function indexMovies(lib: Library, ctx: ScanCtx): Promise<void> {
	// Keyed on the library ROW id (stable across folder renames/moves — watch state survives them).
	const chanId = 'movies:' + lib.id;

	// Same durable "new" check as the other formats — never the disposable index.
	const isNew = !ctx.wasSeenBefore.get(chanId);
	ctx.stubChannel.run({ id: chanId, kind: 'movies', lib: lib.id, poster: null, fanart: null, genres: null });
	ctx.markSeen.run(chanId, Date.now());
	if (isNew) applyNewChannelDefault(chanId, lib.newPrivate);

	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(lib.root, { withFileTypes: true });
	} catch {
		return;
	}
	const movieDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
	const looseFiles = entries
		.filter((e) => e.isFile() && MEDIA_EXTS.includes(path.extname(e.name).toLowerCase()))
		.map((e) => e.name)
		.sort();

	let foundAny = false;
	let batch: Row[] = [];

	const one = async (dir: string, media: string, genericArtOk: boolean): Promise<void> => {
		const base = path.parse(media).name;
		const nfoPath = await firstExisting(dir, [MOVIE_NFO, base + NFO_SUFFIX]);
		const sidecar = nfoPath ?? media; // what we track for the incremental mtime skip
		let mtime: number;
		let mediaMtimeS: number;
		try {
			mtime = (await fsp.stat(sidecar)).mtimeMs / 1000;
			mediaMtimeS = (await fsp.stat(media)).mtimeMs / 1000;
		} catch {
			return;
		}
		const relSidecar = rel(sidecar);
		const cached = ctx.existing.get(relSidecar);
		if (!ctx.full && cached && cached.mtime === mtime) {
			ctx.seenVideos.add(cached.id);
			foundAny = true;
		} else {
			let meta: MovieMeta | null = null;
			if (nfoPath) {
				try {
					meta = parseMovieNfo(await fsp.readFile(nfoPath, 'utf-8'));
				} catch {
					meta = null;
				}
			}
			const fname = parseMovieFilename(base);
			const art = await movieArt(dir, base, genericArtOk);
			const id = meta?.tmdbId
				? 'tmdb-' + meta.tmdbId
				: meta?.imdbId
					? 'imdb-' + meta.imdbId
					: pathId(rel(media));
			// Durable dateAdded: record on first sight (seed = the media file's mtime — best backfill
			// estimate), then always read the FROZEN value back for the feed/"added" ordering.
			ctx.markVideoSeen.run(id, Math.trunc(mediaMtimeS * 1000));
			const addedSec = ((ctx.getVideoSeen.get(id) as { t: number } | undefined)?.t ?? mediaMtimeS * 1000) / 1000;
			batch.push(buildMovieRow(meta, fname, id, chanId, media, addedSec, art, sidecar, mtime));
			ctx.seenVideos.add(id);
			ctx.counters.indexed++;
			foundAny = true;
		}
		if (++ctx.counters.processed % BATCH === 0) {
			if (batch.length) {
				ctx.upsertBatch(batch);
				batch = [];
			}
			ctx.onBatch(lib);
			await tick();
		}
	};

	for (const dirName of movieDirs) {
		const dir = path.join(lib.root, dirName);
		const media = await mainFeature(dir);
		if (media) await one(dir, media, true);
	}
	for (const f of looseFiles) {
		if (NON_FEATURE.test(path.parse(f).name)) continue;
		// Library-ROOT files: only `<base>-poster` style art may attach (a folder-level poster.jpg
		// here would wrongly claim every loose movie).
		await one(lib.root, path.join(lib.root, f), false);
	}

	if (batch.length) ctx.upsertBatch(batch);
	if (foundAny) {
		ctx.seenChannels.add(chanId);
		// The wall's genre chips: the DISTINCT union of its movies' visible genres, read back from the
		// just-flushed index (authoritative even on incremental scans, where re-parsing touched only
		// some files — a Set built while walking would overwrite the full list with a partial one).
		// Namespaced person:/set: relatedness entries are excluded.
		const genreRows = db()
			.prepare(
				`SELECT DISTINCT value AS g FROM videos v, json_each(v.tags)
				 WHERE v.channel_id = ? AND value NOT LIKE 'person:%' AND value NOT LIKE 'set:%'
				 ORDER BY value COLLATE NOCASE`
			)
			.all(chanId) as { g: string }[];
		ctx.enrichChannel.run({
			id: chanId, name: lib.name, kind: 'movies', lib: lib.id, yt: null, url: null, fc: null, poster: null, fanart: null,
			genres: genreRows.length ? JSON.stringify(genreRows.map((r) => r.g)) : null
		});
	}
	await tick();
}

// --- scan orchestration: a lock + last-run state for status + auto-rescan ------

let _scanning = false;
let _last: ScanStats | null = null;
let _lastError: string | null = null;
let _progress: ScanProgress | null = null;
/** Latched rerun: a runScan that collides with a running scan queues EXACTLY ONE follow-up (full
 *  flags OR-ed) instead of being silently dropped — otherwise adding several libraries in quick
 *  succession indexed only the first (each add fires a background rescan; the rest hit the lock and
 *  vanished, leaving the LAST-added library invisible until the interval rescan). */
let _pendingFull: boolean | null = null;
/** Monotonic count of completed scans that CHANGED something (indexed or pruned > 0) — clients
 *  invalidate their cached loads when it moves, catching even scans too fast for their poll to see
 *  in the `scanning` flag. */
let _seq = 0;

export interface ScanStatus {
	scanning: boolean;
	everScanned: boolean;
	error: string | null;
	/** Live progress while `scanning`, null otherwise — see ScanProgress. */
	progress: ScanProgress | null;
	/** Bumped by every completed scan that changed the index — see _seq. */
	seq: number;
	last: ScanStats | null;
}

export function scanStatus(): ScanStatus {
	return {
		scanning: _scanning,
		everScanned: _last !== null,
		error: _lastError,
		progress: _scanning ? _progress : null,
		seq: _seq,
		last: _last
	};
}

/** WS-I scan-time prebake: derive the card-size variants (thumb 480 / poster 320, the sizes the web
 *  and phone grids request) for everything indexed, SEQUENTIALLY through the bounded resize pipeline
 *  — so the warmer holds at most one slot and live requests always have capacity. Fire-and-forget
 *  after a scan that parsed anything; hits are single stat()s, failures fall back to originals. */
async function warmImageCache(): Promise<void> {
	const videos = db()
		.prepare('SELECT thumb_path, poster_path FROM videos')
		.all() as { thumb_path: string | null; poster_path: string | null }[];
	const channels = db()
		.prepare('SELECT poster_path FROM channels')
		.all() as { poster_path: string | null }[];
	const jobs: [string | null, number][] = [
		...videos.flatMap((v): [string | null, number][] => [[v.thumb_path, 480], [v.poster_path, 320]]),
		...channels.map((c): [string | null, number] => [c.poster_path, 320])
	];
	const start = Date.now();
	let ensured = 0;
	for (const [rel, width] of jobs) {
		if (!rel) continue;
		try {
			const { absPath, stat } = await resolveInMediaRoot(rel);
			await warmImage(absPath, stat, width);
			ensured++;
		} catch {
			/* source vanished/unreadable — the image routes fall back to the original (or 404) anyway */
		}
	}
	if (ensured > 0) {
		console.log(
			`[mytview] prebake: image variants ensured for ${ensured} sources in ${Math.round((Date.now() - start) / 100) / 10}s`
		);
	}
}

/** Run a scan unless one is already in progress — in which case a single follow-up is QUEUED (see
 *  _pendingFull) and null returns immediately. Returns stats, or null if queued/failed. */
export async function runScan(full = false): Promise<ScanStats | null> {
	if (_scanning) {
		_pendingFull = (_pendingFull ?? false) || full;
		console.log('[mytview] scan: requested while one is running — queued a follow-up');
		return null;
	}
	_scanning = true;
	try {
		_last = await scan(full);
		_lastError = null;
		if (_last.indexed > 0 || _last.pruned > 0) _seq++;
		console.log(
			`[mytview] scan: done — ${_last.videos} videos (${_last.indexed} parsed, ${_last.pruned} pruned)` +
				`${_last.pruneSkipped ? ' [prune SKIPPED — safety valve]' : ''} in ${_last.elapsed_s}s`
		);
		// Prebake image variants only when the scan actually (re)parsed something — an idle interval
		// rescan (indexed 0) skips even the stat sweep.
		if (_last.indexed > 0) void warmImageCache();
		return _last;
	} catch (e) {
		_lastError = (e as Error).message;
		console.error('[mytview] scan failed:', _lastError);
		return null;
	} finally {
		_scanning = false;
		_progress = null;
		if (_pendingFull != null) {
			const f = _pendingFull;
			_pendingFull = null;
			console.log(`[mytview] scan: running the queued follow-up${f ? ' (full)' : ''}`);
			void runScan(f);
		}
	}
}
