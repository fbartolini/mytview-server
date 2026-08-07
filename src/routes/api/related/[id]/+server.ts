import { error, json } from '@sveltejs/kit';
import { relatedVideos } from '$lib/server/queries';
import { canSeeVideo } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.user) throw error(401);
	if (!canSeeVideo(locals.user, params.id)) throw error(404);
	return json(relatedVideos(params.id, locals.user.id, 8));
};
