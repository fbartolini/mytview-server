/** Read queries over the SQLite index. Shared by API endpoints and page loads. */
import { db } from './db';
import { visibilityClause, canSeeChannel, notHiddenClause } from './visibility';
import type { ChannelSummary, ChannelDetail, VideoSummary, VideoDetail } from '$lib/types';

type VideoRow = Omit<VideoSummary, 'watched'> & { watched: number; position: number };
const toSummary = (r: VideoRow): VideoSummary => ({ ...r, watched: !!r.watched });

/** Grid sort. Default 'name' is the shared/contract order every client renders; the others are a
 *  user-chosen re-sort (presentation preference, web-only for now). */
export type ChannelSort = 'name' | 'updated' | 'unwatched';

export function listChannels(
	user: { id: number } | null,
	libraryId: number | null = null,
	sort: ChannelSort = 'name'
): ChannelSummary[] {
	// libraryId is an integer we've already validated at the route; inline it (it's not user text).
	const libClause = libraryId != null ? ` AND library_id = ${Math.trunc(libraryId)}` : '';
	// Per-user unwatched count (items not marked watched) → an unread-style badge. uid is inlined the
	// same way visibilityClause does (this query takes no bind params). NULL user → 0 (routes require auth).
	const uid = user ? Math.trunc(user.id) : 0;
	const unwatched = `(
			SELECT COUNT(*) FROM videos v
			WHERE v.channel_id = channels.id
			  AND NOT EXISTS (
			    SELECT 1 FROM state.watch_state w
			    WHERE w.user_id = ${uid} AND w.video_id = v.id AND w.watched = 1
			  )
		)`;
	// 'updated' = newest item/episode first (SQLite sorts NULL timestamps last under DESC); ties + the
	// other sorts fall back to name. 'unwatched' references the SELECT alias below.
	const orderBy =
		sort === 'updated'
			? '(SELECT MAX(timestamp) FROM videos WHERE channel_id = channels.id) DESC, name COLLATE NOCASE'
			: sort === 'unwatched'
				? 'unwatched DESC, name COLLATE NOCASE'
				: 'name COLLATE NOCASE';
	return db()
		.prepare(
			`SELECT id, name, kind, library_id, yt_channel_id, url, follower_count, poster_path, fanart_path, video_count,
			        ${unwatched} AS unwatched
			 FROM channels WHERE ${visibilityClause(user, 'id')}${libClause} ORDER BY ${orderBy}`
		)
		.all() as ChannelSummary[];
}

/** Library ids this user can see actual media in — ≥1 channel/series visible to them AND holding videos
 *  (video_count > 0, i.e. total, so a fully-*watched* library still counts). Drives hiding an all-private
 *  or empty library from the nav entirely. Empty set for a null user (routes require auth). */
export function visibleLibraryIds(user: { id: number } | null): Set<number> {
	if (!user) return new Set();
	const rows = db()
		.prepare(
			`SELECT DISTINCT library_id AS id FROM channels
			 WHERE library_id IS NOT NULL AND video_count > 0 AND ${visibilityClause(user, 'id')}`
		)
		.all() as { id: number }[];
	return new Set(rows.map((r) => r.id));
}

/** Library totals a given user is allowed to SEE (visibility-filtered, so private channels don't leak
 *  into the counts). Shared by /api/status and /api/v1/status so web + native agree. */
export function libraryCounts(user: { id: number } | null): { videos: number; channels: number } {
	const videos = (
		db()
			.prepare(`SELECT COUNT(*) AS c FROM videos v WHERE ${visibilityClause(user, 'v.channel_id')}`)
			.get() as { c: number }
	).c;
	const channels = (
		db()
			.prepare(`SELECT COUNT(*) AS c FROM channels WHERE ${visibilityClause(user, 'id')}`)
			.get() as { c: number }
	).c;
	return { videos, channels };
}

