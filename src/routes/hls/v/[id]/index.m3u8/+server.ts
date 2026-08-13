import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { verifyMedia } from '$lib/server/mediaToken';
import { canSeeVideo } from '$lib/server/visibility';
import { startHlsSession, hlsEnabled } from '$lib/server/hls';
import { linkIdFromTag, linkCap, streamAllowed, noteStream } from '$lib/server/fedmeter';
import type { RequestHandler } from './$types';

// On-the-fly HLS media playlist (a full VOD playlist) for a video's live-transcode session. Authorized by
// a signed `?k=&exp=` (so AVPlayer/hls.js fetch it with NO auth header) OR a logged-in user with
// visibility. Building the playlist starts a session; its segment lines are scoped + signed to it. GET.
export const GET: RequestHandler = async ({ params, url, locals, getClientAddress }) => {
	if (!hlsEnabled()) throw error(404);
	const signedOk = verifyMedia('hls', params.id, url);
	if (!signedOk && !canSeeVideo(locals.user, params.id)) throw error(404);
	// Federated videos transcode on the PEER (the descriptor's hlsUrl points there) — never here.
	const fed = db().prepare('SELECT peer_id FROM videos WHERE id = ?').get(params.id) as
		| { peer_id: string | null }
		| undefined;
	if (fed?.peer_id != null) throw error(404);
	// A PEER's viewer transcoding here: cap + attribute per link (tag trusted only off the MAC).
	const fedLink = signedOk ? linkIdFromTag(url) : null;
	let fedRef: { linkId: number; key: string } | null = null;
	if (fedLink != null) {
		fedRef = { linkId: fedLink, key: `${params.id}|${getClientAddress()}` };
		if (!streamAllowed(fedLink, fedRef.key, linkCap(fedLink))) throw error(429, 'stream limit reached');
		noteStream(fedLink, fedRef.key);
	}
	const s = await startHlsSession(params.id, fedRef);
	if (!s) throw error(404);
	return new Response(s.playlist, {
		headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }
	});
};
