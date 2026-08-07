/**
 * On-the-fly HLS transcode sessions — Phase 1 of docs/adaptive-streaming-design.md.
 *
 * EPHEMERAL by design: a session's segments live in a per-session temp dir only WHILE watching, and are
 * GC'd on idle + shutdown — there are NO persistent copies (unlike the whole-file TRANSCODE_DIR). This is
 * the compat FALLBACK for formats a client can't decode (HEVC / .mkv on web + Apple); direct-play stays
 * the default. Output is the SOURCE resolution — codec/container only, no downscaling (that's ABR, later).
 *
 * A session serves a complete VOD playlist up front (real length + seekbar). One active ffmpeg per session
 * transcodes forward from a start segment; a seek beyond the transcoded window RESTARTS ffmpeg at the
 * offset (`-ss` + `-output_ts_offset` + `-start_number` keep segments numbered/aligned to the playlist),
 * so far-seeks play in ~a second and already-produced segments (seeking back) are instant. Validated by
 * spike/hls-spike.mjs.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { rm, unlink, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import {
	HLS_DIR,
	HLS_MAX_SESSIONS,
	HLS_IDLE_SEC,
	HLS_SESSION_TTL,
	HLS_SEGMENT_SEC,
	HLS_SESSION_MAX_SEG,
	HLS_AHEAD_SEG,
	TRANSCODE_HWACCEL
} from './config';
import { db } from './db';
import { resolveInMediaRoot } from './files';
import { hlsQuery } from './mediaToken';

const execFileP = promisify(execFile);
const SEG = HLS_SEGMENT_SEC;
// How far the player may request ahead of the active job's frontier before it's treated as a real SEEK
// (rather than normal buffer-ahead) and the encode restarts there. Must exceed the player's buffer-ahead.
const CATCHUP = 32;
// Hysteresis (segments) so the ahead-throttle doesn't flap: SIGSTOP at HLS_AHEAD_SEG, SIGCONT once the buffer
// has drained this far below it. Clamped below HLS_AHEAD_SEG (else the SIGCONT threshold goes ≤ 0 → rebuffer loop).
const AHEAD_HYST = Math.min(8, Math.floor(HLS_AHEAD_SEG / 2));
// Segments kept BEHIND the play head by the rolling cap. FLOORED at CATCHUP + hysteresis: a keep-window smaller
// than the buffer-ahead range (CATCHUP) could unlink the very segment the frontier cache sits on, pinning it
// backward so the throttle never fires and ffmpeg races to EOF — the exact OOM this pass prevents.
const SEG_KEEP = Math.max(HLS_SESSION_MAX_SEG, CATCHUP + AHEAD_HYST);

export const hlsEnabled = (): boolean => HLS_DIR != null;

interface Session {
	id: string;
	videoId: string;
	srcAbs: string;
	dir: string;
	duration: number;
	active: { start: number; proc: ChildProcess } | null;
	createdAt: number;
	lastAccess: number;
	lastFetched: number; // highest segment the player has requested — the play head, for the ahead-throttle
	everFetched: boolean; // any segment ever requested — a never-fetched session is reusable/evictable
	frontier: number;    // cached forward-only production frontier (first not-yet-produced seg); reset on spawn
	paused: boolean;     // ffmpeg SIGSTOP'd because it raced > HLS_AHEAD_SEG ahead of the play head
	hdr: boolean;        // source is HDR → tonemap on the CPU path (VAAPI is skipped for HDR)
}
const sessions = new Map<string, Session>();
let hwDisabled = false; // set once VAAPI proves unusable on this host → CPU from then on
let tonemapDisabled = false; // set once the HDR tonemap proves unrunnable (no libzimg / bad primaries) → plain 8-bit
let gcStarted = false;
let sweepPromise: Promise<void> | null = null; // shared one-time boot sweep (memoized so concurrent callers await the SAME completion)

const segName = (n: number) => `seg${String(n).padStart(5, '0')}.ts`;
const segPath = (s: Session, n: number) => path.join(s.dir, segName(n));

async function probeDuration(abs: string): Promise<number | null> {
	try {
		const { stdout } = await execFileP('ffprobe', [
			'-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs
		], { timeout: 10_000, killSignal: 'SIGKILL' }); // never hang the m3u8 request on a stalled/slow source
		const d = parseFloat(stdout.trim());
		return Number.isFinite(d) && d > 0 ? d : null;
	} catch {
		return null;
	}
}

// HDR→SDR tonemap (CPU/zscale): maps BT.2020 + PQ/HLG to BT.709 SDR 8-bit. Forcing 8-bit ALONE leaves HDR
// washed-out grey; applied ONLY to detected-HDR sources and ends in yuv420p (no separate -pix_fmt needed).
const TONEMAP_VF =
	'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** Is the source HDR (PQ/HLG transfer)? Gates the tonemap — a plain 8-bit downconvert of HDR washes out grey. */
