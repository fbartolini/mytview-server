import { listChannels, type ChannelSort } from '$lib/server/queries';
import { getLibrary } from '$lib/server/libraries';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, locals }) => {
	// Optional ?library=<id> scopes the grid to one configured library (the header nav links here).
	// Ignore anything non-numeric or unknown → the unfiltered "all channels" view.
	const raw = url.searchParams.get('library');
	const libraryId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
	const library = libraryId != null ? getLibrary(libraryId) : null;
	// Optional ?sort — default 'name' for anything else.
	const s = url.searchParams.get('sort');
	const sort: ChannelSort = s === 'updated' || s === 'unwatched' ? s : 'name';
	return {
		channels: listChannels(locals.user, library ? library.id : null, sort),
		library: library ? { id: library.id, name: library.name, format: library.format } : null,
		sort
	};
};
