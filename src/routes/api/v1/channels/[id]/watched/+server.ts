import { error, json } from '@sveltejs/kit';
import { setChannelWatched } from '$lib/server/watch';
import { canSeeChannel } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

// Bulk-mark every video/episode in this channel/series watched (or unwatched) for the acting user —
// mirrors the web `setAllWatched` action → setChannelWatched (e.g. a new account clearing a show it's
// already seen). Body: { watched: boolean } — EXPLICIT, 400 otherwise. Auth + per-channel visibility
// (404 if not visible). Returns how many rows were affected. Auth: bearer or cookie.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401);
	if (!canSeeChannel(locals.user, params.id)) throw error(404);
	const body = (await request.json().catch(() => null)) as { watched?: unknown } | null;
	// Require an explicit boolean: `watched` used to default to FALSE, and a bulk-unwatch also resets
	// every resume position to 0 (watch.ts) — so a mangled/empty body from a buggy client silently
	// wiped the channel's watch state instead of erroring. Every shipped client sends the boolean, so
	// a non-boolean here is always a bug → 400.
	if (typeof body?.watched !== 'boolean') throw error(400, 'body must be { watched: boolean }');
	const watched = body.watched;
	const affected = setChannelWatched(locals.user.id, params.id, watched);
	return json({ affected, watched });
};
