/**
 * The async-indexer contract: a scan must never park the event loop. All indexer fs I/O goes through
 * fs.promises and the prune deletes in chunks (indexer.ts header) — this test scans a large synthetic
 * library while sampling event-loop lag, and fails if any single stall exceeds the bound. Honest
 * scope: on this test's fast local tmpdir, per-file sync fs calls are microseconds, so a stray
 * `statSync` alone won't trip it (that class only hurts on slow/NAS storage and is enforced by the
 * indexer-header rule + review). What it DOES catch is the unyielded-stretch class: an unchunked
 * prune/upsert transaction, a batching regression, or any long synchronous sweep added to scan().
 * The bound is generous because CI machines jitter; the target is order-of-magnitude regressions.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeMovie, writeChannelVideo } from './helpers';

const env = tempEnv();
const { scan, runScan, scanStatus } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');

const MOVIES = 400;
const CHANNEL_VIDEOS = 300;
const MAX_STALL_MS = 250;

/** Longest observed gap beyond schedule between 5ms timer ticks while `work` runs — i.e. the worst
 *  single event-loop stall. Coalesced timers mean a blocked loop shows up as ONE big gap. */
async function maxStallDuring<T>(work: () => Promise<T>): Promise<{ result: T; maxStall: number }> {
	let max = 0;
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		const gap = now - last - 5;
		if (gap > max) max = gap;
		last = now;
	}, 5);
	try {
		const result = await work();
		return { result, maxStall: max };
	} finally {
		clearInterval(timer);
	}
}

describe('scan never blocks the event loop', () => {
	afterAll(() => env.cleanup());

	it('stays responsive scanning a large library, and while pruning most of it', async () => {
		for (let i = 0; i < MOVIES; i++) {
			writeMovie(env.mediaRoot, 'Movies', `Movie ${i} (2020)`, {
				nfo: `<movie><title>Movie ${i}</title><year>2020</year><genre>Drama</genre>` +
					`<uniqueid type="tmdb">${100000 + i}</uniqueid></movie>`,
				poster: true,
				fanart: true
			});
		}
		for (let i = 0; i < CHANNEL_VIDEOS; i++) {
			writeChannelVideo(env.mediaRoot, `Chans/chan${i % 10}`, `vid${i}`);
		}
		addLibrary('Movies', 'Movies', 'movies', false);
		addLibrary('Chans', 'Chans', 'channels', false);

		const first = await maxStallDuring(() => scan());
		console.info(`[scan-eventloop] index max stall: ${first.maxStall.toFixed(1)}ms`);
		expect(first.result.videos).toBe(MOVIES + CHANNEL_VIDEOS);
		expect(first.maxStall).toBeLessThan(MAX_STALL_MS);

		// Remove most movies → the next scan prunes them; the chunked prune must stay responsive too.
		for (let i = 0; i < MOVIES - 20; i++) {
			rmSync(path.join(env.mediaRoot, 'Movies', `Movie ${i} (2020)`), { recursive: true });
		}
		const second = await maxStallDuring(() => scan());
		console.info(`[scan-eventloop] prune max stall: ${second.maxStall.toFixed(1)}ms`);
		expect(second.result.pruned).toBe(MOVIES - 20);
		expect(second.result.videos).toBe(20 + CHANNEL_VIDEOS);
		expect(second.maxStall).toBeLessThan(MAX_STALL_MS);
	}, 60_000);

	// The user-facing feedback contract: while a scan runs, scanStatus().progress names the library
	// being walked with a running count (shipped verbatim by /api/status + /api/v1/status); when the
	// scan ends it clears. Polls the live status while a real runScan() chews the tree from above.
	it('exposes live per-library progress while scanning, cleared after', async () => {
		const run = runScan(true); // full re-parse of the 320 items left by the previous test
		const libsSeen = new Set<string | null>();
		let sawVideos = 0;
		while (scanStatus().scanning) {
			const p = scanStatus().progress;
			if (p) {
				libsSeen.add(p.library);
				sawVideos = Math.max(sawVideos, p.videos);
			}
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(await run).not.toBeNull();
		expect([...libsSeen].some((l) => l === 'Movies' || l === 'Chans')).toBe(true);
		expect(sawVideos).toBeGreaterThan(0);
		expect(scanStatus().scanning).toBe(false);
		expect(scanStatus().progress).toBeNull();
	}, 60_000);

	// The library-add race: each admin Add fires a background rescan; when several land in quick
	// succession the later ones collide with the running scan. They must QUEUE one follow-up — not
	// silently vanish (which left the LAST-added library unindexed until the interval rescan).
	it('a runScan colliding with a running scan queues one follow-up that then completes', async () => {
		const seq0 = scanStatus().seq;
		const first = runScan(true);
		expect(scanStatus().scanning).toBe(true);
		expect(await runScan(true)).toBeNull(); // collides → queued, returns immediately
		expect(await first).not.toBeNull();
		// The queued follow-up runs by itself; a full re-parse changes the index, so seq moves twice.
		const deadline = Date.now() + 30_000;
		while (scanStatus().seq < seq0 + 2 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(scanStatus().seq).toBe(seq0 + 2);
		expect(scanStatus().scanning).toBe(false);
	}, 60_000);
});
