/**
 * Plex watch-progress sync: the PIN ceremony (per-user client identifier, server-token
 * resolution), the three-tier matcher, and the two-way merge matrix — initial union, unwatch
 * import via full-pull diffing, push read-back, the 60s progress floor, tie/noise guards, and
 * ping-pong absence over repeated cycles. Everything runs against a stubbed plex.tv + PMS via
 * setPlexFetch (docs/plex-sync.md).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { tempEnv, writeChannelVideo, writeShow, writeMovie } from './helpers';

const env = tempEnv();

const { scan } = await import('../src/lib/server/indexer');
const { db } = await import('../src/lib/server/db');
const { addLibrary } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const { saveWatch, getWatch } = await import('../src/lib/server/watch');
const { serverId } = await import('../src/lib/server/federation');
const { setPlexFetch } = await import('../src/lib/server/plexclient');
const link = await import('../src/lib/server/plexlink');
const sync = await import('../src/lib/server/plexsync');

// ---------------------------------------------------------------------------------------------
// The stubbed Plex world: plex.tv (pins/user/resources) + a PMS with two sections and mutable
// per-item view state. Progress deliberately does NOT bump lastViewedAt (models Plex's
// unpredictable stamping — the read-back path must cope).
// ---------------------------------------------------------------------------------------------
interface StubItem {
	ratingKey: string;
	section: string;
	type: 1 | 4;
	Guid?: { id: string }[];
	guid?: string;
	file?: string;
	viewCount: number;
	viewOffset: number;
	lastViewedAt: number | null;
}
const world = {
	items: [] as StubItem[],
	authToken: null as string | null, // pin completes when set
	down: false,
	seenIdentifiers: new Set<string>(),
	resourcesFor: 'machine-1' // clientIdentifier the resources response advertises
};
const nowS = () => Math.floor(Date.now() / 1000);

setPlexFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
	if (world.down) throw new TypeError('fetch failed');
	const u = new URL(String(input));
	const json = (x: unknown, status = 200) =>
		new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
	const hdrs = new Headers(init?.headers);
	const cid = hdrs.get('x-plex-client-identifier');
	if (cid) world.seenIdentifiers.add(cid);

	// plex.tv
	if (u.hostname === 'plex.tv') {
		if (u.pathname === '/api/v2/pins')
			return json({ id: 7, code: 'WXYZ', authToken: null, expiresAt: new Date(Date.now() + 900_000).toISOString() });
		if (u.pathname === '/api/v2/pins/7')
			return json({ id: 7, code: 'WXYZ', authToken: world.authToken, expiresAt: new Date(Date.now() + 900_000).toISOString() });
		if (u.pathname === '/api/v2/user') {
			if (hdrs.get('x-plex-token') !== 'acct-tok') return json({ error: 'unauthorized' }, 401);
			return json({ uuid: 'uuid-bob', username: 'plexbob' });
		}
		if (u.pathname === '/api/v2/resources')
			return json([
				{ clientIdentifier: world.resourcesFor, provides: 'server', accessToken: 'srv-tok', owned: true }
			]);
		return json({}, 404);
	}

	// PMS
	if (u.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: 'machine-1', version: '1.41.0' } });
	if (hdrs.get('x-plex-token') !== 'srv-tok') return json({ error: 'unauthorized' }, 401);
	if (u.pathname === '/library/sections')
		return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }, { key: '2', type: 'show', title: 'Shows' }] } });
	const sec = u.pathname.match(/^\/library\/sections\/(\d+)\/all$/);
	if (sec) {
		const type = Number(u.searchParams.get('type'));
		const forMatching = u.searchParams.get('includeGuids') === '1';
		const rows = world.items
			.filter((i) => i.section === sec[1] && i.type === type)
			.map((i) => ({
				ratingKey: i.ratingKey,
				...(i.viewCount ? { viewCount: i.viewCount } : {}),
				...(i.viewOffset ? { viewOffset: i.viewOffset } : {}),
				...(i.lastViewedAt ? { lastViewedAt: i.lastViewedAt } : {}),
				...(forMatching
					? { Guid: i.Guid, guid: i.guid, Media: i.file ? [{ Part: [{ file: i.file }] }] : [] }
					: {})
			}));
		return json({ MediaContainer: { totalSize: rows.length, Metadata: rows } });
	}
	const meta = u.pathname.match(/^\/library\/metadata\/(.+)$/);
	if (meta) {
		const i = world.items.find((x) => x.ratingKey === decodeURIComponent(meta[1]));
		if (!i) return json({ MediaContainer: { Metadata: [] } });
		return json({
			MediaContainer: {
				Metadata: [
					{
						ratingKey: i.ratingKey,
						...(i.viewCount ? { viewCount: i.viewCount } : {}),
						...(i.viewOffset ? { viewOffset: i.viewOffset } : {}),
						...(i.lastViewedAt ? { lastViewedAt: i.lastViewedAt } : {})
					}
				]
			}
		});
	}
	const item = () => world.items.find((x) => x.ratingKey === u.searchParams.get('key'))!;
	if (u.pathname === '/:/scrobble') {
		const i = item();
		i.viewCount = 1;
		i.viewOffset = 0;
		i.lastViewedAt = nowS();
		return json({});
	}
	if (u.pathname === '/:/unscrobble') {
		const i = item();
		i.viewCount = 0;
		i.viewOffset = 0;
		i.lastViewedAt = null; // unwatch deletes history — the invisible-to-filters case
		return json({});
	}
	if (u.pathname === '/:/progress') {
		const i = item();
		const time = Number(u.searchParams.get('time'));
		if (time >= 60_000) i.viewOffset = time; // PMS floor modeled; lastViewedAt NOT bumped
		return json({});
	}
	return json({}, 404);
});

let uid = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
	uid = (await createUser('owner', 'pw123456')).id;
	addLibrary('Films', 'Movies', 'movies', false);
	addLibrary('Shows', 'Shows', 'series', false);
	addLibrary('Chans', '', 'channels', false);
	writeMovie(env.mediaRoot, 'Movies', 'Heat (1995)', {
		nfo: '<movie><title>Heat</title><year>1995</year><uniqueid type="tmdb">949</uniqueid></movie>'
	});
	writeMovie(env.mediaRoot, 'Movies', 'Ronin (1998)', {
		nfo: '<movie><title>Ronin</title><year>1998</year><uniqueid type="tmdb">8195</uniqueid></movie>'
	});
	writeShow(env.mediaRoot, 'Shows', 'ShowX');
	writeChannelVideo(env.mediaRoot, 'ChanA', 'cv1');
	await scan();
	// The episode id is tvdb-keyed only with an episode NFO — our fixture is path-hashed; give the
	// Plex episode a matching FILE path (tier 3) and the movies Guids (tier 1).
	world.items = [
		{ ratingKey: 'rk-heat', section: '1', type: 1, Guid: [{ id: 'tmdb://949' }], file: '/data/media/Movies/Heat (1995)/Heat (1995).mkv', viewCount: 1, viewOffset: 0, lastViewedAt: nowS() - 3600 },
		{ ratingKey: 'rk-ronin', section: '1', type: 1, Guid: [{ id: 'tmdb://8195' }], file: '/data/media/Movies/Ronin (1998)/Ronin (1998).mkv', viewCount: 0, viewOffset: 0, lastViewedAt: null },
		{ ratingKey: 'rk-ep', section: '2', type: 4, Guid: [], file: '/plexmnt/Shows/ShowX/Season 1/ShowX - S01E01 - Pilot.mkv', viewCount: 0, viewOffset: 500_000, lastViewedAt: nowS() - 60 },
		{ ratingKey: 'rk-cv', section: '1', type: 1, Guid: [], file: '/data/media/ChanA/cv1.mp4', viewCount: 0, viewOffset: 0, lastViewedAt: null },
		{ ratingKey: 'rk-stranger', section: '1', type: 1, Guid: [{ id: 'tmdb://424242' }], file: '/elsewhere/Nope (2022)/Nope.mkv', viewCount: 1, viewOffset: 0, lastViewedAt: nowS() }
	];
});
afterAll(() => env.cleanup());

const epId = () =>
	(db().prepare("SELECT id FROM videos WHERE channel_id = 'series:ShowX'").get() as { id: string }).id;

describe('PIN ceremony + linking', () => {
	it('refuses to start before the owner sets the PMS URL', async () => {
		await expect(link.startPlexLink(uid)).rejects.toThrow(/no-plex-url/);
	});

	it('links via the PIN flow with a per-user client identifier and the SERVER-scoped token', async () => {
		link.setPlexUrl('http://pms.local:32400');
		const p = await link.startPlexLink(uid);
		expect(p.status).toBe('waiting');
		expect(p.code).toBe('WXYZ');
		expect(p.url).toContain('plex.tv/link');
		world.authToken = 'acct-tok'; // the user "entered the code"
		await sleep(400); // server-side poller (100ms under vitest)
		const row = link.getPlexLink(uid);
		expect(row).toMatchObject({
			plex_username: 'plexbob',
			account_token: 'acct-tok',
			server_token: 'srv-tok',
			machine_id: 'machine-1'
		});
		expect(link.pendingLink(uid)).toBeNull();
		expect(world.seenIdentifiers.has(`${serverId()}-u${uid}`)).toBe(true);
	});

	it('manual token paste fails with a friendly error when the account lacks server access', async () => {
		const uid2 = (await createUser('friend', 'pw123456')).id;
		world.resourcesFor = 'some-other-machine';
		await expect(link.finalizeLink(uid2, 'acct-tok')).rejects.toThrow(/no access to this Plex server/);
		world.resourcesFor = 'machine-1';
	});
});

describe('matching', () => {
	it('matches by Guid id first, file-path tail otherwise; strangers stay unmatched', async () => {
		const stats = await sync.rebuildMatches(link.getPlexLink(uid)!);
		expect(stats.matched).toBe(4); // heat (guid), ronin (guid), episode (path), cv1 (path)
		expect(stats.unmatched).toBe(1); // rk-stranger
		const { stateDb } = await import('../src/lib/server/state');
		const rows = stateDb().prepare('SELECT rating_key, video_id, method FROM plex_matches ORDER BY rating_key').all() as {
			rating_key: string;
			video_id: string;
			method: string;
		}[];
		expect(rows.find((r) => r.rating_key === 'rk-heat')).toMatchObject({ video_id: 'tmdb-949', method: 'guid' });
		expect(rows.find((r) => r.rating_key === 'rk-cv')?.method).toMatch(/^path/);
		expect(rows.find((r) => r.rating_key === 'rk-ep')?.video_id).toBe(epId());
	});
});

describe('two-way merge', () => {
	it('initial sync = union: Plex watched imports, MytView watched pushes, offsets newest-win', async () => {
		saveWatch(uid, 'tmdb-8195', { watched: true }); // myt-watched Ronin, Plex unwatched
		const stats = await sync.runPlexSync(uid);
		expect(stats?.errors).toBe(0);
		// Plex-watched Heat imported:
		expect(getWatch(uid, 'tmdb-949').watched).toBe(true);
		// Myt-watched Ronin pushed (stub scrobbled it):
		expect(world.items.find((i) => i.ratingKey === 'rk-ronin')!.viewCount).toBe(1);
		// Plex in-progress episode imported (500s, newer than myt's untouched 0):
		expect(getWatch(uid, epId()).position).toBeCloseTo(500, 0);
	});

	it('steady state: no changes → nothing moves (anti-ping-pong)', async () => {
		const stats = await sync.runPlexSync(uid);
		expect(stats).toMatchObject({ importedToMyt: 0, pushedToPlex: 0, errors: 0 });
	});

	it('a Plex-side unwatch (history wiped) is detected via the full-pull diff and imported', async () => {
		const heat = world.items.find((i) => i.ratingKey === 'rk-heat')!;
		heat.viewCount = 0;
		heat.viewOffset = 0;
		heat.lastViewedAt = null;
		await sync.runPlexSync(uid);
		expect(getWatch(uid, 'tmdb-949').watched).toBe(false);
	});

	it('a MytView resume pushes (≥60s) and the read-back snapshot prevents re-import', async () => {
		await sleep(5); // updated_at is ms-granular — a same-ms write after the prior sync is invisible
		saveWatch(uid, 'tmdb-949', { position: 300 });
		await sync.runPlexSync(uid);
		expect(world.items.find((i) => i.ratingKey === 'rk-heat')!.viewOffset).toBe(300_000);
		// Next cycle: Plex "changed" only by our own push — the read-back snapshot absorbs it.
		const stats = await sync.runPlexSync(uid);
		expect(stats).toMatchObject({ importedToMyt: 0, pushedToPlex: 0 });
		expect(getWatch(uid, 'tmdb-949').position).toBe(300);
	});

	it('positions under the 60s floor are never pushed and never ping-pong', async () => {
		await sleep(5);
		saveWatch(uid, 'cv1', { position: 30 });
		await sync.runPlexSync(uid);
		expect(world.items.find((i) => i.ratingKey === 'rk-cv')!.viewOffset).toBe(0);
		await sync.runPlexSync(uid);
		expect(getWatch(uid, 'cv1').position).toBe(30); // accepted divergence, untouched
	});

	it('both changed → newer side wins', async () => {
		// Plex watched cv1 later than myt's position write above:
		const cv = world.items.find((i) => i.ratingKey === 'rk-cv')!;
		await sleep(5);
		saveWatch(uid, 'cv1', { position: 45 });
		cv.viewCount = 1;
		cv.lastViewedAt = nowS() + 30; // clearly newer than the myt write (tie guard is 2s)
		await sync.runPlexSync(uid);
		expect(getWatch(uid, 'cv1').watched).toBe(true);
	});

	it('Plex unreachable → error recorded, nothing changes', async () => {
		world.down = true;
		const stats = await sync.runPlexSync(uid);
		world.down = false;
		expect(stats?.errors).toBe(1);
		expect(link.getPlexLink(uid)!.last_error).toMatch(/unreachable/);
		expect(getWatch(uid, 'cv1').watched).toBe(true); // untouched
	});

	it('cadence setting clamps like the federation one', () => {
		expect(sync.plexSyncMinutes()).toBe(5);
		sync.setPlexSyncMinutes(2);
		expect(sync.plexSyncMinutes()).toBe(5);
		sync.setPlexSyncMinutes(0);
		expect(sync.plexSyncMinutes()).toBe(0);
		sync.setPlexSyncMinutes(15);
		expect(sync.plexSyncMinutes()).toBe(15);
	});
});
