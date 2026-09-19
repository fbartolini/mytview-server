/**
 * STREAM-COPY HLS sessions (contract §HLS `mode=copy`): video+audio copied into TS segments cut at the
 * SOURCE's keyframes — no encode. The engine's seek model (VOD playlist up front, segment N restartable
 * at its start) survives because copy sessions carry their real segment starts: the playlist states real
 * durations, and a restart is a coarse input seek + an exact output-side trim half a second before the
 * boundary keyframe + `-output_ts_offset` (the construction verified offline against ffmpeg's actual
 * cuts, 10s-GOP HEVC and 1s-GOP H.264). ffmpeg/ffprobe are stubbed as in hls-adaptive-scale.test.ts.
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
	kill: (sig: string) => boolean;
}
const spawned: FakeProc[] = [];
let vcodec = 'hevc';
let acodec = 'eac3';
// 10.417s GOPs from 0.083 (the field file's cadence), 1200s long → 116 boundaries.
const KEYS: number[] = [];
for (let t = 0.083; t < 1200; t += 10.417) KEYS.push(Number(t.toFixed(3)));

vi.mock('node:child_process', async (orig) => {
	const real = await orig<typeof import('node:child_process')>();
	return {
		...real,
		spawn: (_cmd: string, args: string[]) => {
			const p = new EventEmitter() as FakeProc;
			p.args = args;
			p.stdout = new PassThrough();
			p.stderr = new PassThrough();
			p.kill = () => true;
			spawned.push(p);
			return p;
		},
		execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
			if (cmd !== 'ffprobe') return cb(new Error('not stubbed'));
			const a = args.join(' ');
			if (a.includes('format=duration')) return cb(null, { stdout: '1200\n', stderr: '' });
			if (a.includes('color_transfer'))
				return cb(null, { stdout: JSON.stringify({ streams: [{ codec_name: vcodec, color_transfer: 'bt709', width: 1280, height: 720 }] }), stderr: '' });
			if (a.includes('packet=pts_time,flags'))
				return cb(null, { stdout: KEYS.map((k) => `${k.toFixed(6)},K__\n${(k + 0.042).toFixed(6)},___`).join('\n') + '\n', stderr: '' });
			if (a.includes('stream=index,codec_name'))
				return cb(null, { stdout: JSON.stringify({ streams: [{ index: 1, codec_name: acodec }] }), stderr: '' });
			return cb(null, { stdout: JSON.stringify({ streams: [] }), stderr: '' }); // default-audio probe: one track
		}
	};
});

const env = tempEnv();
process.env.HLS_DIR = path.join(env.base, 'hls');
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { startHlsSession, hlsSegment, copyBoundaries } = await import('../src/lib/server/hls');

const sid = (playlist: string) => /\/hls\/s\/([0-9a-f]+)\//.exec(playlist)![1];
const extinf = (playlist: string) => [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
const arg = (p: FakeProc, flag: string, nth = 0) => {
	let i = -1;
	for (let k = 0; k <= nth; k++) i = p.args.indexOf(flag, i + 1);
	return i >= 0 ? p.args[i + 1] : undefined;
};

beforeAll(async () => {
	writeChannelVideo(env.mediaRoot, 'Shows/Kingdom', 'ep1');
	writeChannelVideo(env.mediaRoot, 'Shows/Kingdom', 'ep2');
	writeChannelVideo(env.mediaRoot, 'Shows/Kingdom', 'ep3');
	addLibrary('Shows', 'Shows', 'channels', false);
	await scan();
});
afterAll(() => env.cleanup());

describe('copyBoundaries', () => {
	it('reproduces ffmpeg’s cut rule: next keyframe at least SEG after the previous start', () => {
		expect(copyBoundaries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 4, 8]);
		expect(copyBoundaries([0.083, 10.5, 20.917, 31.333], 4)).toEqual([0.083, 10.5, 20.917, 31.333]);
		expect(copyBoundaries([], 4)).toEqual([]);
	});
});

describe('stream-copy HLS session', () => {
	it('states the REAL segment durations and plays from the start with no seek and no encoder', async () => {
		const s = (await startHlsSession('ep1', null, null, true))!;
		const d = extinf(s.playlist);
		expect(d.length).toBe(KEYS.length);
		expect(d[0]).toBeCloseTo(10.417, 3);
		expect(d[1]).toBeCloseTo(10.417, 3);
		expect(s.playlist).toContain('#EXT-X-TARGETDURATION:11');
		// The last segment ends where the DATA ends (the scan's last packet), not at the declared duration.
		const last = KEYS[KEYS.length - 1];
		expect(d[d.length - 1]).toBeCloseTo(last + 0.042 + 0.1 - last, 2);
		void hlsSegment(sid(s.playlist), 0);
		const p = spawned.at(-1)!;
		expect(p.args).toContain('copy');
		expect(p.args).toContain('-sn');
		expect(p.args).not.toContain('libx264');
		expect(p.args).not.toContain('-force_key_frames');
		expect(p.args).not.toContain('-ss'); // boundary 0 is inside the trim lead of the file start
		expect(arg(p, '-start_number')).toBe('0');
	});

	it('restarts at a far boundary with the coarse-seek + exact-trim construction', async () => {
		const s = (await startHlsSession('ep2', null, null, true))!;
		void hlsSegment(sid(s.playlist), 0);
		const first = spawned.at(-1)!;
		void hlsSegment(sid(s.playlist), 40); // far beyond CATCHUP → restart at boundary 40
		const p = spawned.at(-1)!;
		expect(p).not.toBe(first);
		const t = KEYS[40]; // this segment's keyframe
		const trimAt = t - 0.5;
		const inSeek = t - 20;
		expect(Number(arg(p, '-ss', 0))).toBeCloseTo(inSeek, 3); // coarse INPUT seek (before -i)
		expect(Number(arg(p, '-ss', 1))).toBeCloseTo(trimAt - inSeek, 3); // exact OUTPUT trim (after -i)
		expect(Number(arg(p, '-output_ts_offset'))).toBeCloseTo(trimAt, 3);
		expect(arg(p, '-start_number')).toBe('40');
		expect(p.args.indexOf('-i')).toBeGreaterThan(p.args.indexOf('-ss')); // input seek precedes -i
	});

	it('refuses a segment past the last real boundary', async () => {
		const s = (await startHlsSession('ep2', null, null, true))!;
		expect(await hlsSegment(sid(s.playlist), KEYS.length + 5)).toBeNull();
	});

	it('never reuses a copy session for an encode request (they address different segments)', async () => {
		const a = (await startHlsSession('ep1', null, null, true))!;
		const b = (await startHlsSession('ep1', null, null, false))!;
		expect(sid(a.playlist)).not.toBe(sid(b.playlist));
		expect(extinf(b.playlist)[0]).toBe(4); // the encode grid
	});

	it('silently encodes when the codecs cannot ride in TS', async () => {
		vcodec = 'vp9'; // probes are cached per file, so this must be a file not probed yet
		const s = (await startHlsSession('ep3', null, null, true))!;
		expect(extinf(s.playlist)[0]).toBe(4);
		void hlsSegment(sid(s.playlist), 0);
		expect(spawned.at(-1)!.args).toContain('libx264');
		vcodec = 'hevc';
	});
});
