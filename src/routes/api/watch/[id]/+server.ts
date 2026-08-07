import { error, json } from '@sveltejs/kit';
import { getWatch, saveWatch } from '$lib/server/watch';
import { canSeeVideo } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.user) throw error(401);
	if (!canSeeVideo(locals.user, params.id)) throw error(404);
	return json(getWatch(locals.user.id, params.id));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401);
	if (!canSeeVideo(locals.user, params.id)) throw error(404);
	const body = (await request.json().catch(() => ({}))) as { position?: unknown; watched?: unknown };
	const patch: { position?: number; watched?: boolean } = {};
	if (typeof body.position === 'number' && Number.isFinite(body.position)) {
		patch.position = Math.max(0, body.position);
	}
	if (typeof body.watched === 'boolean') patch.watched = body.watched;
	saveWatch(locals.user.id, params.id, patch);
	return json({ ok: true });
};
