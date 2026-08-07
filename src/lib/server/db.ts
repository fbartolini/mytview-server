/**
 * SQLite connection (singleton) and schema for the disposable index.
 *
 * The durable state db (users/watch) is ATTACHed as `state` so the feed can
 * filter/badge by watch state in a single query. The state db stays a separate
 * file on disk — ATTACH only joins them for querying.
 */
import Database from 'better-sqlite3';
import { DB_PATH } from './config';
import { stateDb, STATE_DB_PATH } from './state';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL DEFAULT 'channel',   -- 'channel' | 'series'
    library_id     INTEGER,                            -- state.db libraries.id; NULL = the default (whole-root) library
    yt_channel_id  TEXT,
    url            TEXT,
    follower_count INTEGER,
    poster_path    TEXT,
    fanart_path    TEXT,
    video_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS videos (
    id           TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    season_number  INTEGER,                            -- series only; NULL for channel videos
    episode_number INTEGER,                            -- series only; NULL for channel videos
    title        TEXT NOT NULL,
    description  TEXT,
    upload_date  TEXT,
    timestamp    INTEGER,
    duration     INTEGER,
    view_count   INTEGER,
    like_count   INTEGER,
    width        INTEGER,
    height       INTEGER,
    fps          REAL,
    vcodec       TEXT,
    acodec       TEXT,
    tags         TEXT,
    chapters     TEXT,
    webpage_url  TEXT,
    video_path   TEXT NOT NULL,
    thumb_path   TEXT,
    info_path    TEXT NOT NULL,
    mtime        REAL NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_videos_ts      ON videos(timestamp DESC);

-- One tag per row, indexed. The feed's tag filter and the "related" ranking used to
-- json_each() over every video's tags on each request (~5s on a real library); this
-- makes those indexed lookups instead. Maintained by the scan; cascade-pruned with videos.
CREATE TABLE IF NOT EXISTS video_tags (
    video_id  TEXT NOT NULL,
    tag       TEXT NOT NULL,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_tags_tag   ON video_tags(tag);
CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id);
`;

function ensureColumn(d: Database.Database, table: string, col: string, decl: string): void {
	const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	if (!cols.some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

let _db: Database.Database | null = null;

export function db(): Database.Database {
	if (_db) return _db;
	const d = new Database(DB_PATH);
	d.pragma('journal_mode = WAL');
	d.pragma('foreign_keys = ON');
	d.exec(SCHEMA);
	// Additive migrations for a pre-existing index.db (CREATE TABLE IF NOT EXISTS can't add columns
	// to an already-created table). index.db is disposable, so this only avoids forcing a full
	// rebuild on upgrade; each call is a no-op once the column exists.
	ensureColumn(d, 'channels', 'kind', "TEXT NOT NULL DEFAULT 'channel'");
	ensureColumn(d, 'channels', 'library_id', 'INTEGER'); // no index over it — filtered lists are small
	ensureColumn(d, 'videos', 'season_number', 'INTEGER');
	ensureColumn(d, 'videos', 'episode_number', 'INTEGER');
	// The season index references the just-migrated columns, so it CANNOT live in SCHEMA (which runs
	// before these ALTERs) — create it here, once the columns exist (fresh via CREATE TABLE, else ALTER).
	d.exec('CREATE INDEX IF NOT EXISTS idx_videos_season ON videos(channel_id, season_number, episode_number)');
	// One-time backfill when video_tags was just added to an existing index.db (empty tag
	// index but populated videos). The scan maintains it incrementally afterwards, so this
	// only pays the json_each cost once, at startup, instead of on every request.
	const counts = d
		.prepare('SELECT (SELECT COUNT(*) FROM videos) AS v, (SELECT COUNT(*) FROM video_tags) AS t')
		.get() as { v: number; t: number };
	if (counts.v > 0 && counts.t === 0) {
		d.exec(
			"INSERT INTO video_tags (video_id, tag) " +
				"SELECT videos.id, value FROM videos, json_each(videos.tags) " +
				"WHERE videos.tags IS NOT NULL AND videos.tags <> '[]'"
		);
	}
	stateDb(); // ensure the durable state schema exists before attaching
	d.exec(`ATTACH DATABASE '${STATE_DB_PATH.replace(/'/g, "''")}' AS state`);
	// Seed channels_seen (durable) from a pre-existing index, so channels indexed by an OLDER
	// version aren't treated as "new" on their next scan — which would re-apply the library's
	// visibility default over the owner's choices (see state.ts / indexer.ts). INSERT OR IGNORE →
	// idempotent every boot; a no-op on fresh installs and once seeded.
	d.exec(
		`INSERT OR IGNORE INTO state.channels_seen (channel_id, first_seen_at) ` +
			`SELECT id, ${Date.now()} FROM channels`
	);
	_db = d;
	return _db;
}
