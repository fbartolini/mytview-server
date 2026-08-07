/**
 * The empty-library safety valve: a scan that previously indexed videos but suddenly sees NONE
 * (the unmounted-NAS shape — MEDIA_ROOT exists but is empty) must NOT prune the index; the
 * owner-forced full scan must still be able to.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { db } = await import('../src/lib/server/db');

afterAll(() => env.cleanup());

const videoCount = () =>
	(db().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c;

describe('scan prune safety valve', () => {
	it('indexes a channel video normally', async () => {
		writeChannelVideo(env.mediaRoot, 'ChanA', 'vid1');
		const stats = await scan();
		expect(stats.videos).toBe(1);
		expect(stats.pruneSkipped).toBeUndefined();
		expect(videoCount()).toBe(1);
	});

	it('skips the prune when a previously-populated library scans empty (suspected dead mount)', async () => {
		rmSync(path.join(env.mediaRoot, 'ChanA'), { recursive: true, force: true });
		const stats = await scan();
		expect(stats.pruneSkipped).toBe(true);
		expect(stats.pruned).toBe(0);
		expect(videoCount()).toBe(1); // the index survives until the mount returns
	});

	it('full=1 (the owner-gated force) prunes through the valve', async () => {
		const stats = await scan(true);
		expect(stats.pruneSkipped).toBeUndefined();
		expect(stats.pruned).toBe(1);
		expect(videoCount()).toBe(0);
	});
});
