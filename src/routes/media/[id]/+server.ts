import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveInMediaRoot, serveFile } from '$lib/server/files';
import { canSeeChannel } from '$lib/server/visibility';
import { shareGrantsMedia } from '$lib/server/share';
import { verifyMedia } from '$lib/server/mediaToken';
import { linkIdFromTag, linkCap, streamAllowed, noteStream, noteServe } from '$lib/server/fedmeter';
import type { RequestHandler } from './$types';

const handler: RequestHandler = async ({ params, request, url, cookies, locals, getClientAddress }) => {
	const r = db()
		.prepare('SELECT video_path, channel_id, peer_id FROM videos WHERE id = ?')
		.get(params.id) as { video_path: string; channel_id: string; peer_id: string | null } | undefined;
	if (!r) throw error(404);
	// Federated media is never proxied by this server — clients stream DIRECT from the peer via the
	// absolute URLs in the playback descriptor (docs/federation-design.md §1). The sentinel
	// video_path would fail resolveInMediaRoot anyway; 404 explicitly.
	if (r.peer_id != null) throw error(404);
	// Account access respects channel visibility; a valid per-video share token bypasses it (a
	// capped share also needs its viewer cookie — same check the auth hook makes), and a valid
	// signed URL (native players / AirPlay — mediaToken.ts) authorizes for exactly this id.
	// (A legacy `?compat=1` — the removed whole-file transcode tier — is ignored: old URLs that
	// carry it just get the original file; the signature was always per-id, not per-variant.)
	const tok = url.searchParams.get('s');
	const viaShare = !!tok && shareGrantsMedia(tok, params.id, cookies.get(`mv_share_${tok}`) === '1');
	const viaSignedUrl = verifyMedia('media', params.id, url);
	if (!viaShare && !viaSignedUrl && !canSeeChannel(locals.user, r.channel_id)) throw error(404);

	const { absPath, stat } = await resolveInMediaRoot(r.video_path);

	// Federated stream (a peer's viewer): the link tag is trusted ONLY off a verified signature
	// (it's inside the MAC). Enforce the per-peer concurrent-stream cap — new streams over the cap
	// get 429 (CORS'd so hls.js/web read a real status), active ones are never cut — and meter the
	// consumption (bytes ≈ the requested range span; fedmeter.ts).
	const fedLink = viaSignedUrl ? linkIdFromTag(url) : null;
	if (fedLink != null) {
		const streamKey = `${params.id}|${getClientAddress()}`;
		if (!streamAllowed(fedLink, streamKey, linkCap(fedLink))) {
			return new Response('stream limit reached', {
				status: 429,
				headers: { 'access-control-allow-origin': '*' }
			});
		}
		noteStream(fedLink, streamKey);
		const range = request.headers.get('range')?.match(/bytes=(\d+)-(\d*)/);
		const bytes = range
			? (range[2] ? parseInt(range[2], 10) : stat.size - 1) - parseInt(range[1], 10) + 1
			: stat.size;
		noteServe(fedLink, 'media', bytes);
	}
	return serveFile(request, absPath, stat);
};

// HEAD so native players (AVPlayer et al.) can probe size/accept-ranges before streaming.
export const GET = handler;
export const HEAD = handler;
