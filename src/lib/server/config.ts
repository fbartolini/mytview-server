/**
 * Configuration, driven entirely by environment variables.
 *
 * MEDIA_ROOT must be a real local path the OS can stat — a directory, or a
 * mount point where a network share (NFS/SMB) is already mounted. URL schemes
 * like nfs://host/export are NOT accepted; mount them first, then point here.
 */
import { env } from '$env/dynamic/private';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import pkg from '../../../package.json';

// Surfaced in /api/status + /api/v1/status so clients (and the operator) can tell which server
// build they're talking to — the version-negotiation anchor alongside `capabilities`.
export const SERVER_VERSION: string = pkg.version;

function bool(value: string | undefined, fallback: boolean): boolean {
	if (value == null) return fallback;
	return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
	const n = value ? parseInt(value, 10) : NaN;
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Root of the media library. Read-only; this app never writes here.
export const MEDIA_ROOT = resolve(env.MEDIA_ROOT ?? '/mnt/media/videos');

// Where the SQLite index lives. Safe to delete; rebuilt from disk on scan.
export const DB_PATH = resolve(env.DB_PATH ?? 'index.db');

// Writable scratch root on the BULK array, OUTSIDE MEDIA_ROOT (which stays read-only). The whole-file
// "compat copy" transcoder that used to own this directory was REMOVED (2026-08-07 — live HLS is the one
// transcode path now); the env is still honored, but ONLY as the parent of the HLS_DIR default below, so
// existing deploys keep their segments on the bulk volume instead of silently moving to an OS temp dir.
// New deploys can just set HLS_DIR directly.
const TRANSCODE_DIR = env.TRANSCODE_DIR ? resolve(env.TRANSCODE_DIR) : null;

// Use VAAPI hardware encode for live HLS (needs /dev/dri passed into the container). Off = libx264 (CPU).
export const TRANSCODE_HWACCEL = bool(env.TRANSCODE_HWACCEL, false);

// WS-I image cache: downscaled thumbnail/poster/fanart variants (`?w=`), DEFAULT-ON since 2026-08-09.
// It shipped opt-in-only after the first on-demand shape blocked every request on an unbounded ffmpeg
// herd (a cold 60-card grid stampeded the box) — both halves of that are fixed: generation is BOUNDED
// with originals served immediately on a saturated miss (imagecache.ts), and the indexer PREBAKES card
// sizes after each scan (the shape the original note asked for). Defaults under TRANSCODE_DIR/imgcache
// (the writable bulk volume) when set, else an OS temp dir; `off` → every route serves the original.
export const IMAGE_CACHE_DIR =
	env.IMAGE_CACHE_DIR === 'off'
		? null
		: env.IMAGE_CACHE_DIR
			? resolve(env.IMAGE_CACHE_DIR)
			: TRANSCODE_DIR
				? join(TRANSCODE_DIR, 'imgcache')
				: join(tmpdir(), 'mytview-imgcache');

// --- On-the-fly HLS transcode (Phase 1 adaptive-streaming) --------------------------------------------
// EPHEMERAL: segments live in a per-session temp dir only WHILE watching, GC'd on idle + shutdown — no
// persistent copies. THE one transcode path (the whole-file compat tier was removed 2026-08-07).
// Defaults under TRANSCODE_DIR/hls (the writable bulk volume) when set, else an OS temp dir. `off` →
// no live-transcode fallback at all: clients direct-play only.
export const HLS_DIR =
	env.HLS_DIR === 'off'
		? null
		: env.HLS_DIR
			? resolve(env.HLS_DIR)
			: TRANSCODE_DIR
				? join(TRANSCODE_DIR, 'hls')
				: join(tmpdir(), 'mytview-hls');
// Max concurrent live-transcode sessions (a home box serves a few before choking). Beyond → 503, and the
// client retries / fails soft. A session whose encoder was idle-reaped no longer counts.
// FLOORED at 1 — `HLS_DIR=off` is the off switch; 0 here would still mint sessions and advertise hlsUrl
// but 503 every segment (a half-broken mode nobody wants).
export const HLS_MAX_SESSIONS = Math.max(int(env.HLS_MAX_SESSIONS, 3), 1);
// Idle handling is TWO-STAGE so a PAUSE doesn't destroy the session (resume past the buffer would then 503):
// after HLS_IDLE_SEC with no segment request only the ffmpeg is REAPED (frees CPU) — the session + its
// buffered segments stay, and a resume restarts the encoder at the offset.
// Clamped > the 45s segment wait, else the GC could reap an encoder while a request is still waiting on it.
export const HLS_IDLE_SEC = Math.max(int(env.HLS_IDLE_SEC, 60), 50);
// Full teardown (kill ffmpeg AND delete segments) only after this long with no request — you actually stopped.
// Clamped > HLS_IDLE_SEC so the two-stage GC always reaps-then-destroys (never destroys a still-resumable session).
export const HLS_SESSION_TTL = Math.max(int(env.HLS_SESSION_TTL, 1800), HLS_IDLE_SEC + 60);
// HLS target segment seconds (== forced keyframe interval). 4 balances start latency vs. request overhead.
// FLOORED at 1: int() accepts 0, and a 0 here makes the playlist builder compute ceil(duration/0) =
// Infinity segments — an unbounded loop that OOMs the server on the first HLS play (one-char env typo).
export const HLS_SEGMENT_SEC = Math.max(int(env.HLS_SEGMENT_SEC, 4), 1);
// Rolling cap on segments kept BEHIND the play head (a seek back beyond the window just restarts there). Bounds
// a long watch's disk. hls.ts FLOORS this at the buffer-ahead range (CATCHUP + hysteresis ≈ 40) — a smaller keep
// would let the rolling cap unlink the frontier-cache segment and defeat the ahead-throttle. 40 ≈ a ~2.5-min window.
export const HLS_SESSION_MAX_SEG = int(env.HLS_SESSION_MAX_SEG, 40);
// Cap on segments produced AHEAD of the play head: when the encoder races this far ahead it's SIGSTOP'd
// (frozen, no CPU, bounded disk) and SIGCONT'd as playback drains the buffer. Keeps fast start + headroom
// while stopping ffmpeg from producing a whole 2-hour file into (possibly RAM-backed) temp. 30 ≈ 2 min ahead.
export const HLS_AHEAD_SEG = Math.max(int(env.HLS_AHEAD_SEG, 30), 4); // ≥4 → a real ahead-buffer + positive throttle hysteresis

// Rescan the library on startup. Cheap (unchanged files are skipped by mtime).
export const SCAN_ON_START = bool(env.SCAN_ON_START, true);

// Auto-rescan interval in minutes (0 disables). Incremental, so cheap; picks up
// new downloads without a restart.
export const SCAN_INTERVAL_MIN = (() => {
	const n = parseInt(env.SCAN_INTERVAL ?? '5', 10);
	return Number.isFinite(n) && n >= 0 ? n : 5;
})();

// Who may create accounts. Login is always allowed.
//   'invite' (default): first account bootstraps the owner; after that a single-use
//                       invite token is required. Works the same on LAN or WAN.
//   'all'             : open signup.
//   'off'             : disabled (once the owner exists).
export const ALLOW_SIGNUP: 'invite' | 'all' | 'off' = (() => {
	const m = (env.ALLOW_SIGNUP ?? 'invite').trim().toLowerCase();
	return m === 'all' ? 'all' : m === 'off' ? 'off' : 'invite';
})();

// Who may create invite links. The owner always can.
//   'owner' (default): only the owner invites people (a family server's usual shape).
//   'all'            : any signed-in user can invite.
export const ALLOW_INVITES: 'owner' | 'all' = (() => {
	const m = (env.ALLOW_INVITES ?? 'owner').trim().toLowerCase();
	return m === 'all' ? 'all' : 'owner';
})();
