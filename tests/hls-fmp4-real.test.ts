/**
 * fMP4 stream copy END TO END with the REAL ffmpeg/ffprobe (contract §HLS `fmt=fmp4`): a generated
 * H.264+AAC MKV is indexed, the descriptor says it is copyable, the playlist route yields a CMAF
 * playlist with an init map, and the segment route serves init.mp4 and the first .m4s. Skipped where
 * ffmpeg is not on PATH (CI without it). Field 2026-09-24: every Apple download failed at the playlist
 * (-12884) the moment fMP4 shipped, with nothing in the server log — this is the test that was missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

let haveFfmpeg = true;
try {
	execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
	haveFfmpeg = false;
}

const env = tempEnv();
process.env.HLS_DIR = path.join(env.base, 'hls');
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const detailRoute = await import('../src/routes/api/v1/videos/[id]/+server');
const indexRoute = await import('../src/routes/hls/v/[id]/index.m3u8/+server');
const segRoute = await import('../src/routes/hls/s/[sid]/[seg]/+server');

let user: { id: number; username: string };

beforeAll(async () => {
	if (!haveFfmpeg) return;
	const sample = path.join(env.base, 'h264.mkv');
	mkdirSync(env.base, { recursive: true });
	execFileSync('ffmpeg', [
		'-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
		'-t', '20', '-c:v', 'libx264', '-g', '96', '-keyint_min', '96', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
		'-c:a', 'aac', '-b:a', '64k', sample
	], { stdio: 'ignore' });
	addLibrary('Videos', '', 'channels', false);
	writeChannelVideo(env.mediaRoot, 'ChanA', 'a1');
	copyFileSync(sample, path.join(env.mediaRoot, 'ChanA', 'a1.mp4')); // the bytes are an MKV; the probe reads content
	await scan();
	const u = await createUser('owner', 'pw123456');
	user = { id: u.id, username: 'owner' };
});
afterAll(() => env.cleanup());

const call = (route: { GET: (e: never) => Promise<Response> | Response }, params: Record<string, string>, u: string) =>
	route.GET({
		params,
		url: new URL(u),
		request: new Request(u),
		cookies: { get: () => undefined },
		locals: { user },
		getClientAddress: () => '127.0.0.1'
	} as never);

describe.skipIf(!haveFfmpeg)('fMP4 stream copy, real ffmpeg', () => {
	it('descriptor → CMAF playlist → init.mp4 → first .m4s', async () => {
		const d = await (await detailRoute.GET({ params: { id: 'a1' }, locals: { user } } as never)).json();
		expect(d.playback.hlsCopy).toBe(true);
		const hls = new URL('http://h' + d.playback.hlsUrl);
		hls.searchParams.set('dl', '1');
		hls.searchParams.set('mode', 'copy');
		hls.searchParams.set('copyv', 'h264,hevc');
		hls.searchParams.set('fmt', 'fmp4');
		const pl = await call(indexRoute, { id: 'a1' }, hls.toString());
		expect(pl.status).toBe(200);
		const text = await pl.text();
		expect(text).toContain('#EXT-X-VERSION:7');
		const map = /#EXT-X-MAP:URI="\/hls\/s\/([0-9a-f]+)\/init\.mp4\?([^"]+)"/.exec(text);
		expect(map).not.toBeNull();
		const [, sid, sig] = map!;
		expect(text).toContain(`/hls/s/${sid}/seg00000.m4s?${sig}`);
		const init = await call(segRoute, { sid, seg: 'init.mp4' }, `http://h/hls/s/${sid}/init.mp4?${sig}`);
		expect(init.status).toBe(200);
		expect(init.headers.get('content-type')).toBe('video/mp4');
		const initBytes = new Uint8Array(await init.arrayBuffer());
		expect(initBytes.length).toBeGreaterThan(100);
		expect(String.fromCharCode(...initBytes.slice(4, 8))).toBe('ftyp');
		const seg = await call(segRoute, { sid, seg: 'seg00000.m4s' }, `http://h/hls/s/${sid}/seg00000.m4s?${sig}`);
		expect(seg.status).toBe(200);
		expect(seg.headers.get('content-type')).toBe('video/iso.segment');
		const segBytes = new Uint8Array(await seg.arrayBuffer());
		expect(segBytes.length).toBeGreaterThan(100);
	}, 60_000);
});