export function getChannel(id: string, userId: number, showWatched = false): ChannelDetail | null {
	const channel = db().prepare('SELECT * FROM channels WHERE id = ?').get(id) as
		| ChannelSummary
		| undefined;
	if (!channel) return null;
	if (!canSeeChannel({ id: userId }, id)) return null; // private + not granted → treat as absent
	const videos = db()
		.prepare(
			`SELECT v.id, v.title, v.channel_id, v.season_number, v.episode_number, v.upload_date, v.timestamp, v.duration, v.view_count, v.thumb_path,
			        COALESCE(w.watched, 0) AS watched, COALESCE(w.position, 0) AS position
			 FROM videos v
			 LEFT JOIN state.watch_state w ON w.video_id = v.id AND w.user_id = @uid
			 WHERE v.channel_id = @cid AND (@showAll = 1 OR COALESCE(w.watched, 0) = 0)
			 ORDER BY v.season_number ASC NULLS LAST, v.episode_number ASC NULLS LAST, v.timestamp DESC NULLS LAST, v.upload_date DESC`
		)
		.all({ uid: userId, cid: id, showAll: channel.kind === 'series' || showWatched ? 1 : 0 }) as VideoRow[];
	return { channel, videos: videos.map(toSummary) };
}

/** The next episode to play in a series: the first not-fully-watched episode in season/episode order
 *  (a mid-progress episode still counts, since its watched flag stays 0). Null when all are watched.
 *  Server-owned so "continue watching" is identical on every client. */
export function nextEpisode(seriesId: string, userId: number): VideoSummary | null {
	const row = db()
		.prepare(
			`SELECT v.id, v.title, v.channel_id, v.season_number, v.episode_number, v.upload_date, v.timestamp, v.duration, v.view_count, v.thumb_path,
			        COALESCE(w.watched, 0) AS watched, COALESCE(w.position, 0) AS position
			 FROM videos v
			 LEFT JOIN state.watch_state w ON w.video_id = v.id AND w.user_id = @uid
			 WHERE v.channel_id = @sid AND COALESCE(w.watched, 0) = 0
			 ORDER BY v.season_number ASC NULLS LAST, v.episode_number ASC NULLS LAST, v.timestamp ASC
			 LIMIT 1`
		)
		.get({ uid: userId, sid: seriesId }) as VideoRow | undefined;
	return row ? toSummary(row) : null;
}

export interface VideoQuery {
	limit?: number;
	offset?: number;
	q?: string | null;
	tag?: string | null;
	userId: number;
	showWatched?: boolean;
}

export function listVideos({
	limit = 60,
	offset = 0,
	q = null,
	tag = null,
	userId,
	showWatched = false
}: VideoQuery): VideoSummary[] {
	const rows = db()
		.prepare(
			`SELECT v.id, v.title, v.channel_id, c.name AS channel_name, v.season_number, v.episode_number,
			        v.upload_date, v.timestamp, v.duration, v.view_count, v.thumb_path,
			        COALESCE(w.watched, 0) AS watched, COALESCE(w.position, 0) AS position
			 FROM videos v
			 JOIN channels c ON c.id = v.channel_id
			 LEFT JOIN state.watch_state w ON w.video_id = v.id AND w.user_id = @uid
			 WHERE (@q IS NULL OR v.title LIKE @q)
			   AND (@tag IS NULL OR v.id IN (SELECT video_id FROM video_tags WHERE tag = @tag))
			   AND (@showWatched = 1 OR COALESCE(w.watched, 0) = 0)
			   AND ${visibilityClause({ id: userId }, 'v.channel_id')}
			   AND ${notHiddenClause(userId, 'v.channel_id')}
			 ORDER BY v.timestamp DESC NULLS LAST, v.upload_date DESC
			 LIMIT @limit OFFSET @offset`
		)
		.all({
			uid: userId,
			q: q ? `%${q}%` : null,
			tag: tag ?? null,
			showWatched: showWatched ? 1 : 0,
			limit,
			offset
		}) as VideoRow[];
	return rows.map(toSummary);
}

