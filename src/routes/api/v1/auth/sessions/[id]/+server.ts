import { error, json } from '@sveltejs/kit';
import { revokeSession, deleteSession } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// Revoke ONE of the caller's sessions by its public id. The special id "current" revokes THIS
// request's own session — that's how a native client signs out (server-side, not just a local token
// drop). Revocation is scoped to the caller's user_id, so you can only ever kill your own sessions.
export const DELETE: RequestHandler = ({ params, locals }) => {
	if (!locals.user) throw error(401);
	if (params.id === 'current') {
		if (!locals.sessionToken) throw error(400, 'no current session');
		deleteSession(locals.sessionToken);
		return json({ ok: true });
	}
	if (!revokeSession(locals.user.id, params.id)) throw error(404, 'session not found');
	return json({ ok: true });
};
