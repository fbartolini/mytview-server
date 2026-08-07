import { error, json } from '@sveltejs/kit';
import { isOwner, canInvite } from '$lib/server/visibility';
import { getUserPrefs, setUserPrefs } from '$lib/server/prefs';
import type { RequestHandler } from './$types';

// The signed-in user + capability flags + client preferences. Lets native clients gate affordances
// (the owner-only Channel-visibility punch-out, the invite punch-out which respects ALLOW_INVITES)
// and read the server-owned playback prefs (autoplay / still-watching) instead of hard-coding them.
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	return json({
		id: locals.user.id,
		username: locals.user.username,
		isOwner: isOwner(locals.user),
		canInvite: canInvite(locals.user),
		prefs: getUserPrefs(locals.user.id)
	});
};

// Update this user's preferences (partial). Server-owned so the change syncs to every device.
export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401);
	const body = (await request.json().catch(() => ({}))) as {
		autoplayNext?: unknown;
		stillWatchingAfter?: unknown;
	};
	const patch: { autoplayNext?: boolean; stillWatchingAfter?: number } = {};
	if (typeof body.autoplayNext === 'boolean') patch.autoplayNext = body.autoplayNext;
	if (typeof body.stillWatchingAfter === 'number' && Number.isFinite(body.stillWatchingAfter)) {
		patch.stillWatchingAfter = body.stillWatchingAfter;
	}
	return json({ prefs: setUserPrefs(locals.user.id, patch) });
};
