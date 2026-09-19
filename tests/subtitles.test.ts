/**
 * Subtitle sidecars: naming rules, WebVTT conversion, and end-to-end discovery through a real scan.
 *
 * The naming cases are not hypothetical — they're the shapes Bazarr, Sonarr, Radarr and yt-dlp
 * actually write. Getting one wrong doesn't error, it just silently drops a track, which is the
 * failure mode this feature exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo, writeShow } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { subtitlesFor } = await import('../src/lib/server/queries');
const { parseSubtitleName, findSubtitles, srtToVtt, parseProbedStreams } = await import('../src/lib/server/subtitles');
const { db } = await import('../src/lib/server/db');

describe('sidecar naming', () => {
	const base = 'Heat (1995)';
	const p = (n: string) => parseSubtitleName(base, n);

	it('reads the language, mapping 3-letter codes', () => {
		expect(p('Heat (1995).en.srt')).toMatchObject({ lang: 'en', label: 'English', kind: 'subtitles' });
		expect(p('Heat (1995).eng.srt')).toMatchObject({ lang: 'en', label: 'English' });
		expect(p('Heat (1995).spa.vtt')).toMatchObject({ lang: 'es', label: 'Spanish' });
	});

	it('keeps a region tag and passes unknown codes through rather than dropping the track', () => {
		expect(p('Show - S01E01.pt-BR.srt')).toBeNull(); // different base — not this video's sidecar
		expect(parseSubtitleName('Show - S01E01', 'Show - S01E01.pt-BR.srt')).toMatchObject({ lang: 'pt-BR' });
		expect(parseSubtitleName('X', 'X.cat.srt')).toMatchObject({ lang: 'ca', label: 'Catalan' });
		expect(parseSubtitleName('X', 'X.zzz.srt')).toMatchObject({ lang: 'zzz', label: 'ZZZ' });
	});

	it('marks SDH/CC as CAPTIONS — the distinction accessibility law turns on', () => {
		expect(p('Heat (1995).en.sdh.srt')).toMatchObject({ kind: 'captions', label: 'English (SDH)' });
		expect(p('Heat (1995).en.cc.srt')).toMatchObject({ kind: 'captions' });
		expect(p('Heat (1995).en.hi.srt')).toMatchObject({ kind: 'captions' });
		expect(p('Heat (1995).en.srt')).toMatchObject({ kind: 'subtitles' });
	});

	it('flags forced tracks and orders them last', () => {
		expect(p('Heat (1995).en.forced.srt')).toMatchObject({ forced: true, label: 'English (forced)' });
		const order = findSubtitles(
			['Heat (1995).es.forced.srt', 'Heat (1995).es.srt', 'Heat (1995).en.sdh.srt'],
			'Heat (1995).mkv'
		);
		expect(order.map((t) => t.label)).toEqual(['English (SDH)', 'Spanish', 'Spanish (forced)']);
	});

	it('accepts a bare sidecar and ignores files belonging to something else', () => {
		expect(p('Heat (1995).srt')).toMatchObject({ lang: null, label: 'Unknown' });
		expect(p('Heat (1995).jpg')).toBeNull();
		expect(p('Heat (1996).en.srt')).toBeNull();
		expect(p('Heat (1995) trailer.en.srt')).toBeNull(); // no dot after the base
	});
});

describe('srtToVtt', () => {
	it('adds the header and converts comma decimals', () => {
		const out = srtToVtt('1\r\n00:00:01,200 --> 00:00:04,000\r\nHello\r\n');
		expect(out.startsWith('WEBVTT\n\n')).toBe(true);
		expect(out).toContain('00:00:01.200 --> 00:00:04.000');
		expect(out).not.toContain('\r');
	});

	it('strips a BOM — otherwise the first cue is silently dropped', () => {
		expect(srtToVtt('﻿1\n00:00:01,000 --> 00:00:02,000\nHi\n')).toContain('00:00:01.000');
	});
});

describe('discovery through a scan', () => {
	let videoId = '';
	beforeAll(async () => {
		writeChannelVideo(env.mediaRoot, 'Chan', 'clip1');
		writeFileSync(path.join(env.mediaRoot, 'Chan', 'clip1.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
		writeFileSync(path.join(env.mediaRoot, 'Chan', 'clip1.es.sdh.vtt'), 'WEBVTT\n\n');
		writeShow(env.mediaRoot, 'Shows', 'A Show'); // no sidecars — must stay empty
		addLibrary('Chans', '', 'channels', false);
		addLibrary('Shows', 'Shows', 'series', false);
		await scan();
		videoId = (db().prepare("SELECT id FROM videos WHERE video_path LIKE '%clip1.mp4'").get() as { id: string }).id;
	});
	afterAll(() => env.cleanup());

	it('attaches both sidecars, captions first', () => {
		const subs = subtitlesFor(videoId);
		expect(subs.map((s) => s.label)).toEqual(['Spanish (SDH)', 'English']);
		expect(subs[0].kind).toBe('captions');
		expect(subs[1].path.endsWith('clip1.en.srt')).toBe(true);
	});

	it('leaves a video with no sidecars empty', () => {
		const ep = db().prepare("SELECT id FROM videos WHERE video_path LIKE '%S01E01%'").get() as { id: string };
		expect(subtitlesFor(ep.id)).toEqual([]);
	});

	it('picks up a subtitle ADDED AFTER the video was indexed, without a full rescan', async () => {
		// The real-world case: Bazarr fetches subtitles hours after the video landed. An incremental
		// scan skips the unchanged video, so discovery must not be tied to re-parsing it.
		writeFileSync(path.join(env.mediaRoot, 'Chan', 'clip1.fr.srt'), 'WEBVTT\n\n');
		await scan(); // incremental — clip1 itself is unchanged
		expect(subtitlesFor(videoId).map((s) => s.label)).toContain('French');
	});

	it('drops the row when the sidecar is deleted', async () => {
		const { unlinkSync } = await import('node:fs');
		unlinkSync(path.join(env.mediaRoot, 'Chan', 'clip1.fr.srt'));
		await scan();
		expect(subtitlesFor(videoId).map((s) => s.label)).not.toContain('French');
	});

	// The regression that made this test exist: syncSubtitles compared a video's FULL row set against
	// the sidecars on disk, decided they differed, and deleted everything — so every 5-minute rescan
	// wiped embedded tracks, and since the file stayed marked as probed they never came back. Two
	// writers (scan owns sidecars, probe owns embedded), two disjoint sets.
	it('a scan leaves EMBEDDED rows alone', async () => {
		db()
			.prepare(
				"INSERT OR REPLACE INTO video_subtitles (video_id, lang, label, kind, forced, sub_path, ord, stream_index) VALUES (?, 'en', 'English (embedded)', 'captions', 0, '#2', 9, 2)"
			)
			.run(videoId);
		await scan();
		const labels = subtitlesFor(videoId).map((s) => s.label);
		expect(labels).toContain('English (embedded)'); // survived the scan
		expect(labels).toContain('English'); // …and so did the sidecar
	});
});


describe('embedded tracks (ffprobe output)', () => {
	const probe = (streams: unknown[]) => parseProbedStreams(JSON.stringify({ streams }));

	it('takes text codecs and reads language/title/disposition', () => {
		const r = probe([
			{ index: 2, codec_name: 'subrip', tags: { language: 'eng' }, disposition: {} },
			{ index: 3, codec_name: 'subrip', tags: { language: 'eng', title: 'SDH' }, disposition: { hearing_impaired: 1 } },
			{ index: 4, codec_name: 'ass', tags: { language: 'jpn' }, disposition: { forced: 1 } }
		]);
		expect(r.tracks.map((t) => [t.label, t.kind, t.streamIndex])).toEqual([
			['English', 'subtitles', 2],
			['English (SDH)', 'captions', 3],
			['Japanese (forced)', 'subtitles', 4]
		]);
		expect(r.skipped).toEqual([]);
	});

	it('SKIPS bitmap subtitles and reports them — a menu entry that fails is worse than none', () => {
		const r = probe([
			{ index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
			{ index: 3, codec_name: 'dvd_subtitle', tags: { language: 'spa' } }
		]);
		expect(r.tracks).toEqual([]);
		expect(r.skipped).toEqual(['hdmv_pgs_subtitle', 'dvd_subtitle']);
	});

	it('treats "und" as no language rather than inventing one', () => {
		const r = probe([{ index: 2, codec_name: 'mov_text', tags: { language: 'und' } }]);
		expect(r.tracks[0]).toMatchObject({ lang: null, label: 'Unknown' });
	});

	it('survives junk without throwing — a bad probe means "no tracks", never a 500', () => {
		expect(parseProbedStreams('not json')).toEqual({ tracks: [], skipped: [] });
		expect(parseProbedStreams('{}')).toEqual({ tracks: [], skipped: [] });
	});
});
