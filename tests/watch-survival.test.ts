/**
 * Watch state survives re-indexing — the property that makes "Scan now" (full) and even an index.db
 * rebuild safe to run on a live deploy. Watch rows live in state.db keyed (user_id, video_id) and the
 * indexer never touches that table, so survival == VIDEO ID STABILITY across a re-parse. Covers all
 * three id families: a channel video (yt `info.id`), an NFO movie (`tmdb-…`), and an NFO-less
 * scene-name movie (`ep-<path hash>`), through a full=1 rescan AND an emptied-index rebuild.
 * (The known, deliberate hazard is NOT the rescan: it's renaming/moving a file or an NFO appearing
 * later — either flips a path-hash id, orphaning that one item's watch row.)
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { tempEnv, writeMovie, writeChannelVideo } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const { saveWatch, getWatch } = await import('../src/lib/server/watch');
const { db } = await import('../src/lib/server/db');

let uid: number;
let ids: string[] = [];

const indexIds = (): Set<string> =>
	new Set((db().prepare('SELECT id FROM videos').all() as { id: string }[]).map((r) => r.id));

describe('watch state survives re-indexing', () => {
	beforeAll(async () => {
		writeMovie(env.mediaRoot, 'Movies', 'Heat (1995)', {
			nfo: '<movie><title>Heat</title><year>1995</year><uniqueid type="tmdb">949</uniqueid></movie>'
		});
		writeMovie(env.mediaRoot, 'Movies', 'American.Reunion.2012.UNRATED.BluRay.1080p.REMUX-GRP', { nfo: null });
		writeChannelVideo(env.mediaRoot, 'Chans/somechannel', 'yt-abc123');
		addLibrary('Movies', 'Movies', 'movies', false);
		addLibrary('Chans', 'Chans', 'channels', false);
		await scan();
		uid = (await createUser('owner', 'pw123456')).id;

		ids = [...indexIds()];
		expect(ids.length).toBe(3);
		saveWatch(uid, ids[0], { position: 123 });
		saveWatch(uid, ids[1], { watched: true });
		saveWatch(uid, ids[2], { position: 45 });
	});
	afterAll(() => env.cleanup());

	it('a FULL rescan re-parses everything but keeps every id — watch rows still join', async () => {
		await scan(true);
		const after = indexIds();
		for (const id of ids) expect(after.has(id)).toBe(true); // id stability = the join survives
		expect(getWatch(uid, ids[0]).position).toBe(123);
		expect(getWatch(uid, ids[1]).watched).toBe(true);
		expect(getWatch(uid, ids[2]).position).toBe(45);
	});

	it('an index.db rebuild (emptied index → rescan) restores the same ids — nothing orphans', async () => {
		db().exec('DELETE FROM videos; DELETE FROM channels'); // what deleting index.db amounts to
		await scan();
		const after = indexIds();
		for (const id of ids) expect(after.has(id)).toBe(true);
		expect(getWatch(uid, ids[0]).position).toBe(123);
		expect(getWatch(uid, ids[1]).watched).toBe(true);
	});
});
