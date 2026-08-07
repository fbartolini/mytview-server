import { error, json } from '@sveltejs/kit';
import { listLibraries } from '$lib/server/libraries';
import { visibleLibraryIds } from '$lib/server/queries';
import type { RequestHandler } from './$types';

// The owner-configured libraries this user can see media in, for per-library nav/tabs (mirrors the web
// header). A library with no channel visible to the user, or no media at all (regardless of watched
// state), is hidden entirely. The list isn't access control — the channels within are (via visibility).
// Empty array → the client shows a single "Channels" tab. Auth: bearer or cookie.
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	const vis = visibleLibraryIds(locals.user);
	return json({
		items: listLibraries()
			.filter((l) => vis.has(l.id))
			.map((l) => ({ id: l.id, name: l.name, format: l.format }))
	});
};
