import { json } from '@sveltejs/kit';
import { listChannels, isFullyWatched } from '$lib/server/queries';
import type { RequestHandler } from './$types';

// Fully-watched channels/series are hidden unless ?watched=1 (isFullyWatched — same default as
// the web grid and /api/v1/channels).
export const GET: RequestHandler = ({ url, locals }) => {
	const all = listChannels(locals.user);
	return json(
		url.searchParams.get('watched') === '1' ? all : all.filter((c) => !isFullyWatched(c))
	);
};
