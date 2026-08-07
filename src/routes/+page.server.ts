import { error } from '@sveltejs/kit';
import { listVideos } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

const PAGE = 60;

export const load: PageServerLoad = ({ url, locals }) => {
	if (!locals.user) throw error(401);
	const q = url.searchParams.get('q')?.trim() ?? '';
	const showWatched = url.searchParams.get('watched') === '1';
	const initial = listVideos({ limit: PAGE, offset: 0, q: q || null, userId: locals.user.id, showWatched });

	// If the feed is empty only because everything's watched-and-hidden, say so
	// (rather than showing the "indexing / nothing found" state).
	const hiddenByWatched =
		initial.length === 0 && !showWatched
			? listVideos({ limit: 1, offset: 0, q: q || null, userId: locals.user.id, showWatched: true })
					.length > 0
			: false;

	return { q, showWatched, initial, hiddenByWatched };
};
