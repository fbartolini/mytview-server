/**
 * Sharer surface (increment 2): /api/fed/* auth + grant filtering + revocation, the no-transitive
 * export rule, pair invite redemption + rate limiting, signed playback-URL shapes (HLS 2h window,
 * `.m3u8` before the `?`), art grants, and the CORS headers cross-origin hls.js needs.
 * Handlers invoked directly (⇔ watched-endpoint.test.ts); design: docs/federation-design.md.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();
process.env.HLS_DIR = path.join(env.base, 'hls'); // tempEnv sets 'off'; urls tests need hlsEnabled()

const { scan } = await import('../src/lib/server/indexer');
const { db } = await import('../src/lib/server/db');
const { addLibrary, listLibraries } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const fed = await import('../src/lib/server/federation');
const { handle } = await import('../src/hooks.server');
const { signedHlsIndex } = await import('../src/lib/server/mediaToken');
const pair = await import('../src/routes/api/fed/pair/+server');
const catalog = await import('../src/routes/api/fed/catalog/+server');
const videos = await import('../src/routes/api/fed/videos/+server');
const urls = await import('../src/routes/api/fed/urls/+server');
const art = await import('../src/routes/api/fed/art/+server');

let uid = 0;
let linkId = 0;
let secret = '';

/** Minimal RequestEvent fake for the fed handlers (they use request/url/getClientAddress only). */
const fedEvent = (
	urlStr: string,
	opts: { method?: string; body?: unknown; bearer?: string; ip?: string } = {}
) => {
	const headers: Record<string, string> = {};
	if (opts.bearer != null) headers.authorization = `Bearer ${opts.bearer}`;
	return {
		url: new URL(urlStr),
		request: new Request(urlStr, {
			method: opts.method ?? 'GET',
			headers,
			body: opts.body != null ? JSON.stringify(opts.body) : undefined
		}),
		getClientAddress: () => opts.ip ?? '198.51.100.7'
	} as never;
};

beforeAll(async () => {
	uid = (await createUser('owner', 'pw123456')).id;
	addLibrary('Chans', '', 'channels', false);
	writeChannelVideo(env.mediaRoot, 'ChanA', 'a1', { duration: 60 });
	writeFileSync(path.join(env.mediaRoot, 'ChanA', 'a1.jpg'), 'jpegbytes');
	writeChannelVideo(env.mediaRoot, 'ChanB', 'b1');
	await scan();
	// A mirrored row a malicious/old grant might point at — must never be exported (no transitive).
	db().prepare(
		"INSERT INTO channels (id, name, kind, peer_id, video_count) VALUES ('fed:aaa:c', 'Mirrored', 'channel', 'aaa', 0)"
	).run();
	const { id, secret: s } = fed.createSharerLink('peer-consumer-1', 'Bob', null);
	linkId = id;
	secret = s;
	fed.setLinkGrants(linkId, ['ChanA', 'fed:aaa:c']); // the mirrored grant must be inert
});
afterAll(() => env.cleanup());

describe('pair', () => {
	it('redeems a single-use invite exactly once', async () => {
		const invite = fed.createFedInvite(uid, 'https://sharer.example');
		const good = await pair.POST(
			fedEvent('http://t/api/fed/pair', {
				method: 'POST',
				body: { invite, serverId: 'peer-consumer-2', name: 'Carol' },
				ip: '203.0.113.1'
			})
		);
		expect(good.status).toBe(200);
		const payload = (await good.json()) as { serverId: string; secret: string };
		expect(payload.serverId).toBe(fed.serverId());
		expect(payload.secret.length).toBeGreaterThan(30);
		const again = await pair.POST(
			fedEvent('http://t/api/fed/pair', {
				method: 'POST',
				body: { invite, serverId: 'peer-consumer-3', name: 'Mallory' },
				ip: '203.0.113.1'
			})
		);
		expect(again.status).toBe(403);
	});

	it('rejects malformed bodies', async () => {
		const bad = await pair.POST(
			fedEvent('http://t/api/fed/pair', {
				method: 'POST',
				body: { invite: 'x', serverId: 'no spaces allowed!', name: 'X' },
				ip: '203.0.113.2'
			})
		);
		expect(bad.status).toBe(400);
		const noJson = await pair.POST(
			fedEvent('http://t/api/fed/pair', { method: 'POST', ip: '203.0.113.2' })
		);
		expect(noJson.status).toBe(400);
	});

	it('rate limits per IP (5/15min)', async () => {
		let last = 0;
		for (let i = 0; i < 6; i++) {
			const res = await pair.POST(
				fedEvent('http://t/api/fed/pair', {
					method: 'POST',
					body: { invite: 'nope', serverId: 'peer-x', name: 'X' },
					ip: '203.0.113.99'
				})
			);
			last = res.status;
		}
		expect(last).toBe(429);
	});
});

