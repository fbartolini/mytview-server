import { error, json } from '@sveltejs/kit';
import { listSessions, revokeOtherSessions } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// The caller's own logged-in devices, for the manage-devices UI (web /sessions + native Settings).
// GET    → list every active session (device label + last-seen + which one is current).
// DELETE → sign out every OTHER device, keeping the current session. Auth: bearer or cookie.
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	return json({ sessions: listSessions(locals.user.id, locals.sessionToken) });
};

export const DELETE: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	if (!locals.sessionToken) throw error(400, 'no current session');
	return json({ revoked: revokeOtherSessions(locals.user.id, locals.sessionToken) });
};
