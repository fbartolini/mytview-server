/**
 * Federation metering + per-peer stream cap (fedmeter.ts): the MAC-covered link tag on signed
 * URLs (unforgeable/unstrippable), the concurrent-stream window semantics, the /media route's
 * cap enforcement + attribution, and the durable daily consumption rollups.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();

const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const fed = await import('../src/lib/server/federation');
const meter = await import('../src/lib/server/fedmeter');
const { signedPath, verifyMedia } = await import('../src/lib/server/mediaToken');
const media = await import('../src/routes/media/[id]/+server');

let linkId = 0;

beforeAll(async () => {
	addLibrary('Chans', '', 'channels', false);
	writeChannelVideo(env.mediaRoot, 'ChanA', 'a1');
	await scan();
	linkId = fed.createSharerLink('peer-meter', 'Meter Peer', null).id;
	fed.setLinkMaxStreams(linkId, 2); // per-link owner setting (fed_links.max_streams) — not an env var
});
afterAll(() => env.cleanup());

describe('MAC-covered link tag', () => {
	it('verifies with the tag, fails when stripped or forged', () => {
		const tagged = signedPath('media', 'a1', { tag: meter.linkTag(7) });
		expect(tagged).toContain('&t=l7');
		expect(verifyMedia('media', 'a1', new URL('http://t' + tagged))).toBe(true);
		// Stripping the tag breaks the MAC…
		const stripped = new URL('http://t' + tagged);
		stripped.searchParams.delete('t');
		expect(verifyMedia('media', 'a1', stripped)).toBe(false);
		// …and forging one onto an untagged URL breaks it too.
		const untagged = new URL('http://t' + signedPath('media', 'a1'));
		untagged.searchParams.set('t', 'l7');
		expect(verifyMedia('media', 'a1', untagged)).toBe(false);
		expect(meter.linkIdFromTag(new URL('http://t' + tagged))).toBe(7);
		expect(meter.linkIdFromTag(untagged)).toBe(7); // parse only — callers gate on verifyMedia first
	});
});

describe('stream cap semantics', () => {
	it('caps NEW streams, never active ones; 0 = unlimited', () => {
		const L = 999; // in-memory only — distinct from the real link so tests don't cross-pollute
		expect(meter.streamAllowed(L, 'v1|ip1', 0)).toBe(true); // unlimited
		meter.noteStream(L, 'v1|ip1');
		meter.noteStream(L, 'v2|ip2');
		expect(meter.activeStreamCount(L)).toBe(2);
		expect(meter.streamAllowed(L, 'v3|ip3', 2)).toBe(false); // cap reached → new denied
		expect(meter.streamAllowed(L, 'v1|ip1', 2)).toBe(true); // active key keeps playing
		expect(meter.streamAllowed(L, 'v1|ip1', 1)).toBe(true); // even under a lowered cap
	});
});

describe('/media enforcement + attribution (per-link cap = 2)', () => {
	const call = (ip: string) => {
		const urlStr = 'http://t' + signedPath('media', 'a1', { tag: meter.linkTag(linkId) });
		return media.GET({
			params: { id: 'a1' },
			request: new Request(urlStr),
			url: new URL(urlStr),
			cookies: { get: () => undefined },
			locals: {},
			getClientAddress: () => ip
		} as never);
	};

	it('admits up to the cap, 429s the next viewer, keeps existing viewers playing', async () => {
		expect((await call('10.0.0.1')).status).toBe(200);
		expect((await call('10.0.0.2')).status).toBe(200);
		const third = await call('10.0.0.3');
		expect(third.status).toBe(429);
		expect(third.headers.get('access-control-allow-origin')).toBe('*'); // readable by hls.js
		expect((await call('10.0.0.1')).status).toBe(200); // active stream unaffected
	});

	it('rolls consumption up durably (mints + requests + bytes)', () => {
		meter.noteServe(linkId, 'mint');
		meter.noteServe(linkId, 'hls', 500_000);
		const s = meter.serveStats(linkId); // flushes pending
		expect(s.todayMints).toBe(1);
		expect(s.d30Requests).toBeGreaterThanOrEqual(4); // the three admitted /media calls + 1 hls
		expect(s.todayBytes).toBeGreaterThanOrEqual(500_000); // ≥ the hls bytes (fixture media files are 0-byte)
		expect(s.d30Bytes).toBe(s.todayBytes);
	});
});
