/**
 * The server side of offline (contract §Offline): the descriptor reports the original's size, and
 * `/media/[id]?dl=1` adds a download disposition without changing the byte-serving behaviour.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();
process.env.HLS_DIR = path.join(env.mediaRoot, '..', 'hls-test'); // tempEnv turns HLS off; this suite needs the capacity field
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const detailRoute = await import('../src/routes/api/v1/videos/[id]/+server');
const mediaRoute = await import('../src/routes/media/[id]/+server');
const statusRoute = await import('../src/routes/api/v1/status/+server');

addLibrary('Videos', '', 'channels', false);
writeChannelVideo(env.mediaRoot, 'ChanA', 'a1');
writeFileSync(path.join(env.mediaRoot, 'ChanA', 'a1.mp4'), Buffer.alloc(12345, 1));
await scan();
const uid = (await createUser('owner', 'pw123456')).id;
const user = { id: uid, username: 'owner' };

describe('offline: server contribution', () => {
	it('status negotiates the HLS download queue width (cap minus one live slot, never below 1)', async () => {
		const res = await statusRoute.GET({ locals: { user } } as never);
		const body = await res.json();
		expect(body.hls).toEqual(expect.objectContaining({ maxSessions: expect.any(Number), active: 0, copying: 0 }));
		expect(body.hls.downloadSlots).toBe(Math.max(1, body.hls.maxSessions - 1));
		expect(body.hls.copySlots).toBe(Math.max(1, body.hls.maxCopies - 1));
		expect(body.hls.maxCopies).toBeGreaterThan(body.hls.maxSessions);
	});

	it('the descriptor says when a download can be a stream copy on Apple (H.264 + TS audio)', async () => {
		const res = await detailRoute.GET({ params: { id: 'a1' }, locals: { user } } as never);
		const body = await res.json();
		// The fixture is random bytes: nothing to copy → an encode. (Decided on the real probe.)
		expect(body.playback.hlsCopy).toBe(false);
	});

	it('the descriptor carries the original file size', async () => {
		const res = await detailRoute.GET({ params: { id: 'a1' }, locals: { user } } as never);
		const body = await res.json();
		expect(body.playback.sizeBytes).toBe(12345);
	});

	it('/media?dl=1 adds a download disposition and keeps Content-Length + ranges', async () => {
		const call = (u: string, init: RequestInit = {}) =>
			mediaRoute.GET({
				params: { id: 'a1' },
				url: new URL(u),
				request: new Request(u, init),
				cookies: { get: () => undefined },
				locals: { user },
				getClientAddress: () => '127.0.0.1'
			} as never);
		const plain = await call('http://s/media/a1');
		expect(plain.headers.get('content-disposition')).toBeNull();
		expect(plain.headers.get('content-length')).toBe('12345');

		const dl = await call('http://s/media/a1?dl=1');
		expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="a1\.mp4"/);
		expect(dl.headers.get('content-length')).toBe('12345');

		const head = await call('http://s/media/a1?dl=1', { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('content-length')).toBe('12345');
		expect(head.headers.get('content-disposition')).toMatch(/^attachment/);

		const part = await call('http://s/media/a1?dl=1', { headers: { range: 'bytes=100-199' } });
		expect(part.status).toBe(206);
		expect(part.headers.get('content-length')).toBe('100');
		expect(part.headers.get('content-range')).toBe('bytes 100-199/12345');
	});
});
