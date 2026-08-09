/**
 * Owner-defined library ordering: the `sort_order` column migration against a PRE-EXISTING old-shape
 * state.db (boot must add the column and backfill id-order without crashing — the house migration
 * rule), the one-order-everywhere reads (listLibraries + resolveLibraries), append-on-add, and the
 * /admin/libraries ↑↓ move semantics including edge no-ops.
 */
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { tempEnv } from './helpers';

const env = tempEnv();

// Seed an OLD-shape state.db (no sort_order) BEFORE any server module opens it: the boot migration
// must upgrade it in place. Insert order (ids 1..3) deliberately disagrees with name order — the
// backfill keeps id order, proving the old ORDER BY name is gone and nothing was re-sorted.
{
	const d = new Database(path.join(env.dataDir, 'state.db'));
	d.exec(`CREATE TABLE libraries (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		name        TEXT NOT NULL,
		path        TEXT NOT NULL UNIQUE,
		format      TEXT NOT NULL,
		new_private INTEGER NOT NULL DEFAULT 0,
		show_in_recent INTEGER NOT NULL DEFAULT 1,
		created_at  INTEGER NOT NULL
	);`);
	const ins = d.prepare(
		"INSERT INTO libraries (name, path, format, created_at) VALUES (?, ?, 'channels', 0)"
	);
	ins.run('Zeta', 'z');
	ins.run('Alpha', 'a');
	ins.run('Mid', 'm');
	d.close();
}

const { listLibraries, addLibrary, moveLibrary, resolveLibraries } = await import(
	'../src/lib/server/libraries'
);

const names = () => listLibraries().map((l) => l.name);

describe('library ordering', () => {
	afterAll(() => env.cleanup());

	it('migrates an old db and keeps id order (not name order)', () => {
		expect(names()).toEqual(['Zeta', 'Alpha', 'Mid']);
		expect(resolveLibraries().map((l) => l.name)).toEqual(['Zeta', 'Alpha', 'Mid']);
	});

	it('appends new libraries at the end', () => {
		addLibrary('Beta', 'b', 'movies', false);
		expect(names()).toEqual(['Zeta', 'Alpha', 'Mid', 'Beta']);
	});

	it('moves one step and both reads agree', () => {
		const beta = listLibraries().find((l) => l.name === 'Beta')!;
		moveLibrary(beta.id, 'up');
		expect(names()).toEqual(['Zeta', 'Alpha', 'Beta', 'Mid']);
		moveLibrary(beta.id, 'up');
		expect(names()).toEqual(['Zeta', 'Beta', 'Alpha', 'Mid']);
		expect(resolveLibraries().map((l) => l.name)).toEqual(['Zeta', 'Beta', 'Alpha', 'Mid']);
	});

	it('edge moves are no-ops', () => {
		const first = listLibraries()[0];
		const last = listLibraries().at(-1)!;
		moveLibrary(first.id, 'up');
		moveLibrary(last.id, 'down');
		moveLibrary(9999, 'up'); // unknown id
		expect(names()).toEqual(['Zeta', 'Beta', 'Alpha', 'Mid']);
	});
});
