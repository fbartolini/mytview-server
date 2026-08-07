import { error, json } from '@sveltejs/kit';
import { getVideo } from '$lib/server/queries';
import { canSeeChannel } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, locals }) => {
	const v = getVideo(params.id);
	if (!v || !canSeeChannel(locals.user, v.channel_id)) throw error(404);
	return json(v);
};
