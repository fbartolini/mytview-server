/**
 * On-the-fly HLS transcode sessions — Phase 1 of docs/adaptive-streaming-design.md.
 *
 * EPHEMERAL by design: a session's segments live in a per-session temp dir only WHILE watching, and are
 * GC'd on idle + shutdown — there are NO persistent copies (unlike the whole-file TRANSCODE_DIR). This is
 * the compat FALLBACK for formats a client can't decode (HEVC / .mkv on web + Apple); direct-play stays
 * the default. Output is the SOURCE resolution — unless THIS host proves too slow for it, when it steps
 * down to 1080p/720p mid-session (see ADAPTIVE DOWNSCALE). Still one rendition, never ABR.
 *
 * A session serves a complete VOD playlist up front (real length + seekbar). One active ffmpeg per session
 * transcodes forward from a start segment; a seek beyond the transcoded window RESTARTS ffmpeg at the
 * offset (`-ss` + `-output_ts_offset` + `-start_number` keep segments numbered/aligned to the playlist),
 * so far-seeks play in ~a second and already-produced segments (seeking back) are instant. Validated by
 * spike/hls-spike.mjs.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { rm, unlink, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import {
	HLS_DIR,
	HLS_MAX_SESSIONS,
	HLS_MAX_SESSIONS_EXPLICIT,
	HLS_MAX_COPY_SESSIONS,
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

// The render node VAAPI encodes through. One const so the About page's capability report and the
// ffmpeg args can never disagree about which device we're claiming.
const VAAPI_DEVICE = '/dev/dri/renderD128';

interface Session {
	id: string;
	videoId: string;
	srcAbs: string;
	dir: string;
	duration: number;
	/** The running encoder. `speed` = its steady-state measurement (see ADAPTIVE DOWNSCALE): the first
	 *  real progress sample, and `done` once a verdict is in (or the job was throttled — proof of speed). */
	active: { start: number; proc: ChildProcess; speed: { wall: number; out: number } | null; done: boolean } | null;
	createdAt: number;
	lastAccess: number;
	lastFetched: number; // highest segment the player has requested — the play head, for the ahead-throttle
	everFetched: boolean; // any segment ever requested — a never-fetched session is reusable/evictable
	/** Federation attribution (fedmeter): set when the index request carried a MAC-covered link tag,
	 *  so segment requests can be metered/capped per peer. Reused sessions keep their first owner's
	 *  attribution (≤20s window — accepted noise). */
	fed: { linkId: number; key: string } | null;
	frontier: number;    // cached forward-only production frontier (first not-yet-produced seg); reset on spawn
	paused: boolean;     // ffmpeg SIGSTOP'd because it raced > HLS_AHEAD_SEG ahead of the play head
	hdr: boolean;        // source is HDR → needs a tonemap (GPU for PQ when VAAPI is on, else the CPU chain)
	pq: boolean;         // HDR10/PQ specifically — what tonemap_vaapi maps (HLG stays on the CPU chain)
	width: number | null;  // source video dimensions (null = unprobed → never downscaled)
	height: number | null;
	probeKey: string;    // `${srcAbs}:${mtimeMs}` — keys the remembered slow-source verdict
	scaleStep: number;   // SCALE_LADDER rung in use (0 = source resolution)
	audio: number | null; // absolute index of the audio stream to encode (the file's DEFAULT one); null = ffmpeg picks
	reqAudio: number | null; // what the CALLER asked for (null = "whatever the file defaults to") — the reuse key
	/** STREAM-COPY session: video + audio copied untouched into TS segments cut at the SOURCE's keyframes
	 *  (no encode, original quality, ~I/O cost). Text/data tracks are dropped — the whole point for the
	 *  text-stream-heavy containers that choke a 2018 Samsung demuxer (contract §preferHls). */
	copy: boolean;
	/** Copy sessions: each segment's START time = a keyframe timestamp (greedy ≥ SEG apart, `copyBoundaries`).
	 *  Drives both the playlist's real durations and the restart-at-boundary math in ffmpegArgs. */
	bounds: number[] | null;
	reqCopy: boolean; // what the caller ASKED for (reuse key) — copy may be refused for an ineligible codec
	/** A DOWNLOAD (contract §HLS `dl=1`): no start-latency to protect and no real-time to keep — waits
	 *  for the keyframe scan instead of encoding, never downscales (a copy for the shelf keeps the
	 *  source resolution however slow the host), never learns a "slow" rung for the file. */
	download: boolean;
	/** Copy sessions only: fMP4 (CMAF) segments + an init section instead of MPEG-TS — what Apple
	 *  needs to take HEVC untouched (contract §HLS `fmt=fmp4`). Encodes always stay TS. */
	fmp4: boolean;
	vcodec: string | null;
}

