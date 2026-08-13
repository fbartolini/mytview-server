/**
 * Federated playback (increment 4): the /api/v1 descriptor ships ABSOLUTE peer URLs for mirrored
 * videos (`.m3u8` kept before the `?` — ExoPlayer's MIME sniff), keeps the poster home-origin,
 * single-flights the peer round-trip, and degrades explicitly: peer 404 → local 404 (+ self-heal
 * sync), peer unreachable → 503. The web load mirrors it with srcUrl/hlsUrl/remote/peerUnavailable.
 * Same two-server recipe as fed-sync.test.ts.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

const env1 = tempEnv();

const captured = await (async () => {
	const { scan } = await import('../src/lib/server/indexer');
	const { addLibrary } = await import('../src/lib/server/libraries');
	const fed = await import('../src/lib/server/federation');
	const catalogRoute = await import('../src/routes/api/fed/catalog/+server');
	const videosRoute = await import('../src/routes/api/fed/videos/+server');

	addLibrary('Videos', '', 'channels', false);
	for (const id of ['a1', 'a2', 'a3']) writeChannelVideo(env1.mediaRoot, 'ChanA', id);
	writeFileSync(path.join(env1.mediaRoot, 'ChanA', 'a1.jpg'), 'jpegbytes'); // a1 has a thumb → poster
	await scan();
	const { id: linkId, secret } = fed.createSharerLink('consumer-x', 'Bob', null);
	fed.setLinkGrants(linkId, ['ChanA']);
	const call = async (mod: { GET: (e: never) => Response | Promise<Response> }, urlStr: string) => {
		const res = await mod.GET({
			url: new URL(urlStr),
			request: new Request(urlStr, { headers: { authorization: `Bearer ${secret}` } }),
			getClientAddress: () => '198.51.100.2'
		} as never);
		return res.json();
	};
	const catalog = await call(catalogRoute, 'http://s/api/fed/catalog');
	const videos = await call(videosRoute, 'http://s/api/fed/videos?channel=ChanA');
	return { serverId: fed.serverId(), catalog, videos };
})();

const env2 = tempEnv();
vi.resetModules();

const { db } = await import('../src/lib/server/db');
const fed = await import('../src/lib/server/federation');
const { setFedFetch } = await import('../src/lib/server/fedclient');
const { runFedSync } = await import('../src/lib/server/fedsync');
const { addVirtualLibrary } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const detailRoute = await import('../src/routes/api/v1/videos/[id]/+server');
const { load: videoPageLoad } = await import('../src/routes/video/[id]/+page.server');

afterAll(() => {
	env1.cleanup();
	env2.cleanup();
});

const PREFIX = captured.serverId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
const holder = { networkDown: false, urlsCalls: 0, deny: new Set<string>() };
setFedFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
	if (holder.networkDown) throw new TypeError('fetch failed');
	const u = String(input);
	const json = (x: unknown, status = 200) =>
		new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
	if (u.includes('/api/fed/catalog')) return json(captured.catalog);
	if (u.includes('/api/fed/videos')) return json(captured.videos);
	if (u.includes('/api/fed/urls')) {
		holder.urlsCalls++;
		const vid = (JSON.parse(String(init?.body ?? '{}')) as { videoId: string }).videoId;
		if (holder.deny.has(vid)) return json({ error: 'not_shared' }, 404);
		return json({
			url: `/media/${vid}?k=PEERSIG&exp=9999999999`,
			hlsUrl: `/hls/v/${vid}/index.m3u8?k=PEERSIG&exp=9999999999`,
			ext: '.mp4'
		});
	}
	return json({ error: 'nope' }, 404);
});

const uid = (await createUser('owner', 'pw123456')).id;
const linkId = fed.createConsumerLink(captured.serverId, 'Alice', 'https://sharer.example', 's3cret');
const remoteLib = (captured.catalog as { libraries: { id: number; name: string; format: string }[] })
	.libraries[0];
fed.setLibraryMap(linkId, remoteLib.id, addVirtualLibrary(remoteLib.name, 'channels'), remoteLib.name, 'channels');
await runFedSync(linkId);

const detail = (videoId: string) =>
	detailRoute.GET({
		params: { id: videoId },
		locals: { user: { id: uid, username: 'owner' } }
	} as never);

describe('descriptor for federated videos', () => {
	it('ships ABSOLUTE peer url/hlsUrl (.m3u8 before the ?) and a HOME-origin poster', async () => {
		const res = await detail(`fed:${PREFIX}:a1`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			peer_id: string;
			playback: { url: string; hlsUrl: string; poster: string; compatUrl: null; canTranscode: false };
		};
		expect(body.peer_id).toBe(PREFIX);
		expect(body.playback.url).toBe('https://sharer.example/media/a1?k=PEERSIG&exp=9999999999');
		expect(body.playback.hlsUrl).toMatch(/^https:\/\/sharer\.example\/hls\/v\/a1\/index\.m3u8\?/);
		expect(body.playback.poster?.startsWith('/thumb/')).toBe(true); // art stays same-origin (design §8)
		expect(body.playback.compatUrl).toBeNull();
		expect(body.playback.canTranscode).toBe(false);
	});

	it('single-flights + caches the peer round-trip', async () => {
		const before = holder.urlsCalls;
		await detail(`fed:${PREFIX}:a1`);
		await detail(`fed:${PREFIX}:a1`);
		expect(holder.urlsCalls).toBe(before); // served from the 5-min cache — no new calls
	});

	it('peer not_shared → 404 (stale mirror self-heals in the background)', async () => {
		holder.deny.add('a2');
		await expect(detail(`fed:${PREFIX}:a2`)).rejects.toMatchObject({ status: 404 });
		holder.deny.delete('a2');
		await new Promise((r) => setTimeout(r, 10)); // let the fired self-heal sync settle
	});

	it('peer unreachable → explicit 503', async () => {
		holder.networkDown = true;
		await expect(detail(`fed:${PREFIX}:a3`)).rejects.toMatchObject({ status: 503 });
		holder.networkDown = false;
	});

	it('local videos are untouched: relative signed url, no peer calls', async () => {
		writeChannelVideo(env2.mediaRoot, 'Local', 'loc1');
		const { addLibrary } = await import('../src/lib/server/libraries');
		const { scan } = await import('../src/lib/server/indexer');
		addLibrary('Loc', '', 'channels', false);
		await scan();
		const before = holder.urlsCalls;
		const body = (await (await detail('loc1')).json()) as { playback: { url: string } };
		expect(body.playback.url).toMatch(/^\/media\/loc1\?k=/);
		expect(holder.urlsCalls).toBe(before);
	});
});

describe('web /video load for federated videos', () => {
	it('supplies absolute srcUrl/hlsUrl + remote to the player', async () => {
		const data = (await videoPageLoad({
			params: { id: `fed:${PREFIX}:a1` },
			locals: { user: { id: uid, username: 'owner' } }
		} as never)) as { srcUrl: string; hlsUrl: string; remote: boolean; peerUnavailable: boolean; hlsEnabled: boolean };
		expect(data.remote).toBe(true);
		expect(data.peerUnavailable).toBe(false);
		expect(data.srcUrl).toBe('https://sharer.example/media/a1?k=PEERSIG&exp=9999999999');
		expect(data.hlsEnabled).toBe(true); // the PEER's HLS availability, not ours (HLS_DIR=off here)
	});

	it('peer down → peerUnavailable page state, never a throw', async () => {
		holder.networkDown = true;
		const data = (await videoPageLoad({
			params: { id: `fed:${PREFIX}:a3` },
			locals: { user: { id: uid, username: 'owner' } }
		} as never)) as { srcUrl: string | null; remote: boolean; peerUnavailable: boolean };
		holder.networkDown = false;
		expect(data).toMatchObject({ remote: true, peerUnavailable: true, srcUrl: null });
	});

	it('the consumer never serves fed media/HLS itself', async () => {
		const media = await import('../src/routes/media/[id]/+server');
		await expect(
			media.GET({
				params: { id: `fed:${PREFIX}:a1` },
				request: new Request('http://c/media/x'),
				url: new URL('http://c/media/x'),
				cookies: { get: () => undefined },
				locals: { user: { id: uid, username: 'owner' } }
			} as never)
		).rejects.toMatchObject({ status: 404 });
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(3);
	});
});
