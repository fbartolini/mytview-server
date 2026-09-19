import { error, json } from '@sveltejs/kit';
import { isOwner, canInvite } from '$lib/server/visibility';
import { getUserPrefs, setUserPrefs, type PrefsPatch, type UserPrefs } from '$lib/server/prefs';
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
		subtitleSize?: unknown;
		subtitleColor?: unknown;
		browse?: unknown;
	};
	const patch: PrefsPatch = {};
	if (typeof body.autoplayNext === 'boolean') patch.autoplayNext = body.autoplayNext;
	if (typeof body.stillWatchingAfter === 'number' && Number.isFinite(body.stillWatchingAfter)) {
		patch.stillWatchingAfter = body.stillWatchingAfter;
	}
	// Caption appearance is an ACCESSIBILITY setting, so it belongs to the person, not the device:
	// set it on the TV and the phone honours it too. `setUserPrefs` re-validates the values, so an
	// unknown string can never leave someone with captions that render as nothing.
	if (typeof body.subtitleSize === 'string') patch.subtitleSize = body.subtitleSize as UserPrefs['subtitleSize'];
	if (typeof body.subtitleColor === 'string') patch.subtitleColor = body.subtitleColor as UserPrefs['subtitleColor'];
	// Per-library browse state (contract §Browse persistence). Library-level merge: each entry sent
	// replaces that library's saved sort+genre whole, null clears it, unmentioned libraries keep
	// theirs — so a client PATCHes only the library the user just changed. prefs.ts re-validates.
	if (typeof body.browse === 'object' && body.browse !== null && !Array.isArray(body.browse)) {
		patch.browse = body.browse as PrefsPatch['browse'];
	}
	return json({ prefs: setUserPrefs(locals.user.id, patch) });
};
