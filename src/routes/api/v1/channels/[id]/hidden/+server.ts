import { error, json } from '@sveltejs/kit';
import { canSeeChannel, setChannelHidden } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

// Per-user "unsubscribe from my feed" toggle — a PERSONAL feed filter, not access control (the
// channel stays directly reachable). Body: { hidden: boolean }. Guarded by canSeeChannel so you
// can't toggle a channel you can't see. Auth: bearer or cookie.
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401);
	if (!canSeeChannel(locals.user, params.id)) throw error(404);
	const body = (await request.json().catch(() => ({}))) as { hidden?: unknown };
	const hidden = body.hidden === true;
	setChannelHidden(locals.user.id, params.id, hidden);
	return json({ hidden });
};
