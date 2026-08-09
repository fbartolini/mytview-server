/**
 * WS-I — on-demand thumbnail/poster/fanart downscaling with a disk cache. The 10-foot TV UI and phone
 * grids request a small `?w=<width>` variant instead of the full ≤1280px source, so they download +
 * decode far less (the documented first-paint fix — DESIGN §8). Resized with ffmpeg (already a system
 * dep for transcoding — no new npm dep) into a DISPOSABLE cache dir; on ANY failure (no ffmpeg, decode
 * error, disabled) the caller falls back to serving the original, so images never break.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { IMAGE_CACHE_DIR } from './config';

// A small fixed set of widths so the cache can't be blown up by arbitrary `?w` values and clients
// converge on cacheable sizes. A request snaps UP to the nearest bucket.
const WIDTH_BUCKETS = [160, 240, 320, 480, 640, 960, 1280];
const MAX_WIDTH = WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1];

/** Snap a requested width up to the nearest cache bucket, or null if `raw` isn't a positive number. */
export function bucketWidth(raw: string | null): number | null {
	const n = raw ? parseInt(raw, 10) : NaN;
	if (!Number.isFinite(n) || n <= 0) return null;
	for (const b of WIDTH_BUCKETS) if (n <= b) return b;
	return MAX_WIDTH;
}

// Set once ffmpeg is found missing (ENOENT) so we don't spawn-and-fail on every request — from then
// on resizedImage returns null immediately and callers serve the original. Reset on restart.
let ffmpegMissing = false;

// Dedupe concurrent generation of the same output (two grid requests for the same thumb+size).
const inflight = new Map<string, Promise<boolean>>();

// BOUNDED generation — what makes default-on safe: at most GEN_CONCURRENCY resizes run at once, the
// rest queue FIFO. A request that can't start immediately is told so (`immediate: false`) and serves
// the ORIGINAL right away while its job warms the cache for the next hit. The first on-demand shape
// blocked every request on an unbounded spawn herd (a cold 60-card grid = 60 concurrent ffmpegs),
// which is why the cache used to ship opt-in-only.
const GEN_CONCURRENCY = 4;
let generating = 0;
const genQueue: Array<() => void> = [];
const pump = (): void => {
	while (generating < GEN_CONCURRENCY && genQueue.length) genQueue.shift()!();
};

/** Dedupe + bound a generation job. `immediate` = a slot was free (or the job already existed) and
 *  the caller may reasonably await `p`; false = saturated, the caller should serve the original. */
function scheduleGenerate(
	src: string,
	out: string,
	width: number
): { p: Promise<boolean>; immediate: boolean } {
	const existing = inflight.get(out);
	if (existing) return { p: existing, immediate: true };
	const run = async (): Promise<boolean> => {
		generating++;
		try {
			return await generate(src, out, width);
		} finally {
			generating--;
			pump();
		}
	};
	const immediate = generating < GEN_CONCURRENCY;
	const p = (
		immediate ? run() : new Promise<boolean>((res) => genQueue.push(() => void run().then(res)))
	).finally(() => inflight.delete(out));
	inflight.set(out, p);
	return { p, immediate };
}

function cachePath(srcAbs: string, mtimeMs: number, width: number): string {
	// Key on source path + mtime + width: a replaced/re-indexed source naturally misses (new mtime),
	// so stale variants are never served and don't need explicit invalidation.
	const key = createHash('sha1').update(`${srcAbs}\0${Math.round(mtimeMs)}\0${width}`).digest('hex');
	return path.join(IMAGE_CACHE_DIR as string, `${key}.jpg`);
}

/**
 * A cached JPEG of `srcAbs` scaled to `width` (bucketed; never upscaled past the source), generating
 * it via ffmpeg on a miss. Returns {absPath, stat} for serveFile, or null on any failure/disabled —
 * the caller then serves the original.
 */
export async function resizedImage(
	srcAbs: string,
	srcStat: Stats,
	width: number
): Promise<{ absPath: string; stat: Stats } | null> {
	if (!IMAGE_CACHE_DIR || ffmpegMissing) return null;
	const out = cachePath(srcAbs, srcStat.mtimeMs, width);
	try {
		return { absPath: out, stat: await stat(out) }; // cache hit
	} catch {
		/* miss → generate below */
	}
	const { p, immediate } = scheduleGenerate(srcAbs, out, width);
	// Saturated: never make this request wait in line — the caller streams the ORIGINAL now, and the
	// queued job means the variant is there for the next request.
	if (!immediate) return null;
	if (!(await p)) return null;
	try {
		return { absPath: out, stat: await stat(out) };
	} catch {
		return null;
	}
}

/** Scan-time prebake entry (the indexer's post-scan warmer): ensure the variant exists, WAITING for
 *  its bounded turn — the warmer calls this sequentially, so it holds at most ONE of the slots and
 *  live requests always find capacity. A cache hit is a single stat(). */
export async function warmImage(srcAbs: string, srcStat: Stats, width: number): Promise<void> {
	if (!IMAGE_CACHE_DIR || ffmpegMissing) return;
	const out = cachePath(srcAbs, srcStat.mtimeMs, width);
	try {
		await stat(out);
		return; // already cached
	} catch {
		/* miss → generate */
	}
	await scheduleGenerate(srcAbs, out, width).p;
}

async function generate(src: string, out: string, width: number): Promise<boolean> {
	const tmp = `${out}.${process.pid}.${Date.now()}.tmp`; // unique partial; atomically renamed on success
	try {
		await mkdir(path.dirname(out), { recursive: true });
		await runFfmpegResize(src, tmp, width);
		await rename(tmp, out); // atomic publish
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') ffmpegMissing = true; // ffmpeg not installed
		await unlink(tmp).catch(() => {});
		return false;
	}
}

function runFfmpegResize(src: string, out: string, width: number): Promise<void> {
	// scale='min(W,iw)':-2 → cap at the source width (never upscale), keep aspect, even height.
	// -frames:v 1 = a single still; -q:v 3 = good JPEG quality; -f image2 forces the muxer (.tmp name).
	// Args as an array (no shell) → a path can't inject anything.
	const args = [
		'-nostdin', '-y',
		'-i', src,
		'-frames:v', '1',
		'-vf', `scale='min(${width},iw)':-2`,
		'-q:v', '3',
		'-f', 'image2',
		out
	];
	return new Promise((resolve, reject) => {
		const proc = spawn('ffmpeg', args, {
			stdio: ['ignore', 'ignore', 'pipe'],
			timeout: 30_000,
			killSignal: 'SIGKILL'
		});
		let err = '';
		proc.stderr?.on('data', (d) => {
			err += d.toString();
			if (err.length > 4000) err = err.slice(-4000);
		});
		proc.on('error', reject); // ENOENT (ffmpeg missing), killed, etc.
		proc.on('close', (code) =>
			code === 0
				? resolve()
				: reject(new Error(`ffmpeg exit ${code}: ${err.trim().split('\n').slice(-2).join(' / ')}`))
		);
	});
}
