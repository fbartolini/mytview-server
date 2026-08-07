import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveInMediaRoot, serveFile } from '$lib/server/files';
import { canSeeChannel } from '$lib/server/visibility';
import { shareGrantsMedia } from '$lib/server/share';
import { verifyMedia } from '$lib/server/mediaToken';
import type { RequestHandler } from './$types';

const handler: RequestHandler = async ({ params, request, url, cookies, locals }) => {
	const r = db().prepare('SELECT video_path, channel_id FROM videos WHERE id = ?').get(params.id) as
		| { video_path: string; channel_id: string }
		| undefined;
	if (!r) throw error(404);
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
	return serveFile(request, absPath, stat);
};

// HEAD so native players (AVPlayer et al.) can probe size/accept-ranges before streaming.
export const GET = handler;
export const HEAD = handler;
