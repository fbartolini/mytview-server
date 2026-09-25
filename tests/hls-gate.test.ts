/**
 * The auth hook's signed-URL exemption for HLS: the playlist, TS segments, fMP4 segments AND the
 * fMP4 init section all pass on the `?k=&exp=` signature alone (AVFoundation sends no cookie or
 * header). Field 2026-09-24: the gate matched only `seg….ts`, so every init.mp4/.m4s answered 401
 * and every Apple download failed at the playlist the moment fMP4 shipped.
 */
import { describe, it, expect } from 'vitest';
import { tempEnv } from './helpers';

tempEnv();
const { handle } = await import('../src/hooks.server');
const { hlsQuery, signedHlsIndex } = await import('../src/lib/server/mediaToken');

const hookEvent = (urlStr: string) =>
	({
		url: new URL(urlStr),
		request: new Request(urlStr),
		cookies: { get: () => undefined },
		locals: {},
		getClientAddress: () => '198.51.100.9'
	}) as never;
const passes = async (u: string) =>
	(await handle({ event: hookEvent(u), resolve: async () => new Response('ok') } as never)).status;

describe('auth hook: signed HLS paths pass without a session', () => {
	const sid = 'ab12cd34ef56ab12cd34ef56ab12cd34';
	const sig = hlsQuery(sid);
	it('playlist', async () => expect(await passes('http://t' + signedHlsIndex('a1'))).toBe(200));
	it('TS segment', async () => expect(await passes(`http://t/hls/s/${sid}/seg00003.ts?${sig}`)).toBe(200));
	it('fMP4 segment', async () => expect(await passes(`http://t/hls/s/${sid}/seg00003.m4s?${sig}`)).toBe(200));
	it('fMP4 init section', async () => expect(await passes(`http://t/hls/s/${sid}/init.mp4?${sig}`)).toBe(200));
	it('an unsigned segment is still gated', async () =>
		expect(await passes(`http://t/hls/s/${sid}/seg00003.m4s`)).toBe(401));
	it('a segment signed for ANOTHER session is gated', async () =>
		expect(await passes(`http://t/hls/s/other/init.mp4?${sig}`)).toBe(401));
});