// ---- STREAM-COPY mode --------------------------------------------------------------------------
// The engine's seek model — a VOD playlist up front, segment N restartable at its start time — was
// built on the encoder forcing a keyframe every SEG seconds. A copied stream can only be cut at the
// source's own keyframes, so copy sessions carry their real segment starts (`bounds`) and the playlist
// states the real durations. Verified offline against ffmpeg's actual cuts (10s-GOP HEVC and 1s-GOP
// H.264): the hls muxer starts a new segment at the first keyframe ≥ (segment start + hls_time), which
// `copyBoundaries` reproduces exactly, from any start.
const COPY_VIDEO = new Set(['h264', 'hevc']); // what MPEG-TS carries and the TV decoders take natively
const COPY_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3']);
// A restart at boundary N must START on its keyframe. `-ss` alone lands on the container's cue index —
// which is NOT every keyframe (field: a request for 31.333 landed on 20.917, nine seconds of pre-roll).
// So: a COARSE input seek well before the boundary (wherever it lands is fine), then an exact OUTPUT-side
// `-ss` that discards packets until the boundary. ffmpeg compares that threshold against DTS, and a
// keyframe's DTS trails its PTS by the reorder lag — a threshold AT the keyframe's PTS skips it and lands
// the NEXT one (field-verified) — hence the lead. Everything before the keyframe that survives the
// threshold is dropped by copy's own wait-for-keyframe rule, and `-output_ts_offset` restores the
// absolute timeline (verified: a restart's first packet matches the from-zero run's to the millisecond,
// bar the muxer's one-time negative-DTS shift at a file's very start — two frames, within tolerance).
const COPY_COARSE_SEEK = 20;
const COPY_TRIM_LEAD = 0.5;
const KEYFRAME_SCAN_BUDGET_MS = 4000; // wait this long for a first-time keyframe scan; beyond it, encode THIS session
// A DOWNLOAD (contract §HLS: it sends `copyv`) has no start-latency to protect and its client counts
// it against the COPY pool, so it waits for the scan rather than silently taking an encoder slot the
// client never reserved (owner field 2026-09-23: the first session of every new file encoded, the
// encoder pool overflowed, and the batch stalled on 503s).
// ...but never longer than a reverse proxy waits (30–60 s is the usual read timeout — a 60 s wait
// came back to the app as a 504 from the owner's proxy, 2026-09-23): 20 s, then 503 + Retry-After
// while the scan finishes in the background (memoised), and the next attempt copies.
const KEYFRAME_SCAN_BUDGET_PATIENT_MS = 20_000;

/** Copy-mode segment start times from a keyframe list: every keyframe at least `seg` after the previous
 *  start — ffmpeg's own cutting rule for a copied stream, so the playlist and the files agree. */
export function copyBoundaries(keyframes: number[], seg = SEG): number[] {
	const out: number[] = [];
	for (const k of keyframes) if (!out.length || k >= out[out.length - 1] + seg) out.push(k);
	return out;
}

// The source's keyframe timestamps — copy mode's one prerequisite. A demux-only packet scan (no decode;
// I/O bound, about a second per GB on local disk), memoised per (path, mtime) and de-duplicated while
// in flight. Bounded by a time budget at session start: within it, this session copies; beyond it,
// this session ENCODES while the scan finishes in the background and the file's next session copies.
// `end` = the last packet's timestamp: the stream's REAL end, which a container's declared duration can
// overstate (a truncated or SponsorBlock-spliced file) — the copy playlist's last segment is clamped to it.
type KeyScan = { keys: number[]; end: number };
const keyframeCache = new Map<string, KeyScan | null>();
const keyframeScans = new Map<string, Promise<KeyScan | null>>();
// The scan reads the WHOLE file (minutes for a 4 GB source over NFS), so its result is kept ON DISK
// beside the transcode dir, keyed by path+mtime: a restart/redeploy used to forget every scan and
// every mid-download task then sat on 503s while the same files were scanned again (owner field
// 2026-09-24). Tiny JSON files; a source that changes (new mtime) simply gets a new key.
const keyframeDir = (): string | null => (HLS_DIR ? path.join(path.dirname(HLS_DIR), 'keyframes') : null);
function keyframeFile(key: string): string | null {
	const dir = keyframeDir();
	return dir ? path.join(dir, crypto.createHash('sha1').update(key).digest('hex') + '.json') : null;
}
function readKeyframes(key: string): KeyScan | null | undefined {
	const f = keyframeFile(key);
	if (!f || !existsSync(f)) return undefined;
	try {
		const v = JSON.parse(readFileSync(f, 'utf8')) as { keys?: number[]; end?: number } | null;
		if (v == null) return null;
		return Array.isArray(v.keys) && typeof v.end === 'number' ? { keys: v.keys, end: v.end } : undefined;
	} catch {
		return undefined;
	}
}
function writeKeyframes(key: string, r: KeyScan | null): void {
	const f = keyframeFile(key);
	if (!f) return;
	try {
		mkdirSync(path.dirname(f), { recursive: true });
		writeFileSync(f + '.tmp', JSON.stringify(r));
		renameSync(f + '.tmp', f);
	} catch {
		/* best effort: the in-memory memo still holds it for this process */
	}
}
function scanKeyframes(abs: string, key: string): Promise<KeyScan | null> {
	const cached = keyframeCache.get(key);
	if (cached !== undefined) return Promise.resolve(cached);
	const onDisk = readKeyframes(key);
	if (onDisk !== undefined) {
		if (keyframeCache.size >= PROBE_CACHE_MAX) keyframeCache.clear();
		keyframeCache.set(key, onDisk);
		return Promise.resolve(onDisk);
	}
	let p = keyframeScans.get(key);
	if (!p) {
		p = execFileP(
			'ffprobe',
			['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', abs],
			{ timeout: 600_000, killSignal: 'SIGKILL', maxBuffer: 64 << 20 }
		)
			.then(({ stdout }) => {
				const out: number[] = [];
				let end = 0;
				for (const line of stdout.split('\n')) {
					const c = line.indexOf(',');
					if (c < 0) continue;
					const t = Number(line.slice(0, c));
					if (!Number.isFinite(t)) continue;
					if (t > end) end = t;
					if (line.indexOf('K', c) >= 0) out.push(t);
				}
				out.sort((a, b) => a - b);
				return out.length ? { keys: out, end } : null;
			})
			.catch(() => null)
			.then((r) => {
				if (keyframeCache.size >= PROBE_CACHE_MAX) keyframeCache.clear();
				keyframeCache.set(key, r);
				keyframeScans.delete(key);
				writeKeyframes(key, r);
				return r;
			});
		keyframeScans.set(key, p);
	}
	return p;
}

