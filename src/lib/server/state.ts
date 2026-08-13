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
    path        TEXT UNIQUE,                -- MEDIA_ROOT-relative subfolder ('' = the root itself);
                                            -- NULL = VIRTUAL (no local folder — a federation mapping
                                            -- target only; never walked by the scan). Existing dbs are
                                            -- rebuilt to this nullable shape — relaxLibrariesPathNotNull.
    format      TEXT NOT NULL,              -- 'channels' | 'series' | 'movies'
    new_private INTEGER NOT NULL DEFAULT 0, -- newly-seen channels/shows here default to private?
    show_in_recent INTEGER NOT NULL DEFAULT 1, -- 0 = this library's items stay OUT of the Recent feed (collections)
    sort_order  INTEGER,                    -- owner-defined display order (nav tabs, pickers, TV tab promotion)
    created_at  INTEGER NOT NULL
);

-- ===================== Federation (docs/federation-design.md) =====================

-- Server↔server peering links. One row per DIRECTION: role 'sharer' = we serve this peer via
-- /api/fed/*; role 'consumer' = we pull their catalog and our clients stream from them. secret is
-- the bearer credential for /api/fed/* — plaintext like sessions.token (the local db is inside the
-- trust boundary; rotation = unlink + re-pair). peer_prefix keys the mirrored-id namespace
-- (fed:<prefix>:<remoteId>) and derives from the PEER's persistent server_id, so unlink + re-pair
-- regenerates identical ids and watch_state survives (design §7).
CREATE TABLE IF NOT EXISTS fed_links (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    role             TEXT NOT NULL,              -- 'sharer' | 'consumer'
    peer_server_id   TEXT NOT NULL,              -- the peer's persistent app_meta server_id
    peer_name        TEXT NOT NULL,              -- display name (owner-typed / peer-supplied)
    base_url         TEXT,                       -- consumer rows: the sharer's public origin (required);
                                                 -- sharer rows: informational (may be NULL)
    secret           TEXT NOT NULL,              -- shared bearer secret for /api/fed/*
    peer_prefix      TEXT NOT NULL UNIQUE,       -- id namespace: 12 hex of peer_server_id (full id on clash)
    created_at       INTEGER NOT NULL,
    last_seen_at     INTEGER,                    -- sharer: last authed call; consumer: last clean sync
    last_sync_error  TEXT,                       -- consumer only; NULL = healthy
    max_streams      INTEGER,                    -- sharer rows: per-peer concurrent-stream cap
                                                 -- (NULL/0 = unlimited; set on /admin/federation)
    remote_libraries TEXT,                       -- consumer only: JSON cache of the sharer's shared
                                                 -- libraries (mapping UI stays usable while peer is down)
    UNIQUE (role, peer_server_id)
);

-- Single-use pairing invites minted by the SHARER owner (design §2: an owner-to-owner ceremony —
-- treat like a password-reset link). base_url is captured at creation (EXTERNAL_URL env, else the
-- request's externalOrigin) and embedded in the paste string the consumer owner redeems.
CREATE TABLE IF NOT EXISTS fed_invites (
    token          TEXT PRIMARY KEY,
    base_url       TEXT NOT NULL,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    used_at        INTEGER,
    used_by_server TEXT
);

-- Sharer-side per-link content grants — the federation analogue of channel_grants with LINKS as the
-- principals. A movies library is granted via its synthetic movies channel (one row = the whole
-- collection). channel_id is the index-db id; no cross-db FK (same as watch_state/shares).
CREATE TABLE IF NOT EXISTS fed_grants (
    link_id    INTEGER NOT NULL REFERENCES fed_links(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (link_id, channel_id)
);

-- WHOLE-LIBRARY grants per link: share everything in a library, CURRENT AND FUTURE — a channel
-- that appears in the library later is exported on the next catalog pull with no further action.
-- Effective grant = library grant ∪ per-channel fed_grants (fedserve.effectiveGrantedChannelIds).
CREATE TABLE IF NOT EXISTS fed_library_grants (
    link_id    INTEGER NOT NULL REFERENCES fed_links(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (link_id, library_id)
);

-- ===================== Plex watch-progress sync (docs/plex-sync.md) =====================

-- Per-user Plex account links (the plex.tv PIN ceremony — plexlink.ts). account_token talks to
-- plex.tv (identity/revalidation); server_token is the SERVER-SCOPED access token resolved from
-- /api/v2/resources — the one that reads/writes THIS account's view state on the owner's PMS.
-- Tokens plaintext: same trust boundary as sessions.token / fed_links.secret.
CREATE TABLE IF NOT EXISTS plex_links (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    account_token TEXT NOT NULL,
    server_token  TEXT NOT NULL,
    plex_username TEXT,
    plex_uuid     TEXT,
    machine_id    TEXT,                -- the PMS this server_token was resolved against
    linked_at     INTEGER NOT NULL,
    last_sync_at  INTEGER,
    last_error    TEXT
);

-- The anti-ping-pong snapshot: last OBSERVED Plex tuple + last SYNCED MytView clock per
-- (user, video). Rewritten after every handled pair; deleting it only causes one initial-sync
-- union, never data loss (plexsync.ts merge protocol).
CREATE TABLE IF NOT EXISTS plex_sync_state (
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id            TEXT NOT NULL,
    rating_key          TEXT NOT NULL,
    plex_view_count     INTEGER NOT NULL DEFAULT 0,
    plex_view_offset_ms INTEGER NOT NULL DEFAULT 0,
    plex_last_viewed_at INTEGER,       -- unix SECONDS (Plex's granularity); NULL = never/cleared
    myt_updated_at      INTEGER,       -- watch_state.updated_at (ms) at last sync
    synced_at           INTEGER NOT NULL,
    PRIMARY KEY (user_id, video_id)
);

-- Plex item ↔ MytView video mapping (re-derived from Guids/paths — safe to wipe; method records
-- which tier matched: guid | legacy-guid | path2 | path3). ratingKeys are not durable across some
-- Plex operations, so unknown keys trigger a matching refresh and vanished keys are pruned.
CREATE TABLE IF NOT EXISTS plex_matches (
    rating_key TEXT PRIMARY KEY,
    video_id   TEXT NOT NULL,
    method     TEXT NOT NULL,
    matched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plex_matches_video ON plex_matches(video_id);

-- Sharer-side consumption rollups, one row per link per UTC day (fedmeter.ts — buffered in memory,
-- flushed periodically; url_mints ≈ play starts, bytes_served ≈ range-span estimate).
CREATE TABLE IF NOT EXISTS fed_serve_stats (
    link_id        INTEGER NOT NULL REFERENCES fed_links(id) ON DELETE CASCADE,
    day            TEXT NOT NULL,
    media_requests INTEGER NOT NULL DEFAULT 0,
    hls_requests   INTEGER NOT NULL DEFAULT 0,
    url_mints      INTEGER NOT NULL DEFAULT 0,
    bytes_served   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (link_id, day)
);

-- Consumer-side mapping: each remote (sharer) library the owner consumes maps INTO one local
-- library row (real or virtual) — the merged-library model (design §7). remote_name/remote_format
-- are display/validation caches from the last catalog.
CREATE TABLE IF NOT EXISTS fed_library_map (
    link_id           INTEGER NOT NULL REFERENCES fed_links(id) ON DELETE CASCADE,
    remote_library_id INTEGER NOT NULL,
    local_library_id  INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    remote_name       TEXT,
    remote_format     TEXT,
    PRIMARY KEY (link_id, remote_library_id)
);
CREATE INDEX IF NOT EXISTS idx_fed_map_local ON fed_library_map(local_library_id);
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
	// Federation virtual libraries need path NULL, but pre-federation dbs created the column
	// NOT NULL — and SQLite can't relax that via ALTER, so this is the one rebuild migration.
	// Runs AFTER the column migrations above so the copy includes every column.
	// Per-link stream cap (sharer side) — added after fed_links first shipped, same day.
	addColumnIfMissing(d, 'fed_links', 'max_streams', 'INTEGER');
	relaxLibrariesPathNotNull(d);
	_state = d;
	return _state;
}

/** One-time rebuild dropping `libraries.path`'s NOT NULL (NULL = a federation virtual library).
 *  Guarded (no-op unless the live column is still NOT NULL), transactional, id-preserving (explicit-id
 *  copy also restores the AUTOINCREMENT sequence). FKs are by table NAME, so the just-created (empty)
 *  fed_library_map re-binds across the drop+rename; foreign_keys is toggled around the rebuild. */
