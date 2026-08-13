/**
 * Federation foundation (increment 1): the libraries.path nullable REBUILD migration against a
 * pre-existing db (the hard migration rule), virtual libraries, the peer_id scan-safety filters
 * (a local scan must never prune mirrored rows), server identity, invites, links, grants, and
 * mapping format checks. Design: docs/federation-design.md.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();

// Pre-create state.db with the PRE-FEDERATION libraries DDL (path NOT NULL) + a seeded row, so the
// import below exercises relaxLibrariesPathNotNull against a genuinely old database.
const statePath = path.join(path.dirname(process.env.DB_PATH!), 'state.db');
{
	const d = new Database(statePath);
	d.exec(`CREATE TABLE libraries (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		name        TEXT NOT NULL,
		path        TEXT NOT NULL UNIQUE,
		format      TEXT NOT NULL,
		new_private INTEGER NOT NULL DEFAULT 0,
		show_in_recent INTEGER NOT NULL DEFAULT 1,
		sort_order  INTEGER,
		created_at  INTEGER NOT NULL
	)`);
	d.prepare(
		"INSERT INTO libraries (id, name, path, format, new_private, show_in_recent, sort_order, created_at) VALUES (7, 'Old', 'OldFolder', 'series', 1, 0, 3, 123)"
	).run();
	d.close();
	// The seeded library's folder must exist — the walkers readdir a resolved library root directly.
	mkdirSync(path.join(env.mediaRoot, 'OldFolder'), { recursive: true });
}

const { stateDb } = await import('../src/lib/server/state');
const { db } = await import('../src/lib/server/db');
const { scan } = await import('../src/lib/server/indexer');
const {
	addLibrary,
	addVirtualLibrary,
	listLibraries,
	resolveLibraries,
	updateLibrary,
	getLibrary
} = await import('../src/lib/server/libraries');
const fed = await import('../src/lib/server/federation');
const { fedSyncMinutes, setFedSyncMinutes } = await import('../src/lib/server/fedsync');
const { createUser } = await import('../src/lib/server/auth');
const uid = (await createUser('owner', 'pw123456')).id;

afterAll(() => env.cleanup());

describe('libraries.path nullable rebuild migration', () => {
	it('relaxes NOT NULL on a pre-existing db, preserving rows and ids', () => {
		const cols = stateDb().prepare('PRAGMA table_info(libraries)').all() as {
			name: string;
			notnull: number;
		}[];
		expect(cols.find((c) => c.name === 'path')!.notnull).toBe(0);
		const old = getLibrary(7)!;
		expect(old).toMatchObject({ name: 'Old', path: 'OldFolder', format: 'series', newPrivate: true, showInRecent: false });
	});

	it('allows multiple NULL paths (SQLite UNIQUE ignores NULLs)', () => {
		const a = addVirtualLibrary('Ghost A', 'movies');
		const b = addVirtualLibrary('Ghost B', 'series');
		expect(a).not.toBe(b);
		const virtuals = listLibraries().filter((l) => l.virtual);
		expect(virtuals.map((l) => l.name).sort()).toEqual(['Ghost A', 'Ghost B']);
	});
});

describe('virtual libraries', () => {
	it('are listed but never resolved for walking, and keep format locked', () => {
		const id = listLibraries().find((l) => l.name === 'Ghost A')!.id;
		expect(resolveLibraries().some((l) => l.id === id)).toBe(false);
		// updateLibrary on a virtual edits presentation only — path stays NULL, format stays inherited.
		updateLibrary(id, 'Ghost A2', 'ShouldBeIgnored', 'channels', true, false);
		const after = getLibrary(id)!;
		expect(after).toMatchObject({ name: 'Ghost A2', path: null, format: 'movies', virtual: true });
	});

	it('locks the format of any mapping target', () => {
		const lib = addVirtualLibrary('Target', 'movies');
		// A real (non-virtual) library that is a mapping target also locks:
		addLibrary('RealMovies', 'RealMovies', 'movies', false);
		const real = listLibraries().find((l) => l.name === 'RealMovies')!;
		const { id: linkId } = fed.createSharerLink('peer-x', 'X', null); // any link row satisfies the FK
		fed.setLibraryMap(linkId, 1, real.id, 'Their Films', 'movies');
		expect(() => updateLibrary(real.id, 'RealMovies', 'RealMovies', 'series', false)).toThrow(/format-locked/);
		void lib;
	});
});

describe('scan safety around mirrored rows', () => {
	const PREFIX = 'abc123def456';
	beforeAll(async () => {
		addLibrary('Chans', '', 'channels', false);
		writeChannelVideo(env.mediaRoot, 'LocalChan', 'lv1');
		writeChannelVideo(env.mediaRoot, 'LocalChan', 'lv2');
		await scan();
		db().prepare(
			"INSERT INTO channels (id, name, kind, peer_id, video_count) VALUES (?, 'Peer Chan', 'channel', ?, 1)"
		).run(`fed:${PREFIX}:remoteChan`, PREFIX);
		db().prepare(
			'INSERT INTO videos (id, channel_id, title, video_path, thumb_path, info_path, mtime, peer_id) ' +
				"VALUES (?, ?, 'Peer Video', 'fed:rv1.mkv', 'fed:thumb', 'fed:', 0, ?)"
		).run(`fed:${PREFIX}:rv1`, `fed:${PREFIX}:remoteChan`, PREFIX);
	});

	it('a local scan neither prunes mirrored rows nor trips the safety valve on them', async () => {
		const stats = await scan();
		expect(stats?.pruneSkipped).toBeUndefined();
		expect(db().prepare('SELECT COUNT(*) AS c FROM videos WHERE peer_id IS NOT NULL').get()).toEqual({ c: 1 });
		expect(db().prepare('SELECT COUNT(*) AS c FROM channels WHERE peer_id IS NOT NULL').get()).toEqual({ c: 1 });
	});

	it('still prunes LOCAL dead rows alongside surviving fed rows', async () => {
		rmSync(path.join(env.mediaRoot, 'LocalChan', 'lv2.info.json'));
		rmSync(path.join(env.mediaRoot, 'LocalChan', 'lv2.mp4'));
		const stats = await scan();
		expect(stats?.pruned).toBe(1);
		const ids = (db().prepare('SELECT id FROM videos ORDER BY id').all() as { id: string }[]).map((r) => r.id);
		expect(ids).toEqual([`fed:${PREFIX}:rv1`, 'lv1']);
	});

	it('skips a reserved-name local directory (fed:*) instead of indexing it as a channel', async () => {
		writeChannelVideo(env.mediaRoot, 'fed:evil', 'ev1');
		await scan();
		expect(db().prepare("SELECT COUNT(*) AS c FROM channels WHERE id = 'fed:evil'").get()).toEqual({ c: 0 });
	});
});

describe('identity, invites, links, grants, maps', () => {
	it('serverId is minted once and stable', () => {
		const a = fed.serverId();
		expect(a).toMatch(/^[0-9a-f-]{36}$/);
		expect(fed.serverId()).toBe(a);
	});

	it('prefixFor yields 12 hex chars; fed id codec round-trips', () => {
		const p = fed.prefixFor('11112222-3333-4444-5555-666677778888');
		expect(p).toBe('111122223333');
		expect(fed.fedIdParts(fed.fedId(p, 'abc:def'))).toEqual({ prefix: p, remoteId: 'abc:def' });
		expect(fed.fedIdParts('not-fed')).toBeNull();
		expect(fed.isFedId('fed:x:y')).toBe(true);
	});

	it('invite paste-string round-trips and rejects garbage', () => {
		const tok = fed.createFedInvite(uid, 'https://sharer.example/');
		const paste = fed.encodeInvite('https://sharer.example/', tok);
		expect(fed.decodeInvite(paste)).toEqual({ baseUrl: 'https://sharer.example', token: tok });
		expect(fed.decodeInvite('mytview-fed:1:!!!')).toBeNull();
		expect(fed.decodeInvite('mytview-fed:2:aaaa')).toBeNull();
		expect(fed.decodeInvite('random text')).toBeNull();
	});

	it('invites are single-use and expiring', () => {
		const tok = fed.createFedInvite(uid, 'https://sharer.example');
		expect(fed.consumeFedInvite(tok, 'server-b')).toMatchObject({ base_url: 'https://sharer.example' });
		expect(fed.consumeFedInvite(tok, 'server-c')).toBeNull(); // single-use
		const tok2 = fed.createFedInvite(uid, 'https://sharer.example');
		expect(fed.consumeFedInvite(tok2, 'server-b', Date.now() + 25 * 3600 * 1000)).toBeNull(); // expired
	});

	it('linkBySecret resolves only the exact sharer secret', () => {
		const { secret } = fed.createSharerLink('peer-y', 'Y', 'https://y.example');
		expect(fed.linkBySecret(secret)?.peer_server_id).toBe('peer-y');
		expect(fed.linkBySecret(secret.slice(0, -1) + '!')).toBeNull();
		expect(fed.linkBySecret('')).toBeNull();
	});

	it('grants replace-set; mapping enforces format compatibility', () => {
		const { id } = fed.createSharerLink('peer-z', 'Z', null);
		fed.setLinkGrants(id, ['c1', 'c2']);
		expect([...fed.grantedChannelIds(id)].sort()).toEqual(['c1', 'c2']);
		fed.setLinkGrants(id, ['c3']);
		expect([...fed.grantedChannelIds(id)]).toEqual(['c3']);
		const ghost = addVirtualLibrary('Ghost C', 'series');
		expect(() => fed.setLibraryMap(id, 9, ghost, 'Their Films', 'movies')).toThrow(/format-mismatch/);
		expect(() => fed.setLibraryMap(id, 9, 99999, 'X', 'movies')).toThrow(/no-such-library/);
		fed.setLibraryMap(id, 9, ghost, 'Their Shows', 'series'); // compatible — ok
		expect(fed.listLibraryMaps(id)).toHaveLength(1);
	});

	it('the sync-cadence SETTING clamps to its floor and honors 0 = manual', () => {
		expect(fedSyncMinutes()).toBe(30); // default
		setFedSyncMinutes(2); // 1–4 clamp to 5 (never hammer someone else's server)
		expect(fedSyncMinutes()).toBe(5);
		setFedSyncMinutes(0);
		expect(fedSyncMinutes()).toBe(0);
		setFedSyncMinutes(45);
		expect(fedSyncMinutes()).toBe(45);
	});
});
