/**
 * The hide-watched rules (contract §channels + §Movies). GRID: listChannels + isFullyWatched drop
 * a channel/series once this user has watched everything in it — the shared default behind the web
 * /channels load and /api/{channels,v1/channels} — while movies channels (only their MOVIES hide,
 * never the library tile) and empty channels stay. DETAIL: getChannel hides watched items by
 * default for channels AND movies walls (`?watched=1` reveals); series still return every episode.
 * Runs against the real indexer + queries on a temp MEDIA_ROOT (⇔ movies.test.ts structure).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { tempEnv, writeChannelVideo, writeShow, writeMovie } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { listChannels, isFullyWatched, getChannel } = await import('../src/lib/server/queries');
const { setChannelWatched, saveWatch } = await import('../src/lib/server/watch');
const { createUser } = await import('../src/lib/server/auth');

let uid = 0;

/** The default grid every list surface serves (web load + both channel APIs share this filter). */
const defaultGrid = () => listChannels({ id: uid }).filter((c) => !isFullyWatched(c));
const byName = (name: string) => listChannels({ id: uid }).find((c) => c.name === name)!;

beforeAll(async () => {
	uid = (await createUser('owner', 'pw123456')).id;
	writeShow(env.mediaRoot, 'Shows', 'Finished Show');
	writeShow(env.mediaRoot, 'Shows', 'Fresh Show');
	writeChannelVideo(env.mediaRoot, 'ChannelX', 'cv1');
	writeChannelVideo(env.mediaRoot, 'ChannelX', 'cv2');
	writeMovie(env.mediaRoot, 'Movies', 'Heat (1995)');
	addLibrary('Shows', 'Shows', 'series', false);
	addLibrary('Films', 'Movies', 'movies', false);
	addLibrary('Chans', '', 'channels', false); // root channels library (Shows/Movies auto-excluded)
	await scan();
	// Everything watched in the finished show AND the movies library; ChannelX only half-watched.
	setChannelWatched(uid, byName('Finished Show').id, true);
	setChannelWatched(uid, byName('Films').id, true);
	saveWatch(uid, 'cv1', { watched: true });
});
afterAll(() => env.cleanup());

describe('grid hide-watched (isFullyWatched)', () => {
	it('drops a fully-watched series from the default grid; ?watched=1 (unfiltered) keeps it', () => {
		const names = defaultGrid().map((c) => c.name);
		expect(names).not.toContain('Finished Show');
		expect(listChannels({ id: uid }).map((c) => c.name)).toContain('Finished Show');
	});

	it('keeps a fresh series and a partially-watched channel', () => {
		const names = defaultGrid().map((c) => c.name);
		expect(names).toContain('Fresh Show');
		expect(names).toContain('ChannelX');
		expect(byName('ChannelX').unwatched).toBe(1);
	});

	it('never drops a movies channel — the wall is the collection, watched is a badge', () => {
		expect(byName('Films').unwatched).toBe(0); // really all watched…
		expect(defaultGrid().map((c) => c.name)).toContain('Films'); // …yet still listed
	});

	it('never drops an empty channel — nothing there yet is not "all seen"', () => {
		expect(isFullyWatched({ kind: 'channel', video_count: 0, unwatched: 0 })).toBe(false);
	});

	it('resurfaces a finished show the moment it stops being fully watched', () => {
		setChannelWatched(uid, byName('Finished Show').id, false);
		expect(defaultGrid().map((c) => c.name)).toContain('Finished Show');
		setChannelWatched(uid, byName('Finished Show').id, true); // restore for other tests
	});
});

describe('detail hide-watched (getChannel showAll gate)', () => {
	it('movies wall hides watched movies by default; showWatched reveals the collection', () => {
		const films = byName('Films').id;
		expect(getChannel(films, uid)!.videos).toHaveLength(0); // Heat is watched
		expect(getChannel(films, uid, true)!.videos).toHaveLength(1);
	});

	it('a flat channel hides watched videos by default (unchanged)', () => {
		const wall = getChannel(byName('ChannelX').id, uid)!;
		expect(wall.videos.map((v) => v.id)).toEqual(['cv2']); // cv1 is watched
	});

	it('a series still returns ALL episodes — the exemption movies just left', () => {
		const show = getChannel(byName('Finished Show').id, uid)!; // fully watched in beforeAll
		expect(show.videos).toHaveLength(1);
		expect(show.videos[0].watched).toBe(true);
	});
});
