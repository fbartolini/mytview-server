import { error } from '@sveltejs/kit';
import { getChannel, asMovieSort } from '$lib/server/queries';
import { getLibrary } from '$lib/server/libraries';
import { getUserPrefs } from '$lib/server/prefs';
import { isChannelHidden, setChannelHidden } from '$lib/server/visibility';
import { setChannelWatched } from '$lib/server/watch';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, url, locals }) => {
	if (!locals.user) throw error(401);
	const showWatched = url.searchParams.get('watched') === '1';
	// Movies wall only (ignored for other kinds): an explicit ?sort wins; otherwise the owning
	// library's SAVED browse state applies (contract §Browse persistence — keyed on the library,
	// so `movies:<libId>` parses the id straight from the channel id).
	const movieLib = /^movies:(\d+)$/.exec(params.id)?.[1] ?? null;
	const saved = movieLib ? getUserPrefs(locals.user.id).browse[movieLib] : undefined;
	const sort = asMovieSort(url.searchParams.get('sort') ?? saved?.sort ?? null);
	const data = getChannel(params.id, locals.user.id, showWatched, sort);
	if (!data) throw error(404, 'Channel not found');
	// The library this channel belongs to → the back link returns to that library's grid (else "channels").
	const lib = data.channel.library_id != null ? getLibrary(data.channel.library_id) : null;
	return {
		...data,
		showWatched,
		sort,
		hidden: isChannelHidden(locals.user.id, params.id),
		library: lib ? { id: lib.id, name: lib.name } : null,
		// The wall's saved genre filter (client-side chips restore it; §Browse persistence).
		savedGenre: saved?.genre ?? null
	};
};

export const actions: Actions = {
	// Per-user "unsubscribe from my feed" — hides this channel from the acting user's Recent feed
	// (not from anyone else, and not from browsing it directly here). Any user; reversible.
	toggleHide: async ({ params, locals }) => {
		if (!locals.user) throw error(401);
		setChannelHidden(locals.user.id, params.id, !isChannelHidden(locals.user.id, params.id));
		return { ok: true };
	},

	// Bulk mark every video/episode here watched (default) or unwatched for the acting user — a new
	// account catching up on a show it's already seen. `watched=0` in the form flips it back.
	setAllWatched: async ({ params, request, locals }) => {
		if (!locals.user) throw error(401);
		const watched = (await request.formData()).get('watched') !== '0';
		setChannelWatched(locals.user.id, params.id, watched);
		return { ok: true };
	}
};
