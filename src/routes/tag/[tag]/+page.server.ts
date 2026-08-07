import { error } from '@sveltejs/kit';
import { listVideos } from '$lib/server/queries';
import type { PageServerLoad } from './$types';

const PAGE = 60;

export const load: PageServerLoad = ({ params, url, locals }) => {
	if (!locals.user) throw error(401);
	const tag = params.tag; // already URL-decoded by SvelteKit
	const showWatched = url.searchParams.get('watched') === '1';
	const initial = listVideos({ limit: PAGE, offset: 0, tag, userId: locals.user.id, showWatched });

	const hiddenByWatched =
		initial.length === 0 && !showWatched
			? listVideos({ limit: 1, tag, userId: locals.user.id, showWatched: true }).length > 0
			: false;

	return { tag, showWatched, initial, hiddenByWatched };
};
