/**
 * The movies library format end-to-end: scan a Radarr-style tree → ONE synthetic `kind='movies'`
 * channel, movie rows with year/genres/poster, the fanart-as-thumb card-art rule, tmdb-keyed ids,
 * and the movies grid sorts (title/year/added). Runs against the real indexer + queries on a temp
 * MEDIA_ROOT (⇔ scan-safety.test.ts structure).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { utimesSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeMovie, writeChannelVideo, writeShow } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { db } = await import('../src/lib/server/db');
const { addLibrary, updateLibrary, listLibraries } = await import('../src/lib/server/libraries');
const { getChannel, listVideos, relatedVideos, getVideo, listChannels } = await import('../src/lib/server/queries');
const { createUser } = await import('../src/lib/server/auth');

const HEAT_NFO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>Heat</title>
  <year>1995</year>
  <premiered>1995-12-15</premiered>
  <plot>A crew of thieves and the detective obsessed with catching them.</plot>
  <genre>Crime</genre>
  <genre>Thriller</genre>
  <director>Michael Mann</director>
  <actor><name>Al Pacino</name><order>0</order></actor>
  <actor><name>Robert De Niro</name><order>1</order></actor>
  <actor><name>Val Kilmer</name><order>2</order></actor>
  <actor><name>Jon Voight</name><order>3</order></actor>
  <actor><name>Tom Sizemore</name><order>4</order></actor>
  <actor><name>Diane Venora</name><order>5</order></actor>
  <runtime>170</runtime>
  <uniqueid type="tmdb" default="true">949</uniqueid>
  <uniqueid type="imdb">tt0113277</uniqueid>
  <fileinfo><streamdetails>
    <video><codec>h265</codec><width>1920</width><height>800</height><durationinseconds>10230</durationinseconds></video>
    <audio><codec>eac3</codec></audio>
  </streamdetails></fileinfo>
</movie>`;

let uid = 0;
let chanId = '';

beforeAll(async () => {
	uid = (await createUser('owner', 'pw123456')).id;
	writeMovie(env.mediaRoot, 'Movies', 'Heat (1995)', { nfo: HEAT_NFO, poster: true, fanart: true });
	// NFO-less: metadata must come from the `Name (Year)` folder convention; poster-only art.
	writeMovie(env.mediaRoot, 'Movies', 'Alien (1979)', { nfo: null, poster: true, ext: '.mp4' });
	// Shares the Crime genre AND a top-billed actor with Heat — must rank FIRST in Heat's rail.
	writeMovie(env.mediaRoot, 'Movies', 'Ronin (1998)', {
		nfo: '<movie><title>Ronin</title><year>1998</year><genre>Crime</genre><actor><name>Robert De Niro</name><order>0</order></actor><uniqueid type="tmdb">8195</uniqueid></movie>'
	});
	// A CHANNEL video sharing the genre word as a tag — the movies rail must never surface it.
	writeChannelVideo(env.mediaRoot, 'ChannelX', 'cv1', { tags: ['Crime'] })
	// A show with tvshow.nfo genres — they live on the CHANNEL for the shows-grid filter.
	writeShow(env.mediaRoot, 'Shows', 'Heat The Series', ['Crime', 'Drama']);
	addLibrary('Films', 'Movies', 'movies', false);
	addLibrary('Shows', 'Shows', 'series', false);
	addLibrary('Chans', '', 'channels', false); // root channels library (Movies/Shows subfolders auto-excluded)
	chanId = 'movies:' + listLibraries().find((l) => l.path === 'Movies')!.id;
	await scan();
});
afterAll(() => env.cleanup());

describe('movies library', () => {
	it('indexes ONE synthetic movies channel named after the library', () => {
		const chans = db().prepare("SELECT id, name, kind FROM channels WHERE kind = 'movies'").all() as {
			id: string;
			name: string;
			kind: string;
		}[];
		expect(chans).toHaveLength(1);
		expect(chans[0].id).toBe(chanId);
		expect(chans[0].name).toBe('Films');
	});

	it('parses the <movie> NFO: tmdb id, year, plot, runtime→duration source, codecs', () => {
		const v = db().prepare('SELECT * FROM videos WHERE id = ?').get('tmdb-949') as Record<string, unknown>;
		expect(v).toBeTruthy();
		expect(v.title).toBe('Heat');
		expect(v.year).toBe(1995);
		expect(v.upload_date).toBe('19951215');
		expect(v.duration).toBe(10230); // streamdetails wins over <runtime>
		expect(v.vcodec).toBe('hevc');
		expect(v.acodec).toBe('eac3');
		expect(v.channel_id).toBe(chanId);
	});

	it('genres become tags; top-5 cast + director become NAMESPACED person: entries', () => {
		const tags = (db().prepare('SELECT tag FROM video_tags WHERE video_id = ? ORDER BY tag').all('tmdb-949') as {
			tag: string;
		}[]).map((r) => r.tag);
		expect(tags).toContain('Crime');
		expect(tags).toContain('Thriller');
		expect(tags).toContain('person:Al Pacino'); // order 0
		expect(tags).toContain('person:Tom Sizemore'); // order 4 — the last of the top 5
		expect(tags).toContain('person:Michael Mann'); // director rides the same namespace
		expect(tags).not.toContain('person:Diane Venora'); // order 5 — beyond the top-billed cap
	});

	it('getVideo strips the namespaced entries — tag chips only ever show genres', () => {
		expect(getVideo('tmdb-949')!.tags).toEqual(['Crime', 'Thriller']);
	});

	it('card-art rule: thumb_path = fanart (16:9 feed art), poster_path = the 2:3 poster', () => {
		const v = db().prepare('SELECT thumb_path, poster_path FROM videos WHERE id = ?').get('tmdb-949') as {
			thumb_path: string;
			poster_path: string;
		};
		expect(v.thumb_path).toContain('fanart.jpg');
		expect(v.poster_path).toContain('poster.jpg');
	});

	it('NFO-less movie falls back to the Name (Year) convention; poster fills the thumb slot', () => {
		const v = db()
			.prepare("SELECT * FROM videos WHERE title = 'Alien'")
			.get() as Record<string, unknown> | undefined;
		expect(v).toBeTruthy();
		expect(v!.year).toBe(1979);
		expect(String(v!.id)).toMatch(/^ep-/); // path-hash id — no provider uniqueid available
		expect(String(v!.thumb_path)).toContain('poster.jpg'); // no fanart → poster fallback
	});

	it('un-renamed scene names parse: bare-year split, dot separators, site prefixes', async () => {
		writeMovie(env.mediaRoot, 'Movies', 'American.Reunion.2012.UNRATED.BluRay.1080p.DTS-HD.MA.5.1.AVC.REMUX-FraMeSToR', { nfo: null });
		writeMovie(env.mediaRoot, 'Movies', 'www.UIndex.org - Bad Words 2013', { nfo: null });
		writeMovie(env.mediaRoot, 'Movies', 'Blade.Runner.2049.2017.2160p.WEB-DL', { nfo: null });
		await scan();
		const t = (title: string) =>
			db().prepare('SELECT year FROM videos WHERE title = ?').get(title) as { year: number } | undefined;
		expect(t('American Reunion')?.year).toBe(2012);
		expect(t('Bad Words')?.year).toBe(2013);
		expect(t('Blade Runner 2049')?.year).toBe(2017); // greedy: the LAST year token anchors
		// Remove them again (prune on rescan) so the grid/sort assertions below see the original set.
		for (const dir of [
			'American.Reunion.2012.UNRATED.BluRay.1080p.DTS-HD.MA.5.1.AVC.REMUX-FraMeSToR',
			'www.UIndex.org - Bad Words 2013',
			'Blade.Runner.2049.2017.2160p.WEB-DL'
		]) {
			rmSync(path.join(env.mediaRoot, 'Movies', dir), { recursive: true });
		}
		await scan();
	});

	it('movies grid always lists everything and sorts title/year/added', () => {
		const byTitle = getChannel(chanId, uid, false, 'title')!;
		expect(byTitle.channel.kind).toBe('movies');
		expect(byTitle.videos.map((v) => v.title)).toEqual(['Alien', 'Heat', 'Ronin']);
		const byYear = getChannel(chanId, uid, false, 'year')!;
		expect(byYear.videos.map((v) => v.year)).toEqual([1998, 1995, 1979]); // newest year first
		const byAdded = getChannel(chanId, uid, false, 'added')!;
		expect(byAdded.videos).toHaveLength(3); // added = file mtime — all just written; order not asserted
	});

	it('a movie’s related rail is OTHER MOVIES only — genre-ranked, never channel videos', () => {
		const rel = relatedVideos('tmdb-949', uid, 8);
		expect(rel.length).toBeGreaterThan(0);
		// Movies only — the channel video tagged 'Crime' must not appear (the generic matcher would
		// have ranked it ABOVE other movies thanks to the same-channel penalty).
		expect(rel.every((v) => v.channel_id === chanId)).toBe(true);
		// Shared-genre movie first; the genre-less one still fills the rail (year proximity).
		expect(rel[0].id).toBe('tmdb-8195');
		expect(rel.some((v) => v.title === 'Alien')).toBe(true);
	});

	it('genres surface for filtering: show channels carry tvshow.nfo genres; the movies channel aggregates; wall videos carry theirs', () => {
		const chans = listChannels({ id: uid });
		const show = chans.find((c) => c.name === 'Heat The Series')!;
		expect(show.genres).toEqual(['Crime', 'Drama']);
		const moviesChan = chans.find((c) => c.id === chanId)!;
		expect(moviesChan.genres).toEqual(['Crime', 'Thriller']); // union of its films', namespaced excluded
		// Per-movie genres in the wall response (client-side filtering) — person:/set: never leak.
		const wall = getChannel(chanId, uid)!;
		const heat = wall.videos.find((v) => v.id === 'tmdb-949')!;
		expect(heat.genres).toEqual(['Crime', 'Thriller']);
		// Episodes never inherit show genres (they'd flood /tag pages) — and channel videos have none.
		expect(wall.channel.kind).toBe('movies');
	});

	it('"recently added" is DURABLE: touching a file cannot resurface it as new', async () => {
		const ts = () =>
			(db().prepare('SELECT timestamp FROM videos WHERE id = ?').get('tmdb-949') as { timestamp: number }).timestamp;
		const before = ts();
		// The reported bug: some tool touches the file → mtime jumps → the movie falsely tops "added".
		const f = path.join(env.mediaRoot, 'Movies', 'Heat (1995)', 'Heat (1995).mkv');
		const future = new Date(Date.now() + 60_000);
		utimesSync(f, future, future);
		await scan(true); // full rescan re-reads everything
		expect(ts()).toBe(before); // frozen first-seen (state.videos_seen), not the live mtime
	});

	it('library feed opt-out: movies leave Recent but stay in search + tag browsing', () => {
		const lib = listLibraries().find((l) => l.path === 'Movies')!;
		// On by default — freshly-written files (mtime = now) surface in the feed.
		expect(listVideos({ userId: uid }).some((v) => v.id === 'tmdb-949')).toBe(true);
		updateLibrary(lib.id, lib.name, lib.path!, lib.format, lib.newPrivate, false);
		// The FEED drops the whole library…
		expect(listVideos({ userId: uid }).some((v) => v.id === 'tmdb-949')).toBe(false);
		// …but search and genre/tag browsing still reach it (the opt-out is FEED-ONLY by design).
		expect(listVideos({ userId: uid, q: 'Heat' }).some((v) => v.id === 'tmdb-949')).toBe(true);
		expect(listVideos({ userId: uid, tag: 'Crime' }).some((v) => v.id === 'tmdb-949')).toBe(true);
	});
});
