/**
 * Channel tile art fallback (contract §channels): a channel with no poster file gets its newest
 * video's thumbnail as `poster`, decided server-side so the web and every app show the same tile
 * instead of an initial (owner 2026-09-25: a third of the channels grid was letters).
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const listRoute = await import('../src/routes/api/v1/channels/+server');
const oneRoute = await import('../src/routes/api/v1/channels/[id]/+server');

addLibrary('Videos', '', 'channels', false);
writeChannelVideo(env.mediaRoot, 'NoPoster', 'old1', { upload_date: '20240101', timestamp: 1704067200 });
writeChannelVideo(env.mediaRoot, 'NoPoster', 'new1', { upload_date: '20250101', timestamp: 1735689600 });
writeFileSync(path.join(env.mediaRoot, 'NoPoster', 'old1.jpg'), 'x');
writeFileSync(path.join(env.mediaRoot, 'NoPoster', 'new1.jpg'), 'x');
writeChannelVideo(env.mediaRoot, 'HasPoster', 'p1');
writeFileSync(path.join(env.mediaRoot, 'HasPoster', 'poster.jpg'), 'x');
writeChannelVideo(env.mediaRoot, 'NoArtAtAll', 'n1');
await scan();
const uid = (await createUser('owner', 'pw123456')).id;
const user = { id: uid, username: 'owner' };

describe('channel tile art fallback', () => {
	it('the grid signs the newest video thumb for a channel without a poster file', async () => {
		const res = await listRoute.GET({ url: new URL('http://t/api/v1/channels'), locals: { user } } as never);
		const items = (await res.json()).items as { id: string; poster: string | null }[];
		const byId = Object.fromEntries(items.map((c) => [c.id, c.poster]));
		expect(byId.NoPoster).toMatch(/^\/thumb\/new1\?/);
		expect(byId.HasPoster).toMatch(/^\/poster\/HasPoster\?/);
		expect(byId.NoArtAtAll).toBeNull();
	});

	it('the channel page agrees with the grid', async () => {
		const res = await oneRoute.GET({ params: { id: 'NoPoster' }, url: new URL('http://t/x'), locals: { user } } as never);
		expect((await res.json()).channel.poster).toMatch(/^\/thumb\/new1\?/);
	});
});
