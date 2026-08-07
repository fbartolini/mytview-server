import { error, json } from '@sveltejs/kit';
import { getChannel } from '$lib/server/queries';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, locals }) => {
	if (!locals.user) throw error(401);
	const showWatched = url.searchParams.get('watched') === '1';
	const data = getChannel(params.id, locals.user.id, showWatched);
	if (!data) throw error(404);
	return json(data);
};
