/**
 * Library configuration + resolution.
 *
 * A "library" is a typed root the indexer walks: a subfolder of MEDIA_ROOT with a `format`
 * (channels | series | movies) and a default visibility for newly-seen items (`newPrivate`). Libraries are
 * OWNER-CONFIGURED in the UI (`/admin/libraries`) and stored in `state.db`, so a single `/media`
 * mount serves any number of libraries pointing at arbitrary subfolders — the media-server model,
 * not a per-volume/env convention.
 *
 * EXPLICIT-ONLY (the zero-config implicit default was REMOVED 2026-08-09): with NO libraries defined,
 * nothing is indexed — the first-run empty state walks the owner to /admin/libraries instead. The old
 * implicit whole-MEDIA_ROOT-as-one-channels-library behavior confused mixed-content mounts (movies
 * silently skipped while channels appeared) and its one-form-submit equivalent still exists: add a
 * library with an empty folder ("(media root)") + channels format. A legacy deploy upgrading without
 * config is caught by the scan's prune safety valve (populated index, zero seen → prune skipped), so
 * its stale index stays browsable until the owner configures. Every path stays relative to
 * MEDIA_ROOT, so the traversal guard in files.ts is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_ROOT } from './config';
import { stateDb } from './state';

export type LibraryFormat = 'channels' | 'series' | 'movies';

/** A resolved library the indexer walks. */
export interface Library {
	id: number; // the libraries-table row id (explicit-only — the implicit no-row default is gone)
	name: string;
	format: LibraryFormat;
	root: string; // absolute directory the indexer walks
	prefix: string; // `root` relative to MEDIA_ROOT ('' = MEDIA_ROOT itself)
	newPrivate: boolean; // newly-seen channels/shows here default to private
}

interface LibraryRow {
	id: number;
	name: string;
	/** MEDIA_ROOT-relative subfolder; '' = the root itself; NULL = VIRTUAL (a federation mapping
	 *  target with no local folder — never walked; see docs/federation-design.md). */
	path: string | null;
	format: string;
	new_private: number;
	show_in_recent: number;
}

const asFormat = (f: string): LibraryFormat =>
	f === 'series' || f === 'movies' ? f : 'channels';

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Absolute root for a MEDIA_ROOT-relative library path, or null if it escapes MEDIA_ROOT. */
function rootFor(relPath: string): string | null {
	const abs = path.resolve(MEDIA_ROOT, relPath);
	if (abs !== MEDIA_ROOT && !abs.startsWith(MEDIA_ROOT + path.sep)) return null;
	return abs;
}

/** The active libraries (empty table → NOTHING is indexed; see the header). Called each scan. */
export function resolveLibraries(): Library[] {
	const rows = stateDb()
		.prepare('SELECT id, name, path, format, new_private FROM libraries ORDER BY COALESCE(sort_order, id), id')
		.all() as LibraryRow[];
	const libs: Library[] = [];
	for (const r of rows) {
		if (r.path == null) continue; // virtual (federation mapping target) — nothing local to walk
		const root = rootFor(r.path);
		if (!root) continue; // path escaped MEDIA_ROOT (validated on add, but defence in depth)
		libs.push({
			id: r.id,
			name: r.name,
			format: asFormat(r.format),
			root,
			prefix: path.relative(MEDIA_ROOT, root),
			newPrivate: !!r.new_private
		});
	}
	return libs;
}

// --- CRUD + validation (owner-only; called by /admin/libraries) --------------------------------

export interface LibraryConfig {
	id: number;
	name: string;
	/** NULL = virtual (federation mapping target, no local folder). */
	path: string | null;
	format: LibraryFormat;
	newPrivate: boolean;
	/** false = this library's items stay OUT of the Recent feed (a browse-deliberately collection).
	 *  Feed-only — search, tag/genre browsing, and the library page itself are untouched. */
	showInRecent: boolean;
	/** True for a federation virtual: exists purely to receive mapped peer content. Path/format are
	 *  not owner-editable (format is inherited from the federated source). */
	virtual: boolean;
}

const toConfig = (r: LibraryRow): LibraryConfig => ({
	id: r.id,
	name: r.name,
	path: r.path,
	format: asFormat(r.format),
	newPrivate: !!r.new_private,
	showInRecent: !!r.show_in_recent,
	virtual: r.path == null
});

export function listLibraries(): LibraryConfig[] {
	// Owner-defined order (sort_order, managed at /admin/libraries) — the ONE ordering every surface
	// inherits: web nav tabs, /api/v1/libraries (TV tab promotion, pickers), the admin list itself.
	return (
		stateDb()
			.prepare(
				'SELECT id, name, path, format, new_private, show_in_recent FROM libraries ORDER BY COALESCE(sort_order, id), id'
			)
			.all() as LibraryRow[]
	).map(toConfig);
}