async function probeHdr(abs: string): Promise<boolean> {
	try {
		const { stdout } = await execFileP('ffprobe', [
			'-v', 'error', '-select_streams', 'V:0', '-show_entries', 'stream=color_transfer',
			'-of', 'default=noprint_wrappers=1:nokey=1', abs
		], { timeout: 10_000, killSignal: 'SIGKILL' });
		const t = stdout.trim().toLowerCase();
		return t === 'smpte2084' || t === 'arib-std-b67';
	} catch {
		return false;
	}
}

/** One-time sweep of stale `sess-*` dirs left by a previous (crashed) run — `sessions` is empty at boot, so any
 *  on-disk session dir is an orphan. MEMOIZED as a shared promise so every concurrent first-caller awaits the SAME
 *  completed sweep before its mkdtemp; a plain boolean guard would let a second caller create a fresh dir that this
 *  scan then deletes (TOCTOU). NOTE: assumes a single server owns HLS_DIR — a shared HLS_DIR across replicas / a
 *  rolling deploy would sweep the other's live sessions, so give each instance its own HLS_DIR (or drain first). */
function sweepOrphans(): Promise<void> {
	if (!HLS_DIR) return Promise.resolve();
	return (sweepPromise ??= (async () => {
		const dir = HLS_DIR;
		try {
			const entries = await readdir(dir);
			await Promise.all(
				entries
					.filter((e) => e.startsWith('sess-'))
					.map((e) => rm(path.join(dir, e), { recursive: true, force: true }).catch(() => {}))
			);
		} catch {
			/* HLS_DIR doesn't exist yet or is unreadable — nothing to sweep */
		}
	})());
}

// One probe result per (absPath, mtime) — startHlsSession used to run BOTH ffprobes on EVERY
// index.m3u8 GET, and players routinely fetch a VOD playlist 2–4× at playback start (Safari), so a
// single play could spawn 8 probe processes and a scripted loop unbounded ones. Bounded by wholesale
// clear (simplest; refilling costs one probe pair per file on next play).
const probeCache = new Map<string, { duration: number | null; hdr: boolean }>();
const PROBE_CACHE_MAX = 512;

// Bound TOTAL session entries (temp dirs + Map rows). HLS_MAX_SESSIONS caps concurrent ENCODERS at
// segment time, but nothing capped playlist-time minting — sessions are retained HLS_SESSION_TTL
// (30 min), so a playlist flood accumulated dirs and Map entries freely.
const MAX_TOTAL_SESSIONS = HLS_MAX_SESSIONS * 4;

/** Create (or reuse) a session for a video (called by the index.m3u8 route AFTER auth). Returns
 *  { sid, playlist } or null (disabled / unknown video / unreadable source / unknown duration / full). */
