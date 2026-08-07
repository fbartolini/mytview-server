import { error } from '@sveltejs/kit';
import { verifyMedia } from '$lib/server/mediaToken';
import { canSeeVideo } from '$lib/server/visibility';
import { startHlsSession, hlsEnabled } from '$lib/server/hls';
import type { RequestHandler } from './$types';

// On-the-fly HLS media playlist (a full VOD playlist) for a video's live-transcode session. Authorized by
// a signed `?k=&exp=` (so AVPlayer/hls.js fetch it with NO auth header) OR a logged-in user with
// visibility. Building the playlist starts a session; its segment lines are scoped + signed to it. GET.
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!hlsEnabled()) throw error(404);
	if (!verifyMedia('hls', params.id, url) && !canSeeVideo(locals.user, params.id)) throw error(404);
	const s = await startHlsSession(params.id);
	if (!s) throw error(404);
	return new Response(s.playlist, {
		headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }
	});
};
