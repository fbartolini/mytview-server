/**
 * Library configuration + resolution.
 *
 * A "library" is a typed root the indexer walks: a subfolder of MEDIA_ROOT with a `format`
 * (channels | series) and a default visibility for newly-seen items (`newPrivate`). Libraries are
 * OWNER-CONFIGURED in the UI (`/admin/libraries`) and stored in `state.db`, so a single `/media`
 * mount serves any number of libraries pointing at arbitrary subfolders — the media-server model,
 * not a per-volume/env convention.
 *
 * Zero-config default: with NO libraries defined, the whole MEDIA_ROOT is one public channels
 * library, so an existing single-library deploy keeps working untouched until the owner adds/splits
 * libraries. Every path stays relative to MEDIA_ROOT, so the traversal guard in files.ts is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_ROOT } from './config';
import { stateDb } from './state';

export type LibraryFormat = 'channels' | 'series';

/** A resolved library the indexer walks. */
export interface Library {
	id: number | null; // null = the implicit default library (no DB row)
	name: string;
	format: LibraryFormat;
	root: string; // absolute directory the indexer walks
	prefix: string; // `root` relative to MEDIA_ROOT ('' = MEDIA_ROOT itself)
	newPrivate: boolean; // newly-seen channels/shows here default to private
}

interface LibraryRow {
	id: number;
	name: string;
	path: string;
	format: string;
	new_private: number;
}

const asFormat = (f: string): LibraryFormat => (f === 'series' ? 'series' : 'channels');

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

/** The active libraries (empty table → the implicit default). Called by the indexer each scan. */
export function resolveLibraries(): Library[] {
	const rows = stateDb()
		.prepare('SELECT id, name, path, format, new_private FROM libraries ORDER BY id')
		.all() as LibraryRow[];
	if (rows.length === 0) {
		return [{ id: null, name: 'Library', format: 'channels', root: MEDIA_ROOT, prefix: '', newPrivate: false }];
	}
	const libs: Library[] = [];
	for (const r of rows) {
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
	path: string;
	format: LibraryFormat;
	newPrivate: boolean;
}

export function listLibraries(): LibraryConfig[] {
	return (
		stateDb()
			.prepare('SELECT id, name, path, format, new_private FROM libraries ORDER BY name COLLATE NOCASE')
			.all() as LibraryRow[]
	).map((r) => ({ id: r.id, name: r.name, path: r.path, format: asFormat(r.format), newPrivate: !!r.new_private }));
}

/** Normalise a user-entered folder to a clean MEDIA_ROOT-relative path, or null if it escapes. */
export function normalizeLibraryPath(input: string): string | null {
	const trimmed = input.trim().replace(/^\/+/, ''); // treat as relative even if they type a leading /
	const abs = rootFor(path.normalize(trimmed));
	return abs ? path.relative(MEDIA_ROOT, abs) : null;
}

/** Does the library's folder actually exist on disk? (Surface a warning in the UI, don't block.) */
export function libraryFolderExists(relPath: string): boolean {
	const abs = rootFor(relPath);
	return !!abs && isDir(abs);
}

export function getLibrary(id: number): LibraryConfig | null {
	const r = stateDb().prepare('SELECT id, name, path, format, new_private FROM libraries WHERE id = ?').get(id) as
		| LibraryRow
		| undefined;
	return r ? { id: r.id, name: r.name, path: r.path, format: asFormat(r.format), newPrivate: !!r.new_private } : null;
}

export function addLibrary(name: string, relPath: string, format: LibraryFormat, newPrivate: boolean, now = Date.now()): void {
	stateDb()
		.prepare('INSERT INTO libraries (name, path, format, new_private, created_at) VALUES (?, ?, ?, ?, ?)')
		.run(name.trim(), relPath, format, newPrivate ? 1 : 0, now);
}

export function updateLibrary(id: number, name: string, relPath: string, format: LibraryFormat, newPrivate: boolean): void {
	stateDb()
		.prepare('UPDATE libraries SET name = ?, path = ?, format = ?, new_private = ? WHERE id = ?')
		.run(name.trim(), relPath, format, newPrivate ? 1 : 0, id);
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
