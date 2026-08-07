import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveInMediaRoot, serveFile } from '$lib/server/files';
import { canSeeChannel } from '$lib/server/visibility';
import { shareGrantsThumb } from '$lib/server/share';
import { verifyMedia } from '$lib/server/mediaToken';
import { bucketWidth, resizedImage } from '$lib/server/imagecache';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, request, url, locals }) => {
	const r = db().prepare('SELECT thumb_path, channel_id FROM videos WHERE id = ?').get(params.id) as
		| { thumb_path: string | null; channel_id: string }
		| undefined;
	if (!r) throw error(404);
	// A valid per-video share token OR a valid signed URL (native grids / OG bots) bypasses channel
	// visibility; otherwise this is account access and must respect the channel's public/private setting.
	const tok = url.searchParams.get('s');
	const viaShare = !!tok && shareGrantsThumb(tok, params.id);
	const viaSignedUrl = verifyMedia('thumb', params.id, url);
	if (!viaShare && !viaSignedUrl && !canSeeChannel(locals.user, r.channel_id)) {
		throw error(404);
	}
	const { absPath, stat } = await resolveInMediaRoot(r.thumb_path);
	// ?w=<width> → serve a cached downscaled variant (WS-I); any miss/failure falls through to the original.
	const w = bucketWidth(url.searchParams.get('w'));
	if (w) {
		const small = await resizedImage(absPath, stat, w);
		if (small) return serveFile(request, small.absPath, small.stat);
	}
	return serveFile(request, absPath, stat);
};
