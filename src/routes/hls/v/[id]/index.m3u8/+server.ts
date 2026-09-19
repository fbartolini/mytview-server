import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { verifyMedia } from '$lib/server/mediaToken';
import { canSeeVideo } from '$lib/server/visibility';
import { startHlsSession, hlsEnabled } from '$lib/server/hls';
import { audioTracks } from '$lib/server/subsembed';
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
	// ?a=<absolute stream index> selects an audio track. NOT part of the signature on purpose: it
	// picks a stream of a file the caller is already authorised to play, so it grants nothing new —
	// but it IS validated against the file's real audio streams, so it can never become an arbitrary
	// `-map` argument.
	const wanted = url.searchParams.get('a');
	let audioIndex: number | null = null;
	if (wanted != null) {
		const n = Number(wanted);
		const row = db().prepare('SELECT video_path, mtime FROM videos WHERE id = ?').get(params.id) as
			| { video_path: string; mtime: number }
			| undefined;
		if (row && Number.isInteger(n)) {
			const tracks = await audioTracks(row.video_path, row.mtime);
			if (tracks.some((t: { index: number }) => t.index === n)) audioIndex = n;
		}
	}
	// ?mode=copy asks for STREAM COPY (contract §HLS): video+audio untouched in TS segments, text tracks
	// dropped, no encode. Not part of the signature (it grants nothing new); the engine refuses it
	// silently — and encodes — for codecs TS can't carry or a keyframe scan still in progress.
	const wantCopy = url.searchParams.get('mode') === 'copy';
	const s = await startHlsSession(params.id, fedRef, audioIndex, wantCopy);
	if (!s) throw error(404);
	return new Response(s.playlist, {
		headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }
	});
};