// True when a video plays on restrictive native clients (tvOS AVPlayer, Tizen AVPlay, ExoPlayer)
// without transcoding. Defined by EXCLUDING the known incompatible residue rather than whitelisting
// H.264/AAC (a whitelist wrongly gated HEVC + unlabeled-audio files behind "transcode"). Residue:
//   video — VP8/VP9/AV1. Each in BOTH stored forms: the info.json raw ids ('vp08…'/'vp09…'/'av01…')
//           AND the NFO-normalized ids ('vp8'/'vp9'/'av1' — indexer.ts V_CODEC maps 'av01'→'av1' etc.,
//           so 'av01%' alone missed AV1-from-.nfo, advertising it direct-play with no fallback).
//   audio — Opus, the Dolby/DTS family (AC-3, E-AC-3, DTS/DCA, TrueHD), and Vorbis — none of which every
//           native target decodes (AVPlayer has no DTS/TrueHD/Vorbis; the family is a real Sonarr reality).
// HEVC stays direct-play (AVPlayer/ExoPlayer/Tizen decode it) and unknown/exotic codecs fail OPEN — and
// since the /api/v1 descriptor now ships hlsUrl for EVERY id (a universal live-HLS fallback), a real decode
// failure on any of those (a mislabeled codec, or HEVC on a chip that lacks it) still has a backstop.
// Single source of truth shared by directPlayMap AND NEEDS_COMPAT_SQL, so they never disagree.
export const DIRECT_PLAY_SQL = `(vcodec IS NULL OR (vcodec NOT LIKE 'vp8%' AND vcodec NOT LIKE 'vp08%' AND vcodec NOT LIKE 'vp9%' AND vcodec NOT LIKE 'vp09%' AND vcodec NOT LIKE 'av1%' AND vcodec NOT LIKE 'av01%')) AND (acodec IS NULL OR (acodec NOT LIKE 'opus%' AND acodec NOT LIKE 'ac3%' AND acodec NOT LIKE 'eac3%' AND acodec NOT LIKE 'dts%' AND acodec NOT LIKE 'dca%' AND acodec NOT LIKE 'truehd%' AND acodec NOT LIKE 'vorbis%'))`;

// Which videos CAN'T be handed to every client as-is: the codec residue above, OR a Matroska (.mkv)
// container — which Chrome (web) and AVPlayer (iOS/tvOS) can't demux at all, whatever codec is inside.
// Drives the playback descriptor's `kind` hint (and used to gate the removed whole-file transcoder);
// the per-client directPlay HINT stays codec-only (clients fail-open on the container).
export const NEEDS_COMPAT_SQL = `((NOT (${DIRECT_PLAY_SQL})) OR video_path LIKE '%.mkv')`;

/** True when this video is a Matroska (.mkv). The web <video> (Chrome) can't reliably demux mkv — it
 *  may play the H.264 video while silently dropping E-AC3 audio, with NO MediaError to trigger fail-open
 *  — so the web player starts on live HLS instead of the original. (Codec residue like vp9/opus is
 *  different: Chrome plays it, so that path stays fail-open.) */
export function isMatroska(id: string): boolean {
	return !!db().prepare(`SELECT 1 FROM videos WHERE id = ? AND video_path LIKE '%.mkv'`).get(id);
}

// Audio codecs the web <video> (Chrome) can't decode — it plays the VIDEO but silently drops AUDIO with
// NO MediaError, so fail-open can't rescue them (same trap as .mkv). The Dolby/DTS family. Vorbis/Opus/
// AAC/MP3/FLAC all decode on Chrome, so they stay fail-open on the web even though some are native residue.
const WEB_SILENT_AUDIO_SQL = `(acodec LIKE 'ac3%' OR acodec LIKE 'eac3%' OR acodec LIKE 'dts%' OR acodec LIKE 'dca%' OR acodec LIKE 'truehd%')`;

/** Should the WEB player START on live HLS instead of fail-open on the original? True for a Matroska
 *  container OR a Chrome-silent audio codec — both play the video while silently dropping audio with no
 *  MediaError, so attempting the original first would leave the viewer with silent playback and nothing
 *  to trigger the fallback. (Native clients don't need this — AVPlayer/ExoPlayer surface a real error
 *  and fail-open to the universal hlsUrl.) */
export function webPrefersCompat(id: string): boolean {
	return !!db()
		.prepare(`SELECT 1 FROM videos WHERE id = ? AND (video_path LIKE '%.mkv' OR ${WEB_SILENT_AUDIO_SQL})`)
		.get(id);
}

