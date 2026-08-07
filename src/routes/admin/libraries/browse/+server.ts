import { error, json } from '@sveltejs/kit';
import { isOwner } from '$lib/server/visibility';
import { normalizeLibraryPath, listSubdirs } from '$lib/server/libraries';
import type { RequestHandler } from './$types';

/** Folder browser for /admin/libraries — lists the immediate subfolders of a path under MEDIA_ROOT.
 *  Owner-only (404 otherwise, so the admin area stays undiscoverable). The path is normalised, so it
 *  can never escape MEDIA_ROOT. */
export const GET: RequestHandler = ({ locals, url }) => {
	if (!isOwner(locals.user)) throw error(404);
	const rel = normalizeLibraryPath(url.searchParams.get('path') ?? '');
	if (rel == null) throw error(400, 'path escapes the media root');
	return json({ path: rel, dirs: listSubdirs(rel) });
};
