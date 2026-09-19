/**
 * contentStats — the About page's "your library" panel. Two things matter here: the per-format
 * breakdown must count the right rows (channels vs shows vs films are three different shapes over
 * the same two tables), and the numbers must go through the SAME visibility filter as every other
 * read. The second is the reason this has a test at all: About is shown to EVERY user, so a
 * private channel leaking into a shared total would be a real disclosure — the count itself tells
 * a non-granted user that content exists. Runs against the real indexer + queries on a temp
 * MEDIA_ROOT (⇔ channels-watched.test.ts structure).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { tempEnv, writeChannelVideo, writeShow, writeMovie } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { contentStats, listChannels } = await import('../src/lib/server/queries');
const { setChannelPrivate } = await import('../src/lib/server/visibility');
const { createUser } = await import('../src/lib/server/auth');

let owner = 0;
let viewer = 0;

beforeAll(async () => {
	owner = (await createUser('owner', 'pw123456')).id; // first account = the owner (bypasses visibility)
	viewer = (await createUser('viewer', 'pw123456')).id;
	writeChannelVideo(env.mediaRoot, 'Chans/Public Chan', 'a1', { duration: 600 });
	writeChannelVideo(env.mediaRoot, 'Chans/Public Chan', 'a2', { duration: 600 });
	writeChannelVideo(env.mediaRoot, 'Chans/Secret Chan', 'b1', { duration: 1200 });
	writeShow(env.mediaRoot, 'Shows', 'Some Show');
	writeMovie(env.mediaRoot, 'Movies', 'Heat (1995)');
	addLibrary('Chans', 'Chans', 'channels', false);
	addLibrary('Shows', 'Shows', 'series', false);
	addLibrary('Films', 'Movies', 'movies', false);
	await scan();
});
afterAll(() => env.cleanup());

describe('contentStats', () => {
	it('breaks the library down by format', () => {
		const s = contentStats({ id: owner });
		expect(s.videos).toBe(5); // 3 channel videos + 1 episode + 1 film
		expect(s.byKind.channel).toEqual({ channels: 2, videos: 3 });
		expect(s.byKind.series).toEqual({ channels: 1, videos: 1 });
		// A movies library is ONE synthetic channel; the films are its videos (that's what the page counts).
		expect(s.byKind.movies.channels).toBe(1);
		expect(s.byKind.movies.videos).toBe(1);
	});

	it('sums indexed durations, treating items without one as zero', () => {
		// 600 + 600 + 1200 from the sidecars; the NFO-less show/film index with no duration.
		expect(contentStats({ id: owner }).seconds).toBe(2400);
	});

	it('counts nothing federated in a purely local library', () => {
		expect(contentStats({ id: owner }).federated).toBe(0);
	});

	it('hides a private channel from a non-granted user — including from the totals', () => {
		const secret = listChannels({ id: owner }).find((c) => c.name === 'Secret Chan')!;
		setChannelPrivate(secret.id, true);
		const mine = contentStats({ id: owner });
		const theirs = contentStats({ id: viewer });
		expect(mine.videos).toBe(5); // owner bypasses visibility
		expect(theirs.videos).toBe(4);
		expect(theirs.byKind.channel).toEqual({ channels: 1, videos: 2 });
		expect(theirs.seconds).toBe(1200); // the private channel's 1200s is gone, not just its rows
	});
});
