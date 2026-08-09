/**
 * Durable state DB — users, sessions, and per-user watch state.
 *
 * Kept SEPARATE from the disposable index (which is rebuilt/deleted on scan) and,
 * per the hard rule, never written under MEDIA_ROOT. Lives next to the index db
 * (so on the container it's on the writable /data volume) but survives rescans.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { DB_PATH } from './config';

const STATE_PATH = path.join(path.dirname(DB_PATH), 'state.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_state (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id   TEXT NOT NULL,
    position   REAL NOT NULL DEFAULT 0,     -- resume point, seconds
    watched    INTEGER NOT NULL DEFAULT 0,  -- 0/1
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_state(user_id);

CREATE TABLE IF NOT EXISTS invites (
    token      TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at    INTEGER
);

-- OAuth-style device pairing: a TV requests a code, the user approves it on their
-- phone at /link, then the TV polls with its secret device_code to collect a token.
CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,          -- long secret the TV polls with
    user_code   TEXT NOT NULL UNIQUE,      -- short human code shown on the TV
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- null until approved
    approved_at INTEGER,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);

-- Public per-video share links: unguessable token grants account-less access to ONE video,
-- with an owner-chosen expiry (expires_at, NULL = never) and optional view cap (max_uses,
-- NULL = unlimited; used_count is bumped once per new viewer).
CREATE TABLE IF NOT EXISTS shares (
    token      TEXT PRIMARY KEY,
    video_id   TEXT NOT NULL,             -- id in the (separate) index db; no cross-db FK
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_uses   INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(created_by);

-- Channel visibility (owner-controlled). A row with private=1 hides the channel from every
-- account EXCEPT the owner and users explicitly granted it (channel_grants). No row = public
-- (the default), so existing installs are unchanged until the owner marks something private.
-- channel_id is the id in the (separate) index db — no cross-db FK, same as watch_state/shares.
CREATE TABLE IF NOT EXISTS channel_visibility (
    channel_id TEXT PRIMARY KEY,
    private    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

-- Per-user grants for PRIVATE channels: which non-owner accounts may see a given private channel.
CREATE TABLE IF NOT EXISTS channel_grants (
    channel_id TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_grants_user ON channel_grants(user_id);

-- Per-user feed preference: channels the user has hidden / unsubscribed from THEIR OWN feed. This
-- is a personal filter only — NOT access control; the user can still open a hidden channel directly.
CREATE TABLE IF NOT EXISTS user_hidden_channels (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);

-- Small durable key/value for server-generated secrets that must survive restarts but need no
-- config (e.g. the HMAC secret that signs media/image URLs for native players — see mediaToken.ts).
CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Every channel/series id the indexer has EVER seen, durably. "Is this channel new?" must NOT be
-- answered from the disposable index (deleting index.db is a documented-safe op): if it were, a
-- rebuild would make every channel "new" again and re-apply the library's visibility default,
-- silently overriding owner choices (a channel the owner opened up on a private-default library
-- would flip back to private). Rows are never pruned — a channel that vanishes and returns keeps
-- its history (and its channel_visibility row, which is likewise never GC'd). Seeded from a
-- pre-existing index.db on first boot after upgrade (db.ts). See indexer.ts / visibility.ts.
CREATE TABLE IF NOT EXISTS channels_seen (
    channel_id    TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL
);

-- DURABLE "entered the library" timestamps (ms) — the Plex-style dateAdded. Written once per video
-- id (INSERT OR IGNORE) when the indexer first sees it, seeded from the file's mtime as the best
-- backfill estimate, then FROZEN: index rebuilds, file moves, quality upgrades (same tmdb id), and
-- mtime-rewriting tools (a touched file, Radarr's Change File Date, rsync) can never churn it.
-- Currently drives the movies "recently added" ordering (videos.timestamp for movie rows).
CREATE TABLE IF NOT EXISTS videos_seen (
    video_id      TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL
);

-- Short-lived, single-use codes that hand a signed-in NATIVE client off to a WEB session (the
-- owner-admin punch-out): the app mints a code over its bearer API, opens /link/web?code=…, and the
-- in-app browser trades it for a session cookie. 60s TTL, deleted on redeem — see auth.ts.
CREATE TABLE IF NOT EXISTS web_login_codes (
    code       TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Per-user client preferences (autoplay-next, still-watching cadence). Server-owned so every client
-- shares ONE set of defaults and the values sync across a user's devices — see prefs.ts. A missing row
-- means "server defaults"; the DEFAULT clauses here match prefs.ts DEFAULT_PREFS.
CREATE TABLE IF NOT EXISTS user_prefs (
    user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    autoplay_next        INTEGER NOT NULL DEFAULT 1,
    still_watching_after INTEGER NOT NULL DEFAULT 3
);

-- Owner-generated single-use password-reset links (we track no email, so an owner hands the user a
-- link out-of-band; they open it logged-out at /reset and set their own password). Single-use
-- (used_at) + expiring (expires_at); redeeming also revokes the target's existing sessions — see auth.ts.
CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- Owner-configured media libraries (managed at /admin/libraries). Each is a subfolder of MEDIA_ROOT
-- with a format (channels | series | movies) and a default visibility for newly-seen items. Durable
-- (survives rescans). An EMPTY table means NOTHING is indexed (explicit-only since 2026-08-09 — the
-- old implicit whole-root default is gone; libraries.ts header). path is UNIQUE (one per folder).
CREATE TABLE IF NOT EXISTS libraries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,       -- MEDIA_ROOT-relative subfolder ('' = the root itself)
    format      TEXT NOT NULL,              -- 'channels' | 'series' | 'movies'
    new_private INTEGER NOT NULL DEFAULT 0, -- newly-seen channels/shows here default to private?
    show_in_recent INTEGER NOT NULL DEFAULT 1, -- 0 = this library's items stay OUT of the Recent feed (collections)
    sort_order  INTEGER,                    -- owner-defined display order (nav tabs, pickers, TV tab promotion)
    created_at  INTEGER NOT NULL
);
`;

let _state: Database.Database | null = null;

export function stateDb(): Database.Database {
	if (_state) return _state;
	const d = new Database(STATE_PATH);
	d.pragma('journal_mode = WAL');
	d.pragma('foreign_keys = ON');
	d.exec(SCHEMA);
	// Column migrations for tables that predate a field (CREATE IF NOT EXISTS can't add columns).
	// Session device label + last-seen power the "manage your logged-in devices" list (auth.ts).
	addColumnIfMissing(d, 'sessions', 'last_seen', 'INTEGER');
	addColumnIfMissing(d, 'sessions', 'label', 'TEXT');
	// Sessions created before last_seen existed have NULL — seed them from created_at so the
	// manage-devices list shows a real time (not "unknown"); touchSession keeps it fresh afterward.
	d.exec('UPDATE sessions SET last_seen = created_at WHERE last_seen IS NULL');
	// Account deactivation (owner can suspend a login without deleting its watch state). NULL = active;
	// a timestamp = suspended. Login is rejected while set; see auth.ts and the login routes.
	addColumnIfMissing(d, 'users', 'deactivated_at', 'INTEGER');
	// Per-library feed opt-out (owner): 0 keeps the library's items out of Recent — a collection you
	// browse deliberately (movies archive) rather than a feed. Gates ONLY the feed (queries.listVideos);
	// search/tags/library pages are untouched. Default 1 = current behavior.
	addColumnIfMissing(d, 'libraries', 'show_in_recent', 'INTEGER NOT NULL DEFAULT 1');
	// Owner-defined library display order (/admin/libraries ↑↓). Backfill pre-existing rows with their
	// id (== the old resolveLibraries order) so a migrated deploy keeps its scan order; the previously
	// name-sorted nav simply becomes explicit. Idempotent — only NULLs are touched.
	addColumnIfMissing(d, 'libraries', 'sort_order', 'INTEGER');
	d.exec('UPDATE libraries SET sort_order = id WHERE sort_order IS NULL');
	_state = d;
	return _state;
}

/** Idempotent `ALTER TABLE … ADD COLUMN` — SQLite has no `ADD COLUMN IF NOT EXISTS`, so gate on
 *  the current column list. Safe to run on every boot. */
function addColumnIfMissing(d: Database.Database, table: string, column: string, decl: string): void {
	const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	if (!cols.some((c) => c.name === column)) {
		d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
	}
}

export { STATE_PATH as STATE_DB_PATH };
