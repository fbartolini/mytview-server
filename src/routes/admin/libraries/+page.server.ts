import { error, fail } from '@sveltejs/kit';
import { isOwner } from '$lib/server/visibility';
import {
	listLibraries,
	addLibrary,
	updateLibrary,
	deleteLibrary,
	moveLibrary,
	normalizeLibraryPath,
	libraryFolderExists,
	type LibraryFormat
} from '$lib/server/libraries';
import { runScan } from '$lib/server/indexer';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// Owner-only. 404 (not 403) so the admin area isn't even discoverable to other accounts.
	if (!isOwner(locals.user)) throw error(404);
	const libraries = listLibraries().map((l) => ({ ...l, exists: libraryFolderExists(l.path) }));
	return { libraries };
};

type Parsed = { name: string; path: string; format: LibraryFormat; newPrivate: boolean; showInRecent: boolean };

/** Validate the shared add/edit fields; returns the parsed values or a user-facing error string. */
function parseForm(data: FormData): Parsed | { error: string } {
	const name = String(data.get('name') ?? '').trim();
	const format = String(data.get('format') ?? '');
	const newPrivate = data.get('newPrivate') != null; // checkbox only submits when checked
	const showInRecent = data.get('showInRecent') != null;
	if (!name) return { error: 'Name is required.' };
	if (format !== 'channels' && format !== 'series' && format !== 'movies') return { error: 'Pick a format.' };
	const path = normalizeLibraryPath(String(data.get('path') ?? ''));
	if (path == null) return { error: 'That folder is outside the media root.' };
	return { name, path, format, newPrivate, showInRecent };
}

export const actions: Actions = {
	add: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const p = parseForm(await request.formData());
		if ('error' in p) return fail(400, { error: p.error });
		try {
			addLibrary(p.name, p.path, p.format, p.newPrivate, p.showInRecent);
		} catch {
			return fail(400, { error: 'Another library already uses that folder.' }); // UNIQUE(path)
		}
		void runScan(true); // library set changed → FULL re-index (incremental skips already-indexed files)
		return { ok: true };
	},

	update: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Bad library id.' });
		const p = parseForm(data);
		if ('error' in p) return fail(400, { error: p.error });
		try {
			updateLibrary(id, p.name, p.path, p.format, p.newPrivate, p.showInRecent);
		} catch {
			return fail(400, { error: 'Another library already uses that folder.' });
		}
		void runScan(true); // folder/format may have changed → FULL re-index so items re-assign
		return { ok: true };
	},

	delete: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const id = Number((await request.formData()).get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Bad library id.' });
		deleteLibrary(id); // removes the config; its channels/videos are pruned on the next scan
		void runScan(true); // FULL re-index so the removed library's items are cleared + the rest re-settle
		return { ok: true };
	},

	// Reorder: one step up/down in the owner-defined display order. Pure display state — every
	// surface (web tabs, /api/v1/libraries → TV tab promotion, pickers) reads the same order, so
	// no rescan is needed.
	move: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const id = Number(data.get('id'));
		const dir = String(data.get('dir'));
		if (!Number.isInteger(id) || id <= 0 || (dir !== 'up' && dir !== 'down')) {
			return fail(400, { error: 'Bad move.' });
		}
		moveLibrary(id, dir);
		return { ok: true };
	},

	// Force a FULL re-index in the background (fire-and-forget so the request returns immediately;
	// the header polls /api/status for progress). Full — not incremental — so a library re-point
	// re-assigns already-indexed files instead of skipping them by mtime. No-op if one's running.
	scan: async ({ locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		void runScan(true);
		return { scanned: true };
	}
};