/** The audio streams' codecs by absolute index — copy eligibility is per CHOSEN track (a DTS track
 *  can't ride in TS; the same file's AAC track can). */
async function probeAudioCodecs(abs: string): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	try {
		const { stdout } = await execFileP('ffprobe', [
			'-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index,codec_name', '-of', 'json', abs
		], { timeout: 10_000, killSignal: 'SIGKILL' });
		for (const st of (JSON.parse(stdout) as { streams?: { index: number; codec_name?: string }[] }).streams ?? []) {
			if (st.codec_name) out.set(st.index, st.codec_name.toLowerCase());
		}
	} catch {
		/* no audio info → not copy-eligible */
	}
	return out;
}
/** The transcode volume refused a session dir (ENOSPC / EROFS / EACCES / ENOENT) — the playlist
 *  route turns this into a 503 with the code, so a client (and the operator) can tell it apart from
 *  "no such video". */
export class HlsStorageError extends Error {
	constructor(public readonly code: string) {
		super(`HLS storage unavailable: ${code}`);
	}
}
let lastStorageWarn = 0;
const sessions = new Map<string, Session>();
let hwDisabled = false; // set once VAAPI proves unusable on this host → CPU from then on
let tonemapDisabled = false; // set once the HDR tonemap proves unrunnable (no libzimg / bad primaries) → plain 8-bit
let gpuTonemapDisabled = false; // set once tonemap_vaapi fails a real encode → HDR back to the CPU chain
let gcStarted = false;
let sweepPromise: Promise<void> | null = null; // shared one-time boot sweep (memoized so concurrent callers await the SAME completion)

const segName = (s: Session, n: number) => `seg${String(n).padStart(5, '0')}.${s.fmp4 ? 'm4s' : 'ts'}`;
const segPath = (s: Session, n: number) => path.join(s.dir, segName(s, n));
const INIT_NAME = 'init.mp4';
const initPath = (s: Session) => path.join(s.dir, INIT_NAME);

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

/** The source's first video stream: HDR (PQ/HLG transfer — gates the tonemap, since a plain 8-bit downconvert
 *  of HDR washes out grey) and its dimensions (what the adaptive downscale steps down from). */
async function probeVideo(
	abs: string
): Promise<{ hdr: boolean; pq: boolean; width: number | null; height: number | null; vcodec: string | null }> {
	try {
		const { stdout } = await execFileP('ffprobe', [
			'-v', 'error', '-select_streams', 'V:0', '-show_entries', 'stream=codec_name,color_transfer,width,height',
			'-of', 'json', abs
		], { timeout: 10_000, killSignal: 'SIGKILL' });
		const st = (JSON.parse(stdout) as {
			streams?: { codec_name?: string; color_transfer?: string; width?: number; height?: number }[];
		}).streams?.[0];
		const t = (st?.color_transfer ?? '').toLowerCase();
		return {
			hdr: t === 'smpte2084' || t === 'arib-std-b67',
			pq: t === 'smpte2084',
			width: st?.width && st.width > 0 ? st.width : null,
			height: st?.height && st.height > 0 ? st.height : null,
			vcodec: st?.codec_name ? st.codec_name.toLowerCase() : null
		};
	} catch {
		return { hdr: false, pq: false, width: null, height: null, vcodec: null };
	}
}

// ADAPTIVE DOWNSCALE — only when THIS host can't keep up, never as a default.
//
// Output starts at the source resolution. Each encoder job measures its own steady-state speed (encoded
// media seconds per wall second, from ffmpeg's -progress feed, excluding the startup/seek cost before the
// first frame). Below HLS_MIN_SPEED the player can never build a buffer — it stalls forever (field
// 2026-09-13: 4K HEVC → 4K H.264 on CPU at ~0.3× real time; the Tizen audio switch simply never played).
// Then the job restarts at its frontier one rung down this ladder, and the verdict is remembered per
// source file so later sessions of it (seeks, audio switches, the next viewer) start at that rung
// instead of re-learning it. A source already inside a rung's box skips it. A fast host, or a light
// source, is never touched. This is NOT ABR: still one rendition per session, chosen by the SERVER's
// capacity, not the viewer's bandwidth.
const SCALE_LADDER = [
	{ w: 1920, h: 1080 },
	{ w: 1280, h: 720 }
];
const HLS_MIN_SPEED = 1.05; // steady-state encode speed below which playback cannot keep a buffer
const SPEED_WINDOW_MS = 10_000; // how long a job is measured before the verdict
const slowSources = new Map<string, number>(); // probe key → ladder rung this host needed for that file

/** Output dimensions at ladder rung `step` (0 = source), or null when that rung wouldn't shrink the source. */
function scaledSize(width: number | null, height: number | null, step: number): { w: number; h: number } | null {
	if (step <= 0 || !width || !height) return null;
	const box = SCALE_LADDER[Math.min(step, SCALE_LADDER.length) - 1];
	const r = Math.min(box.w / width, box.h / height);
	if (r >= 1) return null;
	const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
	return { w: even(width * r), h: even(height * r) };
}
/** The next rung that actually shrinks this source, or null when there's nowhere left to go. */
function nextScaleStep(s: Session): number | null {
	for (let k = s.scaleStep + 1; k <= SCALE_LADDER.length; k++) {
		if (scaledSize(s.width, s.height, k)) return k;
	}
	return null;
}

