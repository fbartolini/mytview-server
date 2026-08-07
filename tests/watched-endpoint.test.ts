/**
 * POST /api/v1/channels/[id]/watched must demand an explicit boolean: the old default (missing
 * body → watched:false) bulk-reset every resume position in the channel, so a mangled request
 * from a buggy client silently wiped real state instead of erroring.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { tempEnv } from './helpers';

const env = tempEnv();
const { db } = await import('../src/lib/server/db');
const { stateDb } = await import('../src/lib/server/state');
const { saveWatch, getWatch } = await import('../src/lib/server/watch');
const { POST } = await import('../src/routes/api/v1/channels/[id]/watched/+server');

afterAll(() => env.cleanup());

// Seed: one channel with two videos in the index, one (owner) user in state.
db().exec("INSERT INTO channels (id, name) VALUES ('c1', 'C1')");
const ins = db().prepare(
	'INSERT INTO videos (id, channel_id, title, video_path, info_path, mtime) VALUES (?, ?, ?, ?, ?, ?)'
);
ins.run('v1', 'c1', 'V1', 'c1/v1.mp4', 'c1/v1.info.json', 1);
ins.run('v2', 'c1', 'V2', 'c1/v2.mp4', 'c1/v2.info.json', 1);
stateDb()
	.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
	.run('u', 'x', Date.now());

const call = (body?: BodyInit) =>
	POST({
		params: { id: 'c1' },
		locals: { user: { id: 1, username: 'u' } },
		request: new Request('http://test/api/v1/channels/c1/watched', { method: 'POST', body })
	} as never);

describe('bulk mark-watched requires an explicit boolean', () => {
	it('400s on a missing body and leaves watch state untouched', async () => {
		saveWatch(1, 'v1', { position: 42 });
		await expect(call()).rejects.toMatchObject({ status: 400 });
		expect(getWatch(1, 'v1').position).toBe(42);
	});

	it('400s on malformed JSON and on a non-boolean watched', async () => {
		await expect(call('not json')).rejects.toMatchObject({ status: 400 });
		await expect(call(JSON.stringify({ watched: 'true' }))).rejects.toMatchObject({ status: 400 });
		await expect(call(JSON.stringify({}))).rejects.toMatchObject({ status: 400 });
		expect(getWatch(1, 'v1').position).toBe(42); // still untouched
	});

	it('explicit watched:true bulk-marks the channel', async () => {
		const res = await call(JSON.stringify({ watched: true }));
		expect(await res.json()).toEqual({ affected: 2, watched: true });
		expect(getWatch(1, 'v1')).toEqual({ position: 0, watched: true });
		expect(getWatch(1, 'v2')).toEqual({ position: 0, watched: true });
	});

	it('explicit watched:false bulk-unwatches (positions reset by design)', async () => {
		const res = await call(JSON.stringify({ watched: false }));
		expect(await res.json()).toEqual({ affected: 2, watched: false });
		expect(getWatch(1, 'v1')).toEqual({ position: 0, watched: false });
	});
});
