/**
 * HDR10 on the GPU: with VAAPI on, a PQ source is decoded, tonemapped (tonemap_vaapi) and encoded on the
 * GPU, instead of the all-CPU zscale chain that ran 4K HDR10 at 0.014x and got OOM-killed on the field
 * box (2026-09-13; the GPU chain measured 4.37x there). A GPU tonemap failure falls back to the CPU chain
 * for HDR only — SDR keeps VAAPI. HLG stays on the CPU chain. ffmpeg/ffprobe stubbed (⇔ hls-adaptive-scale).
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

interface FakeProc extends EventEmitter {
	args: string[];
	stdout: PassThrough;
	stderr: PassThrough;
	killed: string[];
	kill: (sig: string) => boolean;
}
const spawned: FakeProc[] = [];
let probe = { width: 3840, height: 1608, color_transfer: 'smpte2084' };

vi.mock('node:child_process', async (orig) => {
	const real = await orig<typeof import('node:child_process')>();
	return {
		...real,
		spawn: (_cmd: string, args: string[]) => {
			const p = new EventEmitter() as FakeProc;
			p.args = args;
			p.stdout = new PassThrough();
			p.stderr = new PassThrough();
			p.killed = [];
			p.kill = (sig: string) => (p.killed.push(sig), true);
			spawned.push(p);
			return p;
		},
		execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
			if (cmd !== 'ffprobe') return cb(new Error('not stubbed'));
			const a = args.join(' ');
			if (a.includes('format=duration')) return cb(null, { stdout: '600\n', stderr: '' });
			if (a.includes('color_transfer'))
				return cb(null, { stdout: JSON.stringify({ streams: [probe] }), stderr: '' });
			return cb(null, { stdout: JSON.stringify({ streams: [] }), stderr: '' }); // audio: one/none
		}
	};
});

const env = tempEnv();
process.env.HLS_DIR = path.join(env.base, 'hls');
process.env.TRANSCODE_HWACCEL = '1';
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { startHlsSession, hlsSegment } = await import('../src/lib/server/hls');

const vf = (p: FakeProc) => p.args[p.args.indexOf('-vf') + 1] ?? null;
const sid = (playlist: string) => /\/hls\/s\/([0-9a-f]+)\//.exec(playlist)![1];
const fail = async (p: FakeProc, stderr: string) => {
	p.stderr.write(stderr);
	await new Promise((r) => setImmediate(r));
	p.emit('close', 1);
};

beforeAll(async () => {
	writeChannelVideo(env.mediaRoot, 'Films/Hdr', 'hdr');
	writeChannelVideo(env.mediaRoot, 'Films/Hlg', 'hlg');
	writeChannelVideo(env.mediaRoot, 'Films/Sdr', 'sdr');
	addLibrary('Films', 'Films', 'channels', false);
	await scan();
});
afterAll(() => env.cleanup());

describe('HLS HDR on the GPU', () => {
	it('tonemaps an HDR10 source on the GPU', async () => {
		const s = (await startHlsSession('hdr'))!;
		void hlsSegment(sid(s.playlist), 0);
		const p = spawned.at(-1)!;
		expect(p.args).toContain('-hwaccel');
		expect(vf(p)).toBe('tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,scale_vaapi=format=nv12');
		expect(p.args).toContain('h264_vaapi');

		// The GPU tonemap fails on this host → the next job is the CPU chain, for HDR only.
		await fail(p, '[Parsed_tonemap_vaapi_0] Failed to create processing pipeline');
		void hlsSegment(sid(s.playlist), 1);
		const cpu = spawned.at(-1)!;
		expect(cpu).not.toBe(p);
		expect(cpu.args).not.toContain('-hwaccel');
		expect(vf(cpu)).toMatch(/^zscale=.*tonemap=tonemap=hable/); // the CPU tonemap is NOT latched off
		expect(cpu.args).toContain('libx264');
	});

	it('keeps VAAPI for SDR after a GPU tonemap failure', async () => {
		probe = { width: 1920, height: 1080, color_transfer: 'bt709' };
		const s = (await startHlsSession('sdr'))!;
		void hlsSegment(sid(s.playlist), 0);
		const p = spawned.at(-1)!;
		expect(p.args).toContain('h264_vaapi');
		expect(vf(p)).toBe('scale_vaapi=format=nv12');
	});

	it('leaves HLG on the CPU chain (tonemap_vaapi maps PQ)', async () => {
		probe = { width: 3840, height: 2160, color_transfer: 'arib-std-b67' };
		const s = (await startHlsSession('hlg'))!;
		void hlsSegment(sid(s.playlist), 0);
		const p = spawned.at(-1)!;
		expect(p.args).not.toContain('-hwaccel');
		expect(vf(p)).toMatch(/tonemap=tonemap=hable/);
	});
});