export async function startHlsSession(videoId: string): Promise<{ sid: string; playlist: string } | null> {
	if (!HLS_DIR) return null;
	// Playlist refetch collapse: reuse a just-minted session for the same video that nobody has pulled
	// a segment from yet (the Safari/AVPlayer multi-fetch at start), instead of minting a dir + probes
	// per GET. Once a segment has been fetched the session is someone's live playback — never shared.
	for (const s of sessions.values()) {
		if (s.videoId === videoId && !s.everFetched && Date.now() - s.createdAt < 20_000) {
			s.lastAccess = Date.now();
			return { sid: s.id, playlist: buildPlaylist(s.id, s.duration) };
		}
	}
	const row = db().prepare('SELECT video_path, duration FROM videos WHERE id = ?').get(videoId) as
		| { video_path: string; duration: number | null }
		| undefined;
	if (!row) return null;
	let srcAbs: string;
	let mtimeMs: number;
	try {
		const r = await resolveInMediaRoot(row.video_path);
		srcAbs = r.absPath;
		mtimeMs = r.stat.mtimeMs;
	} catch {
		return null;
	}
	// Use the ACTUAL muxed duration for the playlist, not the .info.json duration: a yt-dlp SponsorBlock-spliced
	// file is SHORTER than its reported original length, so trusting info.json declares phantom tail segments
	// that 404/time-out. Fall back to the indexed duration only if ffprobe can't read it. Cached per (path,
	// mtime) — see probeCache.
	const cacheKey = `${srcAbs}:${mtimeMs}`;
	let probed = probeCache.get(cacheKey);
	if (!probed) {
		probed = { duration: await probeDuration(srcAbs), hdr: await probeHdr(srcAbs) };
		if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear();
		probeCache.set(cacheKey, probed);
	}
	const duration = probed.duration ?? (row.duration && row.duration > 0 ? row.duration : null);
	if (!duration) return null;
	const hdr = probed.hdr;
	// At the total-session cap: evict the OLDEST never-fetched session (mint-storm leftovers). If every
	// session is genuinely being watched, refuse — the route 404s and the client retries/fails soft.
	if (sessions.size >= MAX_TOTAL_SESSIONS) {
		let victim: Session | null = null;
		for (const s of sessions.values()) {
			if (!s.everFetched && (!victim || s.createdAt < victim.createdAt)) victim = s;
		}
		if (!victim) return null;
		destroySession(victim);
		sessions.delete(victim.id);
	}
	if (!existsSync(HLS_DIR)) mkdirSync(HLS_DIR, { recursive: true });
	await sweepOrphans(); // before mkdtemp, so we never delete the dir we're about to create
	const sid = crypto.randomBytes(16).toString('hex');
	const dir = mkdtempSync(path.join(HLS_DIR, 'sess-'));
	sessions.set(sid, {
		id: sid, videoId, srcAbs, dir, duration,
		active: null, createdAt: Date.now(), lastAccess: Date.now(), lastFetched: 0, everFetched: false,
		frontier: 0, paused: false, hdr
	});
	startGc();
	return { sid, playlist: buildPlaylist(sid, duration) };
}

/** Complete VOD playlist (real length + seekbar up front), segments as session-scoped absolute URLs. */
function buildPlaylist(sid: string, duration: number): string {
	const n = Math.ceil(duration / SEG);
	const sig = hlsQuery(sid); // one signature for the whole session's segments
	let m = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
	for (let i = 0; i < n; i++) {
		const dur = i < n - 1 ? SEG : duration - (n - 1) * SEG;
		m += `#EXTINF:${dur.toFixed(6)},\n/hls/s/${sid}/${segName(i)}?${sig}\n`;
	}
	return m + '#EXT-X-ENDLIST\n';
}

/** Ensure segment `n` of a session is produced (start / restart-at-offset / wait) and return its file
 *  PATH for the route to stream. null → capped / timed out / unknown session (route → 404/503). The `sid`
 *  is the capability (unguessable, handed out only by an authed index.m3u8) — same model as a share token. */
export async function hlsSegment(sid: string, n: number): Promise<string | null> {
	const s = sessions.get(sid);
	if (!s || !Number.isInteger(n) || n < 0) return null;
	s.lastAccess = Date.now();
	s.lastFetched = n; // the play head — the ahead-throttle keeps the encoder within HLS_AHEAD_SEG of this
	s.everFetched = true; // now someone's live playback — no longer reusable/evictable at mint time
	if (!ensureCovers(s, n)) return null; // concurrency-capped
	// 45s (not 30) so a slow NAS CPU's first segment / cold far-seek of a 4K HEVC/AV1 source isn't a false 503.
	if (!(await waitFor(segPath(s, n), 45000))) return null;
	s.lastAccess = Date.now();
	// Rolling cap: drop the segment SEG_KEEP behind this one (a seek back beyond the window just restarts).
	// Bounds one long watch's disk without touching the recent seek-back range or the frontier cache.
	if (n - SEG_KEEP >= 0) {
		void unlink(segPath(s, n - SEG_KEEP)).catch(() => {});
	}
	return segPath(s, n);
}