describe('auth + grant filtering', () => {
	it('rejects a missing or wrong bearer', async () => {
		expect((await catalog.GET(fedEvent('http://t/api/fed/catalog'))).status).toBe(401);
		expect((await catalog.GET(fedEvent('http://t/api/fed/catalog', { bearer: 'wrong' }))).status).toBe(401);
	});

	it('catalog lists ONLY granted, local channels + their libraries', async () => {
		const res = await catalog.GET(fedEvent('http://t/api/fed/catalog', { bearer: secret }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			serverId: string;
			libraries: { name: string }[];
			channels: { id: string; video_count: number; hasThumb?: boolean }[];
		};
		expect(body.serverId).toBe(fed.serverId());
		expect(body.channels.map((c) => c.id)).toEqual(['ChanA']); // ChanB ungranted; fed:aaa:c mirrored
		expect(body.channels[0].video_count).toBe(1);
		expect(body.libraries.map((l) => l.name)).toEqual(['Chans']);
	});

	it('videos: granted 200 with ext-not-path; ungranted + mirrored 404', async () => {
		const ok = await videos.GET(fedEvent('http://t/api/fed/videos?channel=ChanA', { bearer: secret }));
		expect(ok.status).toBe(200);
		const item = ((await ok.json()) as { items: { id: string; ext: string; hasThumb: boolean }[] }).items[0];
		expect(item).toMatchObject({ id: 'a1', ext: '.mp4', hasThumb: true });
		expect(JSON.stringify(item)).not.toContain('ChanA/'); // no real paths leak
		expect((await videos.GET(fedEvent('http://t/api/fed/videos?channel=ChanB', { bearer: secret }))).status).toBe(404);
		expect(
			(await videos.GET(fedEvent('http://t/api/fed/videos?channel=fed:aaa:c', { bearer: secret }))).status
		).toBe(404);
	});

	it('urls: signed relative shapes with the .m3u8 before the ?, HLS in the 2h window', async () => {
		const res = await urls.POST(
			fedEvent('http://t/api/fed/urls', { method: 'POST', body: { videoId: 'a1' }, bearer: secret })
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { url: string; hlsUrl: string; ext: string };
		expect(body.url).toMatch(/^\/media\/a1\?k=[A-Za-z0-9_-]+&exp=\d+&t=l\d+$/); // tag = link attribution (fedmeter)
		expect(body.ext).toBe('.mp4');
		expect(body.hlsUrl).toMatch(/^\/hls\/v\/a1\/index\.m3u8\?k=[A-Za-z0-9_-]+&exp=\d+&t=l\d+$/);
		const exp = Number(new URL('http://x' + body.hlsUrl).searchParams.get('exp')) * 1000;
		expect(exp - Date.now()).toBeGreaterThanOrEqual(2 * 3600 * 1000 - 5000);
		expect(exp - Date.now()).toBeLessThanOrEqual(4 * 3600 * 1000 + 5000);
	});

	it('grant revocation flips urls 200 → 404 immediately', async () => {
		fed.setLinkGrants(linkId, []);
		const res = await urls.POST(
			fedEvent('http://t/api/fed/urls', { method: 'POST', body: { videoId: 'a1' }, bearer: secret })
		);
		expect(res.status).toBe(404);
		fed.setLinkGrants(linkId, ['ChanA']); // restore
	});

	it('art: grant-checked bytes for a video thumb; ungranted 404', async () => {
		const ok = await art.GET(fedEvent('http://t/api/fed/art?kind=thumb&video=a1', { bearer: secret }));
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe('jpegbytes');
		expect((await art.GET(fedEvent('http://t/api/fed/art?kind=thumb&video=b1', { bearer: secret }))).status).toBe(404);
		expect((await art.GET(fedEvent('http://t/api/fed/art?kind=fanart', { bearer: secret }))).status).toBe(400);
	});
});

describe('whole-library grants — current AND FUTURE content', () => {
	it('a library grant exports every channel in it, including ones indexed later', async () => {
		const { id, secret: s } = fed.createSharerLink('peer-lib', 'LibPeer', null);
		const lib = listLibraries().find((l) => l.name === 'Chans')!;
		fed.setLinkLibraryGrant(id, lib.id, true);
		const cat1 = (await (await catalog.GET(fedEvent('http://t/api/fed/catalog', { bearer: s }))).json()) as {
			channels: { id: string }[];
			libraries: { id: number }[];
		};
		expect(cat1.channels.map((c) => c.id).sort()).toEqual(['ChanA', 'ChanB']);
		expect(cat1.libraries.map((l) => l.id)).toContain(lib.id);
		// FUTURE content: a brand-new channel lands in the granted library → exported with zero
		// further grant edits (the point of whole-library sharing).
		writeChannelVideo(env.mediaRoot, 'ChanC', 'c1');
		await scan();
		const cat2 = (await (await catalog.GET(fedEvent('http://t/api/fed/catalog', { bearer: s }))).json()) as {
			channels: { id: string }[];
		};
		expect(cat2.channels.map((c) => c.id).sort()).toEqual(['ChanA', 'ChanB', 'ChanC']);
		// Revoking the library grant removes everything not individually granted.
		fed.setLinkLibraryGrant(id, lib.id, false);
		const cat3 = (await (await catalog.GET(fedEvent('http://t/api/fed/catalog', { bearer: s }))).json()) as {
			channels: { id: string }[];
		};
		expect(cat3.channels).toHaveLength(0);
	});
});

describe('CORS for cross-origin playback', () => {
	const hookEvent = (urlStr: string) =>
		({
			url: new URL(urlStr),
			request: new Request(urlStr),
			cookies: { get: () => undefined },
			locals: {},
			getClientAddress: () => '198.51.100.9'
		}) as never;

	it('a signed /hls playlist response carries access-control-allow-origin: *', async () => {
		const signed = 'http://t' + signedHlsIndex('a1');
		const res = await handle({
			event: hookEvent(signed),
			resolve: async () => new Response('#EXTM3U')
		} as never);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	it('an unauthenticated /media 401 still carries CORS (readable failure for hls.js)', async () => {
		const res = await handle({
			event: hookEvent('http://t/media/a1'),
			resolve: async () => new Response('never reached')
		} as never);
		expect(res.status).toBe(401);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});
});
