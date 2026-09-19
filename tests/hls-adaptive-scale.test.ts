/**
 * Adaptive downscale of the live HLS transcode: the output stays at SOURCE resolution unless the encoder
 * proves too slow on this host — then it restarts one rung down (1080p, then 720p) at its frontier, and
 * the verdict is remembered for that file. Field 2026-09-13: a 4K HEVC film encoded at ~0.3x real time,
 * so an audio-track switch on Tizen stalled forever. ffmpeg/ffprobe are stubbed: the fake encoder's
 * -progress feed is driven by hand against a mocked clock, so the test is deterministic and ffmpeg-free.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
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
let probe = { width: 3840, height: 1608 };

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
				return cb(null, { stdout: JSON.stringify({ streams: [{ color_transfer: 'bt709', ...probe }] }), stderr: '' });
			return cb(null, { stdout: JSON.stringify({ streams: [] }), stderr: '' }); // audio: one/none
		}
	};
});

const env = tempEnv();
process.env.HLS_DIR = path.join(env.base, 'hls');
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { startHlsSession, hlsSegment } = await import('../src/lib/server/hls');

let now = 1_000_000;
vi.spyOn(Date, 'now').mockImplementation(() => now);

/** Feed one -progress sample (media seconds encoded) into a fake encoder and let the handler run. */
async function progress(p: FakeProc, mediaSec: number) {
	p.stdout.write(`frame=1\nout_time_us=${Math.round(mediaSec * 1e6)}\nprogress=continue\n`);
	await new Promise((r) => setImmediate(r));
}
const vf = (p: FakeProc) => p.args[p.args.indexOf('-vf') + 1] ?? null;
const sid = (playlist: string) => /\/hls\/s\/([0-9a-f]+)\//.exec(playlist)![1];

beforeAll(async () => {
	writeChannelVideo(env.mediaRoot, 'Films/Big', 'big');
	writeChannelVideo(env.mediaRoot, 'Films/Small', 'small');
	addLibrary('Films', 'Films', 'channels', false);
	await scan();
});
afterAll(() => env.cleanup());

describe('HLS adaptive downscale', () => {
	it('keeps source resolution while the host keeps up', async () => {
		const s = (await startHlsSession('small'))!;
		void hlsSegment(sid(s.playlist), 0);
		const p = spawned.at(-1)!;
		expect(p.args).not.toContain('-vf'); // SDR, no scale → plain CPU encode at source size
		await progress(p, 1);
		now += 11_000;
		await progress(p, 1 + 22); // 2x real time
		expect(spawned.at(-1)).toBe(p); // no restart
		expect(p.killed).toEqual([]);
	});

	it('steps down to 1080p at the frontier when the encoder is slower than real time', async () => {
		const s = (await startHlsSession('big'))!;
		const id = sid(s.playlist);
		void hlsSegment(id, 0);
		const first = spawned.at(-1)!;
		await progress(first, 0.5); // baseline at the first frame (startup cost excluded)
		now += 11_000;
		// Two segments already produced → the restart must resume from the frontier, not from 0.
		const dir = path.dirname(first.args.at(-1)!);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'seg00000.ts'), 'x');
		writeFileSync(path.join(dir, 'seg00001.ts'), 'x');
		await progress(first, 0.5 + 3.3); // 0.3x real time
		expect(first.killed).toContain('SIGKILL');
		const second = spawned.at(-1)!;
		expect(second).not.toBe(first);
		expect(vf(second)).toBe('scale=1920:804'); // 3840x1608 fitted into 1920x1080, even dims
		expect(second.args[second.args.indexOf('-start_number') + 1]).toBe('2');

		// Still too slow at 1080p → one more rung.
		await progress(second, 0.5);
		now += 11_000;
		await progress(second, 0.5 + 5);
		expect(vf(spawned.at(-1)!)).toBe('scale=1280:536');
	});

	it('remembers the verdict: the next session of that file starts downscaled', async () => {
		const s = (await startHlsSession('big', null, null))!;
		void hlsSegment(sid(s.playlist), 0);
		expect(vf(spawned.at(-1)!)).toBe('scale=1280:536');
	});

	it('never "downscales" a source already inside the ladder', async () => {
		probe = { width: 1280, height: 720 };
		writeChannelVideo(env.mediaRoot, 'Films/Hd', 'hd');
		await scan();
		const s = (await startHlsSession('hd'))!;
		void hlsSegment(sid(s.playlist), 0);
		const p = spawned.at(-1)!;
		await progress(p, 0.5);
		now += 11_000;
		await progress(p, 0.5 + 2); // slow, but there's no smaller rung for a 720p source
		expect(spawned.at(-1)).toBe(p);
		expect(p.killed).toEqual([]);
	});
});