/** Codec residue OR a Matroska container — i.e. NOT every client can take the original as-is (an .mkv
 *  whose codec is fine still can't be demuxed by AVPlayer/Chrome). Drives the playback descriptor's
 *  `kind` hint; deliberately container-aware, unlike the codec-only directPlay. */
export function needsCompat(id: string): boolean {
	return !!db().prepare(`SELECT 1 FROM videos WHERE id = ? AND ${NEEDS_COMPAT_SQL}`).get(id);
}

export function directPlayMap(ids: string[]): Map<string, boolean> {
	const out = new Map<string, boolean>();
	if (ids.length === 0) return out;
	const placeholders = ids.map(() => '?').join(',');
	const rows = db()
		.prepare(
			`SELECT id, (CASE WHEN ${DIRECT_PLAY_SQL} THEN 1 ELSE 0 END) AS dp
			 FROM videos WHERE id IN (${placeholders})`
		)
		.all(...ids) as { id: string; dp: number }[];
	for (const r of rows) out.set(r.id, !!r.dp);
	return out;
}

// Which of these ids are vertical (portrait: height > width) — so native clients render portrait
// (Shorts-style) cards without each re-deriving it from width/height. Annotated onto the /api/v1
// list results like directPlayMap; the web SSR path is untouched.
export function verticalMap(ids: string[]): Map<string, boolean> {
	const out = new Map<string, boolean>();
	if (ids.length === 0) return out;
	const placeholders = ids.map(() => '?').join(',');
	const rows = db()
		.prepare(
			`SELECT id, (CASE WHEN width > 0 AND height > width THEN 1 ELSE 0 END) AS v
			 FROM videos WHERE id IN (${placeholders})`
		)
		.all(...ids) as { id: string; v: number }[];
	for (const r of rows) out.set(r.id, !!r.v);
	return out;
}

// A video's own channel gets its "related" score scaled by this, so the panel
// isn't just the creator's back-catalogue — but a same-channel video on the
// exact same niche can still win if the shared tag is specific enough. 1 = no
// penalty, 0 = never surface same-channel.
const SAME_CHANNEL_WEIGHT = 0.5;

/**
 * Unwatched videos ranked by how *specifically* they share tags with the given
 * one (excludes itself). Each shared tag is weighted by inverse document
 * frequency (1/df) — df being how many library videos carry it — so generic
 * tags a creator stuffs in ("vlog", "2024", their own channel name) count for
 * almost nothing while rare, topical tags dominate. Same-channel candidates are
 * softly penalised (see SAME_CHANNEL_WEIGHT). Runs against the indexed `video_tags`
 * table (not `json_each` over every row), so it stays sub-millisecond even on a large
 * library — the json_each version was ~5s per call on 1,735 videos and, being a
 * synchronous better-sqlite3 query, froze the whole event loop each time.
 */
export function relatedVideos(videoId: string, userId: number, limit = 8): VideoSummary[] {
	// A series episode continues the show: "related" is the rest of the series in running order (next
	// episode first) and NOTHING else — no unrelated fill — so the rail and autoplay-next stay on the
	// show and simply stop after the finale (returns [] on the last episode). The descending recent-
	// unwatched top-up below is ONLY for untagged channel videos, never for series.
	const series = seriesRelated(videoId, userId, limit);
	if (series !== null) return series;
	// Non-series: tag-overlap, topped up with recent unwatched (feed order) so autoplay never dead-ends
	// on a video whose creator added no tags.
	const related = tagRelated(videoId, userId, limit);
	if (related.length >= limit) return related;
	const have = new Set(related.map((r) => r.id));
	have.add(videoId);
	const fill = listVideos({ limit: limit + have.size, offset: 0, userId })
		.filter((v) => !have.has(v.id))
		.slice(0, limit - related.length);
	return [...related, ...fill];
}

/** Next episodes in the same series, in running order (season/episode) strictly after this one — so a
 *  series episode's Related/up-next continues the show. Returns null when the video isn't a series
 *  episode (→ caller falls back to tag-based related); [] when it's the last episode (→ top-up). */
