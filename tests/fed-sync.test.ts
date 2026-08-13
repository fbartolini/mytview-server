/**
 * The two-server federation recipe (increments 3): PHASE 1 boots a SHARER on one tempEnv — real
 * fixtures, real scan, real /api/fed handlers — and captures their JSON. PHASE 2 rewrites the env
 * (vi.resetModules — the config-clamps recipe) into a fresh CONSUMER server whose fedclient
 * transport replays the captured payloads (setFedFetch), then drives runFedSync end-to-end:
 * mirroring, merged movies (virtual AND real local library), change-skip, scan-coexistence,
 * per-link prune, network-error = no prune, sanitization, unmap/unlink teardown + watch-state
 * survival. Design: docs/federation-design.md.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'node:path';
import { tempEnv, writeChannelVideo, writeShow, writeMovie } from './helpers';

// ---------------------------------------------------------------------------------------------
// PHASE 1 — the sharer: fixtures, scan, grants, captured fed responses.
// ---------------------------------------------------------------------------------------------
const env1 = tempEnv();

interface Captured {
	serverId: string;
	catalog: { serverId: string; libraries: unknown[]; channels: unknown[] };
	videosByChannel: Record<string, unknown>;
	secret: string;
}

const captured: Captured = await (async () => {
	const { scan } = await import('../src/lib/server/indexer');
	const { addLibrary, listLibraries } = await import('../src/lib/server/libraries');
	const fed = await import('../src/lib/server/federation');
	const catalogRoute = await import('../src/routes/api/fed/catalog/+server');
	const videosRoute = await import('../src/routes/api/fed/videos/+server');

	addLibrary('Videos', '', 'channels', false);
	addLibrary('Shows', 'Shows', 'series', false);
	addLibrary('Films', 'Movies', 'movies', false);
	writeChannelVideo(env1.mediaRoot, 'ChanA', 'a1', { tags: ['newsy'], timestamp: 1700000100 });
	writeChannelVideo(env1.mediaRoot, 'ChanA', 'a2', { timestamp: 1700000200 });
	writeChannelVideo(env1.mediaRoot, 'ChanB', 'b1'); // never granted — must never surface
	writeShow(env1.mediaRoot, 'Shows', 'ShowX', ['Drama']);
	writeMovie(env1.mediaRoot, 'Movies', 'Heat (1995)', {
		nfo: '<movie><title>Heat</title><year>1995</year><genre>Crime</genre><uniqueid type="tmdb">949</uniqueid></movie>',
		poster: true,
		fanart: true
	});
	await scan();

	const filmsId = listLibraries().find((l) => l.name === 'Films')!.id;
	const moviesChanId = `movies:${filmsId}`;
	const { id: linkId, secret } = fed.createSharerLink('will-be-replaced', 'Consumer Bob', null);
	fed.setLinkGrants(linkId, ['ChanA', 'series:ShowX', moviesChanId]);

	const call = async (mod: { GET: (e: never) => Response | Promise<Response> }, urlStr: string) => {
		const res = await mod.GET({
			url: new URL(urlStr),
			request: new Request(urlStr, { headers: { authorization: `Bearer ${secret}` } }),
			getClientAddress: () => '198.51.100.1'
		} as never);
		expect(res.status).toBe(200);
		return res.json();
	};
	const catalog = (await call(catalogRoute, 'http://s/api/fed/catalog')) as Captured['catalog'];
	const videosByChannel: Record<string, unknown> = {};
	for (const c of catalog.channels as { id: string }[]) {
		videosByChannel[c.id] = await call(
			videosRoute,
			`http://s/api/fed/videos?channel=${encodeURIComponent(c.id)}`
		);
	}
	return { serverId: fed.serverId(), catalog, videosByChannel, secret };
})();

// ---------------------------------------------------------------------------------------------
// PHASE 2 — the consumer: fresh env + module graph; transport replays the captured payloads.
// ---------------------------------------------------------------------------------------------
const env2 = tempEnv();
vi.resetModules();

const { scan } = await import('../src/lib/server/indexer');
const { db } = await import('../src/lib/server/db');
const { stateDb } = await import('../src/lib/server/state');
const { addLibrary, addVirtualLibrary, listLibraries } = await import('../src/lib/server/libraries');
const fed = await import('../src/lib/server/federation');
const { setFedFetch } = await import('../src/lib/server/fedclient');
const { runFedSync, purgeLinkRows } = await import('../src/lib/server/fedsync');
const { listChannels, listVideos, getChannel, visibleLibraryIds } = await import('../src/lib/server/queries');
const { saveWatch } = await import('../src/lib/server/watch');
const { createUser } = await import('../src/lib/server/auth');

afterAll(() => {
	env1.cleanup();
	env2.cleanup();
});

// The replayable transport. `holder` is mutable so tests can drop channels / inject hostiles /
// simulate outages without re-capturing.
const holder = {
	catalog: structuredClone(captured.catalog),
	videos: structuredClone(captured.videosByChannel),
	networkDown: false,
	videoFetches: 0,
	throttle: new Set<string>() // channel ids whose /videos returns 429 (every attempt)
};
setFedFetch(async (input: RequestInfo | URL) => {
	if (holder.networkDown) throw new TypeError('fetch failed');
	const u = String(input);
	const json = (x: unknown, status = 200) =>
		new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
	if (u.includes('/api/fed/catalog')) return json(holder.catalog);
	if (u.includes('/api/fed/videos?channel=')) {
		holder.videoFetches++;
		const cid = decodeURIComponent(u.split('channel=')[1]);
		if (holder.throttle.has(cid)) return json({ error: 'rate limited' }, 429);
		const payload = holder.videos[cid];
		return payload ? json(payload) : json({ error: 'not_shared' }, 404);
	}
	return json({ error: 'nope' }, 404);
});

const uid = (await createUser('owner', 'pw123456')).id;
const PREFIX = captured.serverId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);

// Consumer link + mappings: channels + series + movies each into a VIRTUAL initially.
const linkId = fed.createConsumerLink(captured.serverId, 'Alice', 'https://sharer.example', captured.secret);
const remoteLibs = captured.catalog.libraries as { id: number; name: string; format: string }[];
const virtualIds = new Map<string, number>();
for (const rl of remoteLibs) {
	const pid = addVirtualLibrary(rl.name, rl.format as 'channels' | 'series' | 'movies');
	virtualIds.set(rl.format, pid);
	fed.setLibraryMap(linkId, rl.id, pid, rl.name, rl.format as 'channels' | 'series' | 'movies');
}
const link = fed.getLink(linkId)!;

describe('mirror + merged browsing', () => {
	it('first sync mirrors granted content into namespaced, peer-marked rows', async () => {
		const stats = await runFedSync(linkId);
		expect(stats).toMatchObject({ links: 1, errors: 0 });
		const chanIds = (db().prepare('SELECT id FROM channels WHERE peer_id IS NOT NULL ORDER BY id').all() as {
			id: string;
		}[]).map((r) => r.id);
		expect(chanIds).toEqual([
			`fed:${PREFIX}:ChanA`,
			`fed:${PREFIX}:series:ShowX`,
			`movies:${virtualIds.get('movies')}`
		]);
		// Ungranted ChanB never crossed the wire.
		expect(JSON.stringify(chanIds)).not.toContain('ChanB');
	});

	it('mirrored content flows into the normal reads: grid, feed, tag, nav', () => {
		const grid = listChannels({ id: uid });
		expect(grid.find((c) => c.id === `fed:${PREFIX}:ChanA`)).toMatchObject({ video_count: 2, unwatched: 2 });
		const feed = listVideos({ userId: uid });
		expect(feed.some((v) => v.id === `fed:${PREFIX}:a1`)).toBe(true);
		const tagged = listVideos({ userId: uid, tag: 'newsy' });
		expect(tagged.map((v) => v.id)).toEqual([`fed:${PREFIX}:a1`]);
		expect(visibleLibraryIds({ id: uid }).has(virtualIds.get('channels')!)).toBe(true);
	});

	it('movies merge into the VIRTUAL library: peer-marked movies:<L> channel, wall with genres', () => {
		const wallId = `movies:${virtualIds.get('movies')}`;
		const ch = db().prepare('SELECT peer_id, kind, library_id FROM channels WHERE id = ?').get(wallId);
		expect(ch).toMatchObject({ peer_id: PREFIX, kind: 'movies', library_id: virtualIds.get('movies') });
		const wall = getChannel(wallId, uid, true)!;
		expect(wall.videos).toHaveLength(1);
		expect(wall.videos[0].id).toBe(`fed:${PREFIX}:tmdb-949`);
		expect(wall.videos[0].genres).toContain('Crime');
	});

	it('sentinel paths preserve the extension for compat predicates, never resolve locally', () => {
		const v = db()
			.prepare('SELECT video_path, info_path FROM videos WHERE id = ?')
			.get(`fed:${PREFIX}:tmdb-949`) as { video_path: string; info_path: string };
		expect(v.video_path.startsWith('fed:')).toBe(true);
		expect(path.extname(v.video_path)).toBe('.mkv');
		expect(v.info_path).toBe('fed:');
	});

	it('change-skip: an unchanged catalog re-sync fetches no videos', async () => {
		holder.videoFetches = 0;
		await runFedSync(linkId);
		expect(holder.videoFetches).toBe(0);
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(4);
	});

	it('a local scan leaves every mirrored row alone', async () => {
		writeChannelVideo(env2.mediaRoot, 'LocalChan', 'local1');
		addLibrary('Local', '', 'channels', false);
		await scan();
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(4);
		expect(listVideos({ userId: uid }).some((v) => v.id === 'local1')).toBe(true); // both worlds in one feed
	});
});

describe('remapping movies into a REAL local library', () => {
	it('unmap purges only the movies mapping; remap merges fed movies into the scan-owned wall', async () => {
		const virtualMovies = virtualIds.get('movies')!;
		const remoteMovies = remoteLibs.find((l) => l.format === 'movies')!;
		purgeLinkRows(link.peer_prefix, virtualMovies);
		fed.deleteLibraryMap(linkId, remoteMovies.id);
		expect(db().prepare('SELECT COUNT(*) AS c FROM channels WHERE id = ?').get(`movies:${virtualMovies}`)).toEqual({ c: 0 });
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(3); // channels+series intact

		// A real local movies library with its own film…
		writeMovie(env2.mediaRoot, 'MyMovies', 'Ronin (1998)', {
			nfo: '<movie><title>Ronin</title><year>1998</year><uniqueid type="tmdb">8195</uniqueid></movie>'
		});
		addLibrary('My Films', 'MyMovies', 'movies', false);
		await scan();
		const localLib = listLibraries().find((l) => l.name === 'My Films')!;
		// …receives the federated movies via the mapping:
		fed.setLibraryMap(linkId, remoteMovies.id, localLib.id, remoteMovies.name, 'movies');
		await runFedSync(linkId);
		const wallId = `movies:${localLib.id}`;
		// The channel stays SCAN-owned (peer_id NULL) — the sync only ever INSERT-OR-IGNOREs it.
		expect(db().prepare('SELECT peer_id, video_count FROM channels WHERE id = ?').get(wallId)).toMatchObject({
			peer_id: null,
			video_count: 2
		});
		const ids = getChannel(wallId, uid, true)!.videos.map((v) => v.id).sort();
		expect(ids).toEqual([`fed:${PREFIX}:tmdb-949`, 'tmdb-8195']);
	});

	it('a local scan keeps the merged wall intact and its count correct', async () => {
		await scan();
		const localLib = listLibraries().find((l) => l.name === 'My Films')!;
		expect(db().prepare('SELECT video_count FROM channels WHERE id = ?').get(`movies:${localLib.id}`)).toEqual({
			video_count: 2
		});
	});
});

describe('prune, outage, sanitization', () => {
	it('a channel dropped from the catalog prunes exactly its rows on the next clean sync', async () => {
		holder.catalog.channels = (holder.catalog.channels as { id: string }[]).filter((c) => c.id !== 'ChanA');
		await runFedSync(linkId);
		expect(db().prepare("SELECT COUNT(*) AS c FROM videos WHERE id LIKE 'fed:%:a%'").get()).toEqual({ c: 0 });
		expect(db().prepare('SELECT COUNT(*) AS c FROM channels WHERE id = ?').get(`fed:${PREFIX}:ChanA`)).toEqual({ c: 0 });
		// The others survive.
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(2);
	});

	it('peer unreachable → error recorded, NOTHING pruned', async () => {
		holder.networkDown = true;
		await runFedSync(linkId);
		holder.networkDown = false;
		expect(fed.getLink(linkId)!.last_sync_error).toMatch(/unreachable/);
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(2);
	});

	it('a peer identity change aborts without pruning', async () => {
		const real = holder.catalog.serverId;
		holder.catalog.serverId = 'someone-else';
		await runFedSync(linkId);
		holder.catalog.serverId = real;
		expect(fed.getLink(linkId)!.last_sync_error).toMatch(/identity/);
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(2);
	});

	it('a throttled (429) channel keeps its mirror, reports a partial sync, and is never pruned', async () => {
		const showChan = (holder.catalog.channels as { id: string; video_count: number }[]).find(
			(c) => c.id === 'series:ShowX'
		)!;
		showChan.video_count += 1; // defeat the fingerprint so a fetch is attempted
		holder.throttle.add('series:ShowX');
		const before = (db()
			.prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL')
			.get() as { c: number }).c;
		await runFedSync(linkId);
		holder.throttle.delete('series:ShowX');
		expect(fed.getLink(linkId)!.last_sync_error).toMatch(/partial sync/);
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(before);
		// The next clean sync recovers and clears the partial-sync flag.
		await runFedSync(linkId);
		expect(fed.getLink(linkId)!.last_sync_error).toBeNull();
	});

	it('hostile catalog rows are dropped, sane ones survive', async () => {
		(holder.catalog.channels as unknown[]).push({ id: 42, name: null }); // mistyped
		const showChan = (holder.catalog.channels as { id: string; video_count: number }[]).find(
			(c) => c.id === 'series:ShowX'
		)!;
		const showVideos = holder.videos['series:ShowX'] as { items: Record<string, unknown>[] };
		showVideos.items.push({ id: 'evil', title: '' }); // empty title → dropped
		showVideos.items.push({ ...showVideos.items[0], id: 'huge', title: 'x'.repeat(9000) }); // capped, kept
		showChan.video_count += 2; // defeat change-skip so the fetch happens
		await runFedSync(linkId);
		expect(fed.getLink(linkId)!.last_sync_error).toBeNull();
		const titles = db()
			.prepare('SELECT id, title FROM videos WHERE peer_id IS NOT NULL AND channel_id = ?')
			.all(`fed:${PREFIX}:series:ShowX`) as { id: string; title: string }[];
		expect(titles.some((t) => t.id === `fed:${PREFIX}:evil`)).toBe(false);
		const huge = titles.find((t) => t.id === `fed:${PREFIX}:huge`);
		expect(huge).toBeDefined();
		expect(huge!.title.length).toBe(512);
	});
});

describe('teardown + watch-state survival', () => {
	it('unlink purges every mirrored row but keeps watch state; re-pair revives identical ids', async () => {
		const watchedId = `fed:${PREFIX}:s01e01-ShowX`; // whatever the episode id is — read it instead:
		const anyFed = db().prepare('SELECT id FROM videos WHERE peer_id IS NOT NULL LIMIT 1').get() as { id: string };
		saveWatch(uid, anyFed.id, { position: 61 });
		void watchedId;

		purgeLinkRows(link.peer_prefix);
		fed.deleteLink(linkId);
		expect((db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(0);
		expect((db().prepare('SELECT COUNT(*) AS c FROM channels WHERE peer_id IS NOT NULL').get() as { c: number }).c).toBe(0);
		const kept = stateDb()
			.prepare('SELECT position FROM watch_state WHERE user_id = ? AND video_id = ?')
			.get(uid, anyFed.id) as { position: number };
		expect(kept.position).toBe(61);

		// Re-pair the same peer server: identical prefix → identical ids → resume survives.
		const relinked = fed.createConsumerLink(captured.serverId, 'Alice again', 'https://sharer.example', 'new-secret');
		for (const rl of remoteLibs.filter((l) => l.format !== 'movies')) {
			const target = listLibraries().find((x) => x.name === rl.name && x.virtual)!;
			fed.setLibraryMap(relinked, rl.id, target.id, rl.name, rl.format as 'channels' | 'series');
		}
		await runFedSync(relinked);
		const back = db().prepare('SELECT id FROM videos WHERE id = ?').get(anyFed.id);
		expect(back).toBeDefined();
	});
});

describe('dedupe: local content wins (design §7)', () => {
	it('a same-id series merges into the local twin — one tile, no fed channel row', async () => {
		const link = fed.listLinks('consumer')[0];
		// A LOCAL twin of the remote show: same folder name → same `series:ShowX` channel id.
		writeShow(env2.mediaRoot, 'ShowsLocal', 'ShowX', ['Drama']);
		addLibrary('Shows Local', 'ShowsLocal', 'series', false);
		await scan();
		const remoteShows = remoteLibs.find((l) => l.format === 'series')!;
		const target = listLibraries().find((l) => l.name === 'Shows Local')!;
		fed.setLibraryMap(link.id, remoteShows.id, target.id, remoteShows.name, 'series');
		await runFedSync(link.id);
		// No duplicate tile: the namespaced fed channel never exists; fed episodes hang off the
		// LOCAL channel (the old virtual-lib mirror of the show was pruned by the same sync).
		expect(db().prepare('SELECT COUNT(*) AS c FROM channels WHERE id = ?').get(`fed:${PREFIX}:series:ShowX`)).toEqual({ c: 0 });
		const fedEps = db()
			.prepare("SELECT id FROM videos WHERE peer_id IS NOT NULL AND channel_id = 'series:ShowX'")
			.all() as { id: string }[];
		// pathId-fallback episode ids differ across servers (relpath-hashed) → the episode itself is
		// mirrored alongside the local one — the documented NFO-less limit; NFO/tvdb ids dedupe fully.
		expect(fedEps.length).toBeGreaterThan(0);
	});

	it('a same-content-id movie is skipped entirely — the local copy wins', async () => {
		const link = fed.listLinks('consumer')[0];
		writeMovie(env2.mediaRoot, 'MyMovies', 'Heat (1995)', {
			nfo: '<movie><title>Heat</title><year>1995</year><uniqueid type="tmdb">949</uniqueid></movie>'
		});
		await scan(); // local Heat (tmdb-949) joins My Films
		const remoteMovies = remoteLibs.find((l) => l.format === 'movies')!;
		const myFilms = listLibraries().find((l) => l.name === 'My Films')!;
		fed.setLibraryMap(link.id, remoteMovies.id, myFilms.id, remoteMovies.name, 'movies');
		await runFedSync(link.id);
		const wall = getChannel(`movies:${myFilms.id}`, uid, true)!;
		const heats = wall.videos.filter((v) => v.id.includes('tmdb-949'));
		expect(heats).toHaveLength(1);
		expect(heats[0].id).toBe('tmdb-949'); // the LOCAL row — the remote copy was never mirrored
	});
});