/** First not-yet-produced segment — the active job's frontier. Forward-only cached (`s.frontier`, reset to the
 *  job's start on spawn) so repeated calls don't rescan the whole produced range. */
function frontier(s: Session): number {
	let k = Math.max(s.active?.start ?? 0, s.frontier);
	while (existsSync(segPath(s, k))) k++;
	s.frontier = k;
	return k;
}
function activeCount(): number {
	// Count only encoders actually USING the CPU — a throttle-frozen (SIGSTOP'd) session isn't, so it must not
	// pin a concurrency slot against a genuinely new stream.
	let c = 0;
	for (const s of sessions.values()) if (s.active && !s.paused) c++;
	return c;
}

/** Ensure segment `n` is produced or coming. Returns false only when a NEW encode would exceed the
 *  concurrency cap (the caller 503s). */
function ensureCovers(s: Session, n: number): boolean {
	if (existsSync(segPath(s, n))) return true; // already produced (any region ever transcoded here)
	// The player wants a segment that isn't produced yet — if the encoder is throttle-frozen, resume it NOW
	// rather than wait up to a GC tick (a forward seek just past the frozen frontier would otherwise risk the
	// 45s segment timeout → 503).
	if (s.active && s.paused) {
		s.active.proc.kill('SIGCONT');
		s.paused = false;
	}
	if (s.active) {
		const f = frontier(s);
		if (n >= f && n - f < CATCHUP) return true; // the active job will reach it soon (normal buffering)
	}
	if (!s.active && activeCount() >= HLS_MAX_SESSIONS) return false; // a home box only serves a few streams
	spawnAt(s, n); // a real seek (or first play) → (re)start the encode here
	return true;
}

function spawnAt(s: Session, start: number) {
	if (s.active) s.active.proc.kill('SIGKILL'); // abandon the position the user left
	const proc = spawn('ffmpeg', ffmpegArgs(s, start), { stdio: ['ignore', 'ignore', 'pipe'] });
	s.active = { start, proc };
	s.frontier = start; // fresh job → rescan the frontier from here
	s.paused = false;
	let err = '';
	proc.stderr?.on('data', (d) => {
		err += d.toString();
		if (err.length > 2000) err = err.slice(-2000);
	});
	proc.on('error', (e) => {
		// Spawn-level failure (ffmpeg not on PATH, EMFILE/ENOMEM under pressure). Without a listener
		// this is an unhandled 'error' event — Node throws and the WHOLE server dies mid-request.
		// 'close' may never fire after 'error', so clear the active slot here too; the in-flight
		// segment waiter then times out to a 503 (client falls over to compat) instead of a crash.
		if (s.active?.proc === proc) {
			s.active = null;
			s.paused = false;
		}
		console.error(`[mytview] HLS: ffmpeg spawn failed: ${e.message}`);
	});
	proc.on('close', (code) => {
		if (s.active?.proc === proc) {
			s.active = null;
			s.paused = false;
		}
		if (code && code !== 0 && !hwDisabled && TRANSCODE_HWACCEL && /vaapi|Device creation|renderD128/i.test(err)) {
			hwDisabled = true; // VAAPI unusable on this host → CPU from now on; the next segment restarts on CPU
			console.warn('[mytview] HLS: VAAPI unavailable — using CPU for live transcode');
		}
		if (code && code !== 0 && !tonemapDisabled && /zscale|tonemap|zimg|no such filter/i.test(err)) {
			tonemapDisabled = true; // HDR tonemap can't run here → plain 8-bit (washed-out but playable) from now on
			console.warn('[mytview] HLS: HDR tonemap unavailable — falling back to a plain 8-bit downconvert');
		}
	});
}

