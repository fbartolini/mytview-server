import { listChannels, isFullyWatched, type ChannelSort } from '$lib/server/queries';
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
	// Fully-watched channels/series are hidden by default (a finished show leaves the grid);
	// ?watched=1 reveals them — the same convention as the feed and the channel detail page.
	const showWatched = url.searchParams.get('watched') === '1';
	const all = listChannels(locals.user, library ? library.id : null, sort);
	const channels = showWatched ? all : all.filter((c) => !isFullyWatched(c));
	return {
		channels,
		// How many the default view is hiding — drives the "· N watched hidden" hint and the
		// everything-watched empty state (distinct from a genuinely empty library).
		hiddenWatched: all.length - channels.length,
		showWatched,
		library: library ? { id: library.id, name: library.name, format: library.format } : null,
		sort
	};
};
