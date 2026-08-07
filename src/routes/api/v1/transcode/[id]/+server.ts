import { error, json } from '@sveltejs/kit';
import { canSeeVideo } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

// LEGACY STUB — the whole-file "compat copy" transcoder was removed (2026-08-07): live HLS
// (`playback.hlsUrl`) is the one transcode path now. Shipped native clients still probe this
// route on a decode failure, so it keeps answering exactly like a server that never enabled
// whole-file transcoding — a configuration every client already handles (GET → enabled:false,
// POST → 503) — instead of a surprising 404. Auth + visibility semantics are unchanged
// (401 unauthenticated, 404 for ids the user can't see) so it leaks nothing it didn't before.

export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.user) throw error(401);
	if (!canSeeVideo(locals.user, params.id)) throw error(404);
	return json({ enabled: false, status: 'none' });
};

export const POST: RequestHandler = ({ params, locals }) => {
	if (!locals.user) throw error(401);
	if (!canSeeVideo(locals.user, params.id)) throw error(404);
	throw error(503, 'transcoding is not enabled on this server');
};