function ffmpegArgs(s: Session, start: number): string[] {
	const off = start * SEG;
	const hw = TRANSCODE_HWACCEL && !hwDisabled && !s.hdr; // HDR → CPU path (tonemap); VAAPI tonemapping is unreliable here
	const useTonemap = s.hdr && !tonemapDisabled; // HDR, unless the tonemap already proved unrunnable → plain 8-bit
	// -ss BEFORE -i = fast input seek to the keyframe ≤ off; -output_ts_offset shifts PTS back to `off` so
	// seg N lines up with the playlist timeline; -start_number N names the segments absolutely. Force 8-bit
	// (yuv420p / nv12) — 10-bit HEVC → H.264 High10 is undecodable by browsers/MSE. Audio → AAC-LC stereo.
	return [
		'-nostdin', '-y',
		...(hw ? ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-vaapi_device', '/dev/dri/renderD128'] : []),
		'-ss', String(off), '-i', s.srcAbs,
		'-map', '0:V:0', '-map', '0:a:0?',
		...(hw
			? ['-vf', 'scale_vaapi=format=nv12', '-c:v', 'h264_vaapi', '-low_power', '1', '-qp', '23']
			: useTonemap
				? ['-vf', TONEMAP_VF, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'] // tonemap chain ends in yuv420p
				: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
		'-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
		'-c:a', 'aac', '-b:a', '160k', '-ac', '2',
		'-output_ts_offset', String(off),
		'-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-start_number', String(start),
		// temp_file: write each segment to *.ts.tmp and atomically rename on completion, so a segment only
		// "exists" (→ served) once fully written. Without it, a fast (VAAPI) encoder's half-written .ts gets
		// fetched mid-write → hls.js "buffers not in DTS sequence" / DEMUXER_ERROR_COULD_NOT_PARSE.
		'-hls_flags', 'temp_file',
		'-hls_segment_filename', path.join(s.dir, 'seg%05d.ts'),
		path.join(s.dir, 'ff.m3u8')
	];
}

async function waitFor(p: string, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (existsSync(p)) return true;
		await new Promise((r) => setTimeout(r, 60));
	}
	return existsSync(p);
}

/** Bound the AHEAD buffer: freeze the encoder (SIGSTOP) once it's produced > HLS_AHEAD_SEG past the play head,
 *  resume (SIGCONT) as playback drains it. Keeps a full buffer + fast start (unlike `-re`) while stopping ffmpeg
 *  from racing a whole file into (possibly RAM-backed) temp. No-op unless an encoder is running. */
function throttle(s: Session): void {
	if (!s.active) return;
	const ahead = frontier(s) - s.lastFetched;
	if (!s.paused && ahead > HLS_AHEAD_SEG) {
		s.active.proc.kill('SIGSTOP');
		s.paused = true;
	} else if (s.paused && ahead <= HLS_AHEAD_SEG - AHEAD_HYST) {
		s.active.proc.kill('SIGCONT');
		s.paused = false;
	}
}

/** Reap only the ffmpeg (frees CPU + stops it racing ahead) but KEEP the session + its buffered segments, so a
 *  resume after a pause restarts the encoder at the offset instead of 503-ing on a deleted dir. */
function reapEncoder(s: Session) {
	if (s.active) s.active.proc.kill('SIGKILL'); // SIGKILL fires even on a SIGSTOP'd encoder
	s.active = null;
	s.paused = false;
}

/** Full teardown: reap the ffmpeg AND delete the segment dir. Used on true idle (HLS_SESSION_TTL) + shutdown. */
function destroySession(s: Session) {
	reapEncoder(s);
	void rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

// Idle-GC: a session with no request for HLS_IDLE_SEC (you stopped watching) → kill ffmpeg + delete its
// segments. This is what makes disk transient — freed shortly after playback stops.
function startGc() {
	if (gcStarted) return;
	gcStarted = true;
	setInterval(() => {
		const now = Date.now();
		for (const [sid, s] of sessions) {
			if (s.lastAccess < now - HLS_SESSION_TTL * 1000) {
				destroySession(s); // truly stopped watching → free the disk
				sessions.delete(sid);
			} else if (s.active && s.lastAccess < now - HLS_IDLE_SEC * 1000) {
				reapEncoder(s); // paused/idle → stop ffmpeg but keep the session so a resume restarts it
			} else if (s.active) {
				throttle(s); // active → keep the ahead-buffer within HLS_AHEAD_SEG of the play head
			}
		}
	}, 5_000).unref?.();
	const cleanup = () => {
		for (const s of sessions.values()) destroySession(s);
		sessions.clear();
	};
	process.once('SIGTERM', cleanup);
	process.once('SIGINT', cleanup);
}