function seriesRelated(videoId: string, userId: number, limit: number): VideoSummary[] | null {
	const cur = db()
		.prepare(
			`SELECT v.channel_id AS sid, v.season_number AS s, v.episode_number AS e, c.kind
			 FROM videos v JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`
		)
		.get(videoId) as { sid: string; s: number | null; e: number | null; kind: string } | undefined;
	if (!cur || cur.kind !== 'series') return null;
	const rows = db()
		.prepare(
			`SELECT v.id, v.title, v.channel_id, c.name AS channel_name, v.season_number, v.episode_number,
			        v.upload_date, v.timestamp, v.duration, v.view_count, v.thumb_path,
			        COALESCE(w.watched, 0) AS watched, COALESCE(w.position, 0) AS position
			 FROM videos v
			 JOIN channels c ON c.id = v.channel_id
			 LEFT JOIN state.watch_state w ON w.video_id = v.id AND w.user_id = @uid
			 WHERE v.channel_id = @sid AND v.id != @id
			   AND (v.season_number > @s OR (v.season_number = @s AND v.episode_number > @e))
			 ORDER BY v.season_number ASC NULLS LAST, v.episode_number ASC NULLS LAST, v.timestamp ASC
			 LIMIT @limit`
		)
		.all({ uid: userId, sid: cur.sid, id: videoId, s: cur.s, e: cur.e, limit }) as VideoRow[];
	return rows.map(toSummary);
}

function tagRelated(videoId: string, userId: number, limit: number): VideoSummary[] {
	const row = db().prepare('SELECT tags, channel_id FROM videos WHERE id = ?').get(videoId) as
		| { tags: string; channel_id: string }
		| undefined;
	if (!row) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.tags || '[]');
	} catch {
		parsed = [];
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return [];

	const rows = db()
		.prepare(
			`WITH src(tag) AS (SELECT value FROM json_each(@tags)),
			      df(tag, n) AS (
			        SELECT tag, COUNT(DISTINCT video_id) AS n
			        FROM video_tags
			        WHERE tag IN (SELECT tag FROM src)
			        GROUP BY tag
			      )
			 SELECT v.id, v.title, v.channel_id, c.name AS channel_name, v.season_number, v.episode_number,
			        v.upload_date, v.timestamp, v.duration, v.view_count, v.thumb_path,
			        COALESCE(w.watched, 0) AS watched, COALESCE(w.position, 0) AS position
			 FROM video_tags vt
			 JOIN df ON df.tag = vt.tag
			 JOIN videos v ON v.id = vt.video_id
			 JOIN channels c ON c.id = v.channel_id
			 LEFT JOIN state.watch_state w ON w.video_id = v.id AND w.user_id = @uid
			 WHERE vt.video_id != @id AND COALESCE(w.watched, 0) = 0
			   AND ${visibilityClause({ id: userId }, 'v.channel_id')}
			   AND ${notHiddenClause(userId, 'v.channel_id')}
			 GROUP BY v.id
			 ORDER BY SUM(1.0 / df.n) * (CASE WHEN v.channel_id = @channel THEN @samePenalty ELSE 1.0 END) DESC,
			          COUNT(*) DESC, v.timestamp DESC NULLS LAST, v.upload_date DESC
			 LIMIT @limit`
		)
		.all({
			tags: row.tags,
			uid: userId,
			id: videoId,
			channel: row.channel_id,
			samePenalty: SAME_CHANNEL_WEIGHT,
			limit
		}) as VideoRow[];
	return rows.map(toSummary);
}

export function getVideo(id: string): VideoDetail | null {
	const v = db()
		.prepare(
			`SELECT v.*, c.name AS channel_name FROM videos v
			 JOIN channels c ON c.id = v.channel_id WHERE v.id = ?`
		)
		.get(id) as (Record<string, unknown> & { tags?: string; chapters?: string }) | undefined;
	if (!v) return null;
	v.tags = v.tags ? JSON.parse(v.tags) : [];
	v.chapters = v.chapters ? JSON.parse(v.chapters) : [];
	return v as unknown as VideoDetail;
}