/** Move a library one step up/down in the owner-defined order. Renumbers the whole (tiny) list so
 *  the sequence self-heals even if sort_order values ever collide. Out-of-range moves are no-ops. */
export function moveLibrary(id: number, dir: 'up' | 'down'): void {
	const d = stateDb();
	d.transaction(() => {
		const ids = (
			d.prepare('SELECT id FROM libraries ORDER BY COALESCE(sort_order, id), id').all() as { id: number }[]
		).map((r) => r.id);
		const i = ids.indexOf(id);
		const j = dir === 'up' ? i - 1 : i + 1;
		if (i < 0 || j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j], ids[i]];
		const set = d.prepare('UPDATE libraries SET sort_order = ? WHERE id = ?');
		ids.forEach((lid, idx) => set.run(idx + 1, lid));
	})();
}

/** Normalise a user-entered folder to a clean MEDIA_ROOT-relative path, or null if it escapes. */
export function normalizeLibraryPath(input: string): string | null {
	const trimmed = input.trim().replace(/^\/+/, ''); // treat as relative even if they type a leading /
	const abs = rootFor(path.normalize(trimmed));
	return abs ? path.relative(MEDIA_ROOT, abs) : null;
}

/** Does the library's folder actually exist on disk? (Surface a warning in the UI, don't block.)
 *  Virtuals (path NULL) have no folder by design — always "fine". */
export function libraryFolderExists(relPath: string | null): boolean {
	if (relPath == null) return true;
	const abs = rootFor(relPath);
	return !!abs && isDir(abs);
}

export function getLibrary(id: number): LibraryConfig | null {
	const r = stateDb()
		.prepare('SELECT id, name, path, format, new_private, show_in_recent FROM libraries WHERE id = ?')
		.get(id) as LibraryRow | undefined;
	return r ? toConfig(r) : null;
}

export function addLibrary(
	name: string,
	relPath: string,
	format: LibraryFormat,
	newPrivate: boolean,
	showInRecent = true,
	now = Date.now()
): void {
	stateDb()
		.prepare(
			'INSERT INTO libraries (name, path, format, new_private, show_in_recent, created_at, sort_order) ' +
				'VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM libraries))'
		)
		.run(name.trim(), relPath, format, newPrivate ? 1 : 0, showInRecent ? 1 : 0, now);
}

/** Create a VIRTUAL library — a federation mapping target with no local folder (path NULL). Its
 *  format is inherited from the federated source and locked (updateLibrary refuses to change it).
 *  Returns the new library id. */
export function addVirtualLibrary(name: string, format: LibraryFormat, now = Date.now()): number {
	const res = stateDb()
		.prepare(
			'INSERT INTO libraries (name, path, format, new_private, show_in_recent, created_at, sort_order) ' +
				'VALUES (?, NULL, ?, 0, 1, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM libraries))'
		)
		.run(name.trim(), format, now);
	return Number(res.lastInsertRowid);
}

/** Is this library the target of any federation mapping? (Its format is then locked — mirrored
 *  rows of that format live under it.) */
export function isMappingTarget(id: number): boolean {
	return !!stateDb().prepare('SELECT 1 FROM fed_library_map WHERE local_library_id = ? LIMIT 1').get(id);
}

export function updateLibrary(
	id: number,
	name: string,
	relPath: string,
	format: LibraryFormat,
	newPrivate: boolean,
	showInRecent = true
): void {
	const cur = getLibrary(id);
	if (!cur) return;
	// Virtuals have no folder and an inherited format: only the presentational fields are editable
	// (the admin UI disables the others; ignoring, not failing, keeps the shared form action simple).
	if (cur.virtual) {
		stateDb()
			.prepare('UPDATE libraries SET name = ?, new_private = ?, show_in_recent = ? WHERE id = ?')
			.run(name.trim(), newPrivate ? 1 : 0, showInRecent ? 1 : 0, id);
		return;
	}
	// A federation mapping target holds mirrored rows of its format — changing it would orphan them
	// (and break the movies-merge invariant). Surfaced to the admin form as a fail(400).
	if (format !== cur.format && isMappingTarget(id)) {
		throw new Error('format-locked: this library receives federated content of its current format');
	}
	stateDb()
		.prepare('UPDATE libraries SET name = ?, path = ?, format = ?, new_private = ?, show_in_recent = ? WHERE id = ?')
		.run(name.trim(), relPath, format, newPrivate ? 1 : 0, showInRecent ? 1 : 0, id);
}

export function deleteLibrary(id: number): void {
	stateDb().prepare('DELETE FROM libraries WHERE id = ?').run(id);
}

/** Immediate subdirectories of a MEDIA_ROOT-relative path — powers the /admin/libraries folder browser.
 *  Names only, sorted, hidden dirs excluded; empty if the path is invalid or unreadable. */
export function listSubdirs(relPath: string): string[] {
	const abs = rootFor(relPath);
	if (!abs) return [];
	try {
		return fs
			.readdirSync(abs, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}
