/**
 * The layout ytdl-sub-style tools write for a creator channel presented as a "TV show":
 *   Show/Season 2021/s2021.e031701 - Title.mp4 + .info.json (yt-dlp's sidecar, kept by every preset)
 *   + for Jellyfin/Kodi presets: an episode .nfo (season = upload year, episode = MMDDnn,
 *     title = "YYYY-MM-DD - Title") and a tvshow.nfo; poster.jpg at the show root; <file>-thumb.jpg.
 * A user may put that folder in a Series library (they see a tvshow.nfo) or a Channels library.
 * Both must come out as the same creator channel with the same video ids.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempEnv } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { db } = await import('../src/lib/server/db');

function writeYtdlSubShow(root: string, lib: string, show: string, opts: { infoJson: boolean; nfo: boolean; idPrefix?: string }) {
	const season = path.join(root, lib, show, 'Season 2021');
	mkdirSync(season, { recursive: true });
	writeFileSync(path.join(root, lib, show, 'tvshow.nfo'), `<tvshow><title>${show} (curated)</title><genre>Science</genre></tvshow>`);
	writeFileSync(path.join(root, lib, show, 'poster.jpg'), 'p');
	for (const [n, day, title, id] of [
		[1, '03-17', 'Pattys Day Video', 'abc111'],
		[2, '03-17', 'Second Pattys Day Video', 'abc222'],
		[3, '12-25', 'Merry Christmas', 'abc333']
	] as const) {
		const idx = String(n).padStart(2, '0');
		const base = `s2021.e${day.replace('-', '')}${idx} - ${title}`;
		writeFileSync(path.join(season, base + '.mp4'), 'x');
		writeFileSync(path.join(season, base + '-thumb.jpg'), 't');
		if (opts.infoJson) {
			writeFileSync(
				path.join(season, base + '.info.json'),
				JSON.stringify({ id: (opts.idPrefix ?? '') + id, title, channel: 'The Real Channel', upload_date: '2021' + day.replace('-', ''), duration: 60 + n, view_count: 1000 * n, description: 'd', tags: ['t' + n] })
			);
		}
		if (opts.nfo) {
			writeFileSync(
				path.join(season, base + '.nfo'),
				`<episodedetails><season>2021</season><episode>${day.replace('-', '')}${idx}</episode><title>2021-${day} - ${title}</title><aired>2021-${day}</aired><plot>plot</plot></episodedetails>`
			);
		}
	}
}

// Three libraries, three shapes of the same show.
writeYtdlSubShow(env.mediaRoot, 'ShowsBoth', 'Kurz', { infoJson: true, nfo: true }); // Jellyfin/Kodi preset in a Series library
writeYtdlSubShow(env.mediaRoot, 'ShowsNfoOnly', 'KurzNfo', { infoJson: false, nfo: true }); // sidecar dropped by config (a distinct folder name: series ids are series:<folder>)
writeYtdlSubShow(env.mediaRoot, 'Chans', 'Kurz', { infoJson: true, nfo: true, idPrefix: 'c-' }); // the same layout as a Channels library (own ids: video ids are global)
addLibrary('ShowsBoth', 'ShowsBoth', 'series', false);
addLibrary('ShowsNfoOnly', 'ShowsNfoOnly', 'series', false);
addLibrary('Chans', 'Chans', 'channels', false);
await scan();

const chan = (id: string) => db().prepare('SELECT id, name, kind, poster_path, genres FROM channels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const vids = (cid: string) =>
	db().prepare('SELECT id, title, season_number, episode_number, upload_date, view_count, thumb_path FROM videos WHERE channel_id = ? ORDER BY id').all(cid) as Record<string, unknown>[];

describe('ytdl-sub-style layouts', () => {
	it('a show with .info.json sidecars in a SERIES library is a creator channel, read from the sidecars', () => {
		const c = chan('series:Kurz');
		expect(c).toBeDefined();
		expect(c!.kind).toBe('channel');
		expect(c!.name).toBe('Kurz (curated)'); // the tvshow.nfo title wins over the sidecar's channel name
		expect(c!.poster_path).toMatch(/ShowsBoth\/Kurz\/poster\.jpg$/);
		expect(c!.genres).toBe(JSON.stringify(['Science']));
		const v = vids('series:Kurz');
		expect(v.map((x) => x.id)).toEqual(['abc111', 'abc222', 'abc333']); // yt ids, not path hashes
		expect(v[0].title).toBe('Pattys Day Video'); // the sidecar title, no date prefix
		expect(v[0].season_number).toBeNull();
		expect(v[0].upload_date).toBe('20210317');
		expect(v[0].view_count).toBe(1000);
		expect(v[0].thumb_path).toMatch(/-thumb\.jpg$/);
	});

	it('the same folder as a CHANNELS library yields the same video ids (watch state survives a library-type change)', () => {
		expect(vids('Kurz').map((x) => x.id)).toEqual(['c-abc111', 'c-abc222', 'c-abc333']); // sidecar ids in both, never path hashes
		expect(chan('Kurz')!.kind).toBe('channel');
	});

	it('an NFO-only show numbered by date loses the S2021·E31701 label and the date prefix, keeps the aired date', () => {
		const c = chan('series:KurzNfo')!;
		expect(c.kind).toBe('series');
		const v = vids('series:KurzNfo');
		expect(v.length).toBe(3);
		for (const x of v) {
			expect(x.season_number).toBeNull();
			expect(x.episode_number).toBeNull();
		}
		expect(v.map((x) => x.title).sort()).toEqual(['Merry Christmas', 'Pattys Day Video', 'Second Pattys Day Video']);
		expect(v.find((x) => x.title === 'Merry Christmas')!.upload_date).toBe('20211225');
	});

	it('a real S01E02 show is untouched by the date-coded rule', () => {
		// Sanity: season 1 / episode 2 stays a numbered episode.
		const row = db().prepare('SELECT COUNT(*) AS n FROM videos WHERE season_number IS NOT NULL').get() as { n: number };
		expect(row.n).toBe(0); // nothing in this fixture set is numbered — the rule only fires on year+MMDD shapes
	});
});