function relaxLibrariesPathNotNull(d: Database.Database): void {
	const cols = d.prepare('PRAGMA table_info(libraries)').all() as { name: string; notnull: number }[];
	const pathCol = cols.find((c) => c.name === 'path');
	if (!pathCol || pathCol.notnull === 0) return;
	d.pragma('foreign_keys = OFF');
	try {
		d.exec(`BEGIN;
CREATE TABLE libraries_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    path        TEXT UNIQUE,
    format      TEXT NOT NULL,
    new_private INTEGER NOT NULL DEFAULT 0,
    show_in_recent INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER,
    created_at  INTEGER NOT NULL
);
INSERT INTO libraries_new (id, name, path, format, new_private, show_in_recent, sort_order, created_at)
  SELECT id, name, path, format, new_private, show_in_recent, sort_order, created_at FROM libraries;
DROP TABLE libraries;
ALTER TABLE libraries_new RENAME TO libraries;
COMMIT;`);
		console.log('[mytview] state migration: libraries.path is now nullable (federation virtuals)');
	} catch (e) {
		try {
			d.exec('ROLLBACK');
		} catch {
			/* no open txn */
		}
		throw e;
	} finally {
		d.pragma('foreign_keys = ON');
	}
}

/** Idempotent `ALTER TABLE … ADD COLUMN` — SQLite has no `ADD COLUMN IF NOT EXISTS`, so gate on
 *  the current column list. Safe to run on every boot. */
function addColumnIfMissing(d: Database.Database, table: string, column: string, decl: string): void {
	const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	if (!cols.some((c) => c.name === column)) {
		d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
	}
}

/** Generic durable key/value accessors over app_meta (server-generated secrets + OWNER SETTINGS
 *  that deliberately live in the app rather than the environment — federation cadence, public
 *  address). value null = delete. */
export function appMetaGet(key: string): string | null {
	return (
		(stateDb().prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined)
			?.value ?? null
	);
}
export function appMetaSet(key: string, value: string | null): void {
	if (value == null) stateDb().prepare('DELETE FROM app_meta WHERE key = ?').run(key);
	else
		stateDb()
			.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
			.run(key, value);
}

export { STATE_PATH as STATE_DB_PATH };