/**
 * Which audio stream to transcode. Returns an ABSOLUTE stream index, or null for "let ffmpeg decide".
 *
 * `-map 0:a:0?` — the previous behaviour — always took the FIRST audio stream and ignored what the
 * file itself says. On a release whose first track is a dub and whose second is the original, that
 * plays the wrong language every single time, consistently enough to look like a setting rather than
 * a bug. Containers record the answer in the `default` disposition, and *arr-style rips set it; we
 * simply never read it. (ffmpeg's own automatic selection doesn't help — it picks by channel count,
 * not disposition.)
 *
 * Still a fallback, not a chooser: a viewer who wants a NON-default track needs a picker, which is a
 * separate feature (the track has to be selected server-side, since HTML5 video cannot switch audio
 * tracks inside a container).
 */
async function probeDefaultAudio(abs: string): Promise<number | null> {
	try {
		const { stdout } = await execFileP('ffprobe', [
			'-v', 'error', '-select_streams', 'a',
			'-show_entries', 'stream=index:stream_disposition=default',
			'-of', 'json', abs
		], { timeout: 10_000, killSignal: 'SIGKILL' });
		const streams = (JSON.parse(stdout) as {
			streams?: { index: number; disposition?: Record<string, number> }[];
		}).streams ?? [];
		if (streams.length <= 1) return null; // one track (or none): nothing to choose, keep ffmpeg's
		const flagged = streams.find((st) => st.disposition?.default);
		return (flagged ?? streams[0]).index;
	} catch {
		return null;
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
/** The file's streams, probed once per (path, mtime) and shared by session start and the
 *  descriptor's copy-eligibility answer. */
async function probeFile(srcAbs: string, cacheKey: string) {
	let probed = probeCache.get(cacheKey);
	if (!probed) {
		probed = {
			duration: await probeDuration(srcAbs),
			...(await probeVideo(srcAbs)),
			audio: await probeDefaultAudio(srcAbs),
			acodecs: await probeAudioCodecs(srcAbs)
		};
		if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear();
		probeCache.set(cacheKey, probed);
	}
	return probed;
}

/** Would `?mode=copy` (narrowed by `copyVideo`, contract §HLS `copyv`) copy this file's DEFAULT track
 *  pair, or encode it? The descriptor's `playback.hlsCopy` — decided on the REAL probe, not the
 *  catalog's codec fields (an NFO without <streamdetails> says nothing; a wrong one would misroute).
 *  Memoised with the session probe, so the second ask is free. false when HLS is off or unprobeable. */
export async function copyEligible(videoId: string, copyVideo: Set<string> | null): Promise<boolean> {
	if (!HLS_DIR) return false;
	const row = db().prepare('SELECT video_path FROM videos WHERE id = ?').get(videoId) as
		| { video_path: string }
		| undefined;
	if (!row) return false;
	let srcAbs: string;
	let mtimeMs: number;
	try {
		const r = await resolveInMediaRoot(row.video_path);
		srcAbs = r.absPath;
		mtimeMs = r.stat.mtimeMs;
	} catch {
		return false;
	}
	const p = await probeFile(srcAbs, `${srcAbs}:${mtimeMs}`);
	const aIdx = p.audio ?? [...p.acodecs.keys()][0];
	const acodec = aIdx != null ? p.acodecs.get(aIdx) : undefined;
	return !!(
		p.vcodec &&
		COPY_VIDEO.has(p.vcodec) &&
		(copyVideo == null || copyVideo.has(p.vcodec)) &&
		acodec &&
		COPY_AUDIO.has(acodec)
	);
}

const probeCache = new Map<
	string,
	{
		duration: number | null;
		hdr: boolean;
		pq: boolean;
		width: number | null;
		height: number | null;
		audio: number | null;
		vcodec: string | null;
		acodecs: Map<number, string>;
	}
>();
const PROBE_CACHE_MAX = 512;

// Bound TOTAL session entries (temp dirs + Map rows). HLS_MAX_SESSIONS caps concurrent ENCODERS at
// segment time, but nothing capped playlist-time minting — sessions are retained HLS_SESSION_TTL
// (30 min), so a playlist flood accumulated dirs and Map entries freely.
const MAX_TOTAL_SESSIONS = (HLS_MAX_SESSIONS + HLS_MAX_COPY_SESSIONS) * 4;

/** Thrown when every session slot is genuinely in use: the route answers 503 + Retry-After (a WAIT),
 *  never the 404 that a client reads as "gone" (owner field 2026-09-23: a batch of downloads filled
 *  the table and the rest failed with CoreMedia -12884 instead of queueing). */
export class HlsBusyError extends Error {
	/** How long the client should wait before asking again (the route's Retry-After). */
	readonly retryAfter: number;
	constructor(reason: 'table full' | 'keyframe scan running', retryAfter = 30) {
		super(reason === 'table full' ? 'hls: every session slot is in use' : 'hls: keyframe scan still running for this file');
		this.retryAfter = retryAfter;
	}
}

/** A DOWNLOAD session whose every segment has been fetched and whose ffmpeg is gone: nothing will ask
 *  it for anything again, so it is the first thing to reclaim when the table is full. */
function isFinishedDownload(s: Session): boolean {
	if (!s.download || s.active) return false;
	const last = s.bounds ? s.bounds.length - 1 : Math.ceil(s.duration / SEG) - 1;
	return s.everFetched && s.lastFetched >= last;
}

/**
 * What the live transcoder can actually do ON THIS HOST — the About page's playback report.
 *
 * `hwaccel` is the state RIGHT NOW, not the configured wish: 'off' = never asked for,
 * 'unavailable' = asked for but the render node is missing or VAAPI already failed a real encode
 * (the `hwDisabled` latch, so this flips mid-run the first time it's disproved), 'on' = asked for
 * and not disproved. That distinction is the whole point — an owner who set TRANSCODE_HWACCEL=1
 * has no other way to find out their container never got /dev/dri passed through.
 */
export function hlsStatus(): {
	enabled: boolean;
	hwaccel: 'off' | 'on' | 'unavailable';
	device: boolean;
	encoding: number;
	sessions: number;
	maxEncoders: number;
	/** Stream-copy sessions running (their own pool — no encoder involved) and that pool's cap. */
	copying: number;
	maxCopies: number;
} {
	const device = existsSync(VAAPI_DEVICE);
	return {
		enabled: HLS_DIR != null,
		hwaccel: !TRANSCODE_HWACCEL ? 'off' : hwDisabled || !device ? 'unavailable' : 'on',
		device,
		encoding: activeCount(),
		sessions: sessions.size,
		maxEncoders: maxEncoders(),
		copying: copyCount(),
		maxCopies: HLS_MAX_COPY_SESSIONS
	};
}

let ffmpegProbe: Promise<string | null> | null = null;

/** ffmpeg's version string, probed once per process (the binary can't change under a running
 *  container). null = not on PATH — which means no live transcode AND no image cache, the one
 *  server-side fact worth surfacing in the UI because everything else still looks fine. */
export function ffmpegVersion(): Promise<string | null> {
	ffmpegProbe ??= execFileP('ffmpeg', ['-version'], { timeout: 5000 })
		.then(({ stdout }) => /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'present')
		.catch(() => null);
	return ffmpegProbe;
}

/** Create (or reuse) a session for a video (called by the index.m3u8 route AFTER auth). Returns
 *  { sid, playlist } or null (disabled / unknown video / unreadable source / unknown duration / full). */
export async function startHlsSession(
	videoId: string,
	fed: { linkId: number; key: string } | null = null,
	audioIndex: number | null = null,
	wantCopy = false,
	copyVideo: Set<string> | null = null,
	download = false,
	/** fMP4 segments for a COPY (contract §HLS `fmt=fmp4`): HEVC rides untouched for Apple. */
	fmp4 = false,
	/** A client PROBE (`probe=1`): answer at once — 503 while the keyframe scan runs, never a 20 s hold —
	 *  so a queue can ask about many files in parallel without serialising on the waits. */
	probe = false
): Promise<{ sid: string; playlist: string } | null> {
	return startHlsSessionImpl(videoId, fed, audioIndex, wantCopy, copyVideo, download, fmp4, probe);
}

async function startHlsSessionImpl(
	videoId: string,
	fed: { linkId: number; key: string } | null,
	audioIndex: number | null,
	wantCopy: boolean,
	/** Narrow the copy allowlist to what THIS client's demuxer takes in TS (contract §HLS `copyv`):
	 *  Apple plays H.264 in TS but HEVC only in fMP4, so an Apple download asks `copyv=h264` and an
	 *  HEVC source is ENCODED rather than copied into something AVPlayer refuses. null = engine default. */
	copyVideo: Set<string> | null,
	download: boolean,
	fmp4: boolean,
	probe = false
): Promise<{ sid: string; playlist: string } | null> {
	if (!HLS_DIR) return null;
	// Playlist refetch collapse: reuse a just-minted session for the same video that nobody has pulled
	// a segment from yet (the Safari/AVPlayer multi-fetch at start), instead of minting a dir + probes
	// per GET. Once a segment has been fetched the session is someone's live playback — never shared.
	for (const s of sessions.values()) {
		// Must match the requested AUDIO too: two viewers on the same film in different languages are
		// two different encodes, and collapsing them would hand one of them the other's soundtrack.
		// Match on what was ASKED FOR, not on the resolved stream: `null` means "the file's default",
		// which is only known after a probe — comparing loosely would let a request for the default
		// collapse onto a session someone minted for an explicit second language.
		if (
			s.videoId === videoId &&
			s.reqAudio === audioIndex &&
			s.reqCopy === wantCopy && // a copy playlist and an encode playlist address DIFFERENT segments
			s.download === download &&
			s.fmp4 === (fmp4 && s.copy) &&
			!s.everFetched &&
			Date.now() - s.createdAt < 20_000
		) {
			s.lastAccess = Date.now();
			return { sid: s.id, playlist: buildPlaylist(s) };
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
	const probed = await probeFile(srcAbs, cacheKey);
	const duration = probed.duration ?? (row.duration && row.duration > 0 ? row.duration : null);
	if (!duration) return null;
	const hdr = probed.hdr;
	// Copy eligibility: what TS can carry for the chosen track pair. Refused silently → a normal encode.
	let bounds: number[] | null = null;
	let copyEnd = duration;
	if (wantCopy) {
		const aIdx = audioIndex ?? probed.audio ?? [...probed.acodecs.keys()][0];
		const acodec = aIdx != null ? probed.acodecs.get(aIdx) : undefined;
		const vOk = probed.vcodec && COPY_VIDEO.has(probed.vcodec) && (copyVideo == null || copyVideo.has(probed.vcodec));
		if (vOk && acodec && COPY_AUDIO.has(acodec)) {
			const scan = await Promise.race([
				scanKeyframes(srcAbs, cacheKey),
				new Promise<undefined>((r) =>
					setTimeout(r, probe ? 0 : download ? KEYFRAME_SCAN_BUDGET_PATIENT_MS : KEYFRAME_SCAN_BUDGET_MS)
				)
			]);
			if (scan) {
				// The playlist must end where the DATA ends, not where the header claims it does.
				copyEnd = Math.min(duration, scan.end + 0.1);
				const inRange = scan.keys.filter((t) => t < copyEnd);
				bounds = inRange.length ? copyBoundaries(inRange) : null;
			} else if (download) {
				// A download would rather come back in a moment than take an encoder slot its client
				// never reserved: say WAIT, the scan keeps running (memoised; a 4 GB file over NFS can
				// take minutes the first time).
				throw new HlsBusyError('keyframe scan running', 20);
			}
		}
	}
	// At the total-session cap: evict the OLDEST never-fetched session (mint-storm leftovers). If every
	// session is genuinely being watched, refuse — the route 404s and the client retries/fails soft.
	if (sessions.size >= MAX_TOTAL_SESSIONS) {
		let victim: Session | null = null;
		// Finished downloads first: they hold a slot for the TTL though nothing will ever fetch again.
		for (const s of sessions.values()) {
			if (isFinishedDownload(s) && (!victim || s.lastAccess < victim.lastAccess)) victim = s;
		}
		if (!victim) {
			for (const s of sessions.values()) {
				if (!s.everFetched && (!victim || s.createdAt < victim.createdAt)) victim = s;
			}
		}
		// Nothing never-fetched → reclaim the longest-IDLE fetched one, if it's past the encoder reap. Those
		// are abandoned retries/switches that TTL (30 min) would otherwise pin, 404-ing every new playlist
		// for half an hour after a client retry storm. A paused viewer loses only the re-mint shortcut:
		// their next segment 404s, the same wall a TTL-expired session hits (web re-mints at the same spot).
		if (!victim) {
			const idleBefore = Date.now() - HLS_IDLE_SEC * 1000;
			for (const s of sessions.values()) {
				if (s.lastAccess < idleBefore && (!victim || s.lastAccess < victim.lastAccess)) victim = s;
			}
		}
		if (!victim) throw new HlsBusyError('table full'); // every slot genuinely in use → the route says WAIT (503)
		destroySession(victim);
		sessions.delete(victim.id);
	}
	if (!existsSync(HLS_DIR)) mkdirSync(HLS_DIR, { recursive: true });
	await sweepOrphans(); // before mkdtemp, so we never delete the dir we're about to create
	const sid = crypto.randomBytes(16).toString('hex');
	let dir: string;
	try {
		dir = mkdtempSync(path.join(HLS_DIR, 'sess-'));
	} catch (e) {
		// A full / read-only / missing transcode volume is an OPERATOR problem, not a bug in this
		// request: say so once per minute in the log and let the route answer 503, not a stack trace.
		const code = (e as NodeJS.ErrnoException).code ?? 'error';
		if (Date.now() - lastStorageWarn > 60_000) {
			lastStorageWarn = Date.now();
			console.error(
				`[mytview] HLS: cannot create a session dir in ${HLS_DIR} (${code}) — ` +
					`check the transcode volume's space and permissions; every HLS start fails until it is fixed`
			);
		}
		throw new HlsStorageError(code);
	}
	sessions.set(sid, {
		// An explicitly CHOSEN track wins over the file's default. Validated by the caller against the
		// file's real streams, so this can only ever be one of them.
		id: sid, videoId, srcAbs, dir, duration: bounds ? copyEnd : duration, audio: audioIndex ?? probed.audio, reqAudio: audioIndex,
		active: null, createdAt: Date.now(), lastAccess: Date.now(), lastFetched: 0, everFetched: false,
		fed, frontier: 0, paused: false, hdr, pq: probed.pq, width: probed.width, height: probed.height,
		// A download ENCODE (never a copy — copies are untouched bytes) tops out at the 1080p box: on a
		// phone or tablet nothing above it is visible, a 4K encode on a home CPU runs at a fraction of
		// real time, and the copy would take hours (owner 2026-09-24). Sources at or under 1080p keep
		// their size; playback keeps the source resolution until the host proves it can't keep up.
		probeKey: cacheKey, scaleStep: download ? (scaledSize(probed.width, probed.height, 1) ? 1 : 0) : (slowSources.get(cacheKey) ?? 0),
		copy: bounds != null, bounds, reqCopy: wantCopy, download,
		fmp4: bounds != null && fmp4, vcodec: probed.vcodec
	});
	startGc();
	return { sid, playlist: buildPlaylist(sessions.get(sid)!) };
}

/** Complete VOD playlist (real length + seekbar up front), segments as session-scoped absolute URLs.
 *  Encode sessions: a fixed SEG grid (the encoder forces a keyframe per segment). Copy sessions: the
 *  REAL segment starts (source keyframes), so every EXTINF is exact and TARGETDURATION covers the
 *  longest GOP. */
function buildPlaylist(s: Session): string {
	const sig = hlsQuery(s.id); // one signature for the whole session's segments
	if (s.copy && s.bounds) {
		const b = s.bounds;
		const durs = b.map((t, i) => (i < b.length - 1 ? b[i + 1] - t : Math.max(0.1, s.duration - t)));
		const target = Math.ceil(Math.max(...durs));
		let m = s.fmp4
			? `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="/hls/s/${s.id}/${INIT_NAME}?${sig}"\n`
			: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
		durs.forEach((d, i) => {
			m += `#EXTINF:${d.toFixed(6)},\n/hls/s/${s.id}/${segName(s, i)}?${sig}\n`;
		});
		return m + '#EXT-X-ENDLIST\n';
	}
	const n = Math.ceil(s.duration / SEG);
	let m = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
	for (let i = 0; i < n; i++) {
		const dur = i < n - 1 ? SEG : s.duration - (n - 1) * SEG;
		m += `#EXTINF:${dur.toFixed(6)},\n/hls/s/${s.id}/${segName(s, i)}?${sig}\n`;
	}
	return m + '#EXT-X-ENDLIST\n';
}

/** Ensure segment `n` of a session is produced (start / restart-at-offset / wait) and return its file
 *  PATH for the route to stream. null → capped / timed out / unknown session (route → 404/503). The `sid`
 *  is the capability (unguessable, handed out only by an authed index.m3u8) — same model as a share token. */
/** The federation attribution (if any) of a live session — for the segment route's metering. */
export function hlsSessionFed(sid: string): { linkId: number; key: string } | null {
	return sessions.get(sid)?.fed ?? null;
}

/** The fMP4 init section of a copy session (ensures the from-zero run has started, waits for the
 *  file). null for a TS session, an unknown session, or a timeout. */
export async function hlsInit(sid: string): Promise<string | null> {
	const s = sessions.get(sid);
	if (!s || !s.fmp4) return null;
	s.lastAccess = Date.now();
	s.everFetched = true;
	if (!ensureCovers(s, s.lastFetched)) return null;
	if (!(await waitFor(initPath(s), 45000))) return null;
	return initPath(s);
}

export async function hlsSegment(sid: string, n: number): Promise<string | null> {
	const s = sessions.get(sid);
	if (!s || !Number.isInteger(n) || n < 0) return null;
	if (s.copy && s.bounds && n >= s.bounds.length) return null; // past the last real segment
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
/** The encoder cap in force: the owner's explicit HLS_MAX_SESSIONS, else 6 while the hardware encoder
 *  is really usable and 3 the moment it is not (VAAPI disproved, or the render node absent). */
function maxEncoders(): number {
	if (HLS_MAX_SESSIONS_EXPLICIT) return HLS_MAX_SESSIONS;
	return TRANSCODE_HWACCEL && !hwDisabled && existsSync(VAAPI_DEVICE) ? 6 : 3;
}

function activeCount(): number {
	// Count only ENCODERS actually using the CPU — a throttle-frozen (SIGSTOP'd) session isn't, so it must not
	// pin a concurrency slot against a genuinely new stream; a stream COPY has no encoder (own pool below).
	let c = 0;
	for (const s of sessions.values()) if (s.active && !s.paused && !s.copy) c++;
	return c;
}

function copyCount(): number {
	let c = 0;
	for (const s of sessions.values()) if (s.active && !s.paused && s.copy) c++;
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
	// A home box only serves a few ENCODES; copies are near-free and have their own, larger pool.
	if (!s.active && (s.copy ? copyCount() >= HLS_MAX_COPY_SESSIONS : activeCount() >= maxEncoders())) return false;
	spawnAt(s, n); // a real seek (or first play) → (re)start the encode here
	return true;
}

/** One -progress sample for `job` (media seconds encoded so far). Takes a baseline at the first frame, then
 *  after SPEED_WINDOW_MS judges the steady-state speed ONCE per job — too slow → one rung down, at the frontier. */
function onProgress(s: Session, job: NonNullable<Session['active']>, out: number) {
	// A copy has no encoder to slow down — but it runs at DISK speed, so the 5s GC tick alone let it dump
	// a whole episode into segments before the first freeze (a 500 MB file copies in seconds; the
	// transcode volume filled up and every HLS start 500'd with ENOSPC — production 2026-09-21).
	// Throttle on every progress sample instead (the copy job reports every 100 ms).
	if (s.copy) {
		throttle(s);
		return;
	}
	if (job.done || s.active !== job || s.paused) return;
	const now = Date.now();
	if (!job.speed) {
		if (out > 0) job.speed = { wall: now, out }; // first real frame: startup + input seek are behind us
		return;
	}
	if (now - job.speed.wall < SPEED_WINDOW_MS) return;
	job.done = true;
	if (s.download) return; // a copy for the shelf keeps the source resolution, however slow the host
	const speed = (out - job.speed.out) / ((now - job.speed.wall) / 1000);
	if (speed >= HLS_MIN_SPEED) return;
	const step = nextScaleStep(s);
	if (step == null) return; // already as small as the ladder goes (or the source is) — nothing to trade
	const to = scaledSize(s.width, s.height, step)!;
	console.warn(
		`[mytview] HLS: ${s.videoId} encoding at ${speed.toFixed(2)}x real time at ` +
			`${scaledSize(s.width, s.height, s.scaleStep)?.w ?? s.width}px wide — this host can't keep up, ` +
			`continuing at ${to.w}x${to.h}`
	);
	s.scaleStep = step;
	if (slowSources.size >= PROBE_CACHE_MAX) slowSources.clear();
	slowSources.set(s.probeKey, Math.max(step, slowSources.get(s.probeKey) ?? 0));
	spawnAt(s, frontier(s)); // produced segments stay; everything from the frontier on comes out smaller
}

function spawnAt(s: Session, start: number) {
	if (s.active) s.active.proc.kill('SIGKILL'); // abandon the position the user left
	const proc = spawn('ffmpeg', ffmpegArgs(s, start), { stdio: ['ignore', 'pipe', 'pipe'] });
	const job = { start, proc, speed: null as { wall: number; out: number } | null, done: false };
	s.active = job;
	// -progress feed (stdout; always drained, so the pipe can never fill and block ffmpeg).
	let buf = '';
	proc.stdout?.on('data', (d) => {
		buf += d.toString();
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // _ms is microseconds too (old ffmpeg naming)
			if (m) onProgress(s, job, Number(m[1]) / 1e6);
		}
	});
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
		// Most specific first: a tonemap_vaapi failure also matches the generic VAAPI and CPU-tonemap patterns,
		// and must disable only the GPU tonemap — not VAAPI for every SDR stream, nor the CPU tonemap.
		if (code && code !== 0 && !gpuTonemapDisabled && /tonemap_vaapi/i.test(err)) {
			gpuTonemapDisabled = true;
			console.warn('[mytview] HLS: GPU HDR tonemap failed — HDR sources fall back to the CPU tonemap');
		} else if (code && code !== 0 && !hwDisabled && TRANSCODE_HWACCEL && /vaapi|Device creation|renderD128/i.test(err)) {
			hwDisabled = true; // VAAPI unusable on this host → CPU from now on; the next segment restarts on CPU
			console.warn('[mytview] HLS: VAAPI unavailable — using CPU for live transcode');
		}
		if (code && code !== 0 && !tonemapDisabled && !/tonemap_vaapi/i.test(err) && /zscale|tonemap|zimg|no such filter/i.test(err)) {
			tonemapDisabled = true; // HDR tonemap can't run here → plain 8-bit (washed-out but playable) from now on
			console.warn('[mytview] HLS: HDR tonemap unavailable — falling back to a plain 8-bit downconvert');
		}
	});
}

function ffmpegArgs(s: Session, start: number): string[] {
	if (s.copy && s.bounds) {
		// STREAM COPY — see the block comment at COPY_COARSE_SEEK for why the seek is built this way.
		const t = s.bounds[start] ?? s.bounds[s.bounds.length - 1];
		const trimAt = t - COPY_TRIM_LEAD;
		const inSeek = Math.max(0, t - COPY_COARSE_SEEK);
		// Within the lead of the file's start there is nothing to trim: play from the first packet, and
		// the first segment IS boundary 0 (the from-zero run is what the boundaries were verified against).
		const seek = trimAt > 0
			? { pre: ['-ss', String(inSeek)], post: ['-ss', String(trimAt - inSeek), '-output_ts_offset', String(trimAt)] }
			: { pre: [], post: [] };
		return [
			'-nostdin', '-y',
			// The ahead-throttle runs off THIS feed for a copy (see onProgress): a fine period keeps the
			// burst between freezes to ~100 ms of disk writes, not the 5 s GC tick.
			'-nostats', '-progress', 'pipe:1', '-stats_period', '0.1',
			...seek.pre, '-i', s.srcAbs, ...seek.post,
			'-map', '0:V:0', '-map', s.audio != null ? `0:${s.audio}` : '0:a:0?',
			'-c', 'copy', '-sn', '-dn', // text + data tracks dropped: the demuxer relief this mode exists for
			// fMP4: Apple takes HEVC in HLS only as CMAF, and only tagged `hvc1` (not ffmpeg's default `hev1`).
			...(s.fmp4 && s.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
			'-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-start_number', String(start),
			'-hls_flags', 'temp_file',
			...(s.fmp4 ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', INIT_NAME] : []),
			'-hls_segment_filename', path.join(s.dir, `seg%05d.${s.fmp4 ? 'm4s' : 'ts'}`),
			path.join(s.dir, 'ff.m3u8')
		];
	}
	const off = start * SEG;
	// HDR10 goes through the GPU too: decode + tonemap_vaapi + h264_vaapi. It used to be excluded ("VAAPI
	// tonemapping is unreliable") without ever being measured; on the field iGPU (Intel iHD, 2026-09-13) the
	// full-GPU chain ran 4K HDR10 at 4.37x real time, while the all-CPU zscale chain managed 0.014x and was
	// OOM-killed (4K gbrpf32le frames). A failed GPU tonemap latches gpuTonemapDisabled → the CPU chain.
	const gpuTonemap = s.hdr && s.pq && !gpuTonemapDisabled;
	const hw = TRANSCODE_HWACCEL && !hwDisabled && (!s.hdr || gpuTonemap);
	const useTonemap = s.hdr && !tonemapDisabled; // HDR, unless the tonemap already proved unrunnable → plain 8-bit
	const size = scaledSize(s.width, s.height, s.scaleStep); // null = source resolution (the default)
	const cpuScale = size ? `scale=${size.w}:${size.h},` : ''; // scale BEFORE the tonemap: far fewer pixels to map
	// -ss BEFORE -i = fast input seek to the keyframe ≤ off; -output_ts_offset shifts PTS back to `off` so
	// seg N lines up with the playlist timeline; -start_number N names the segments absolutely. Force 8-bit
	// (yuv420p / nv12) — 10-bit HEVC → H.264 High10 is undecodable by browsers/MSE. Audio → AAC-LC stereo.
	return [
		'-nostdin', '-y',
		'-nostats', '-progress', 'pipe:1', // machine-readable progress on stdout → the speed measurement
		...(hw ? ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-vaapi_device', VAAPI_DEVICE] : []),
		'-ss', String(off), '-i', s.srcAbs,
		// Audio: the stream the FILE flags as default, not simply the first one (probeDefaultAudio).
		'-map', '0:V:0', '-map', s.audio != null ? `0:${s.audio}` : '0:a:0?',
		...(hw
			? ['-vf', (s.hdr ? 'tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,' : '') +
					(size ? `scale_vaapi=w=${size.w}:h=${size.h}:format=nv12` : 'scale_vaapi=format=nv12'),
				'-c:v', 'h264_vaapi', '-low_power', '1', '-qp', '23']
			: useTonemap
				? ['-vf', cpuScale + TONEMAP_VF, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'] // tonemap chain ends in yuv420p
				: [...(size ? ['-vf', cpuScale.slice(0, -1)] : []),
					'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
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
		s.active.done = true; // raced a full buffer ahead → fast enough; a frozen clock must not read as slow
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
