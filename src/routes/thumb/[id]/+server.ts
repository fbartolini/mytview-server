import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveInMediaRoot, serveFile } from '$lib/server/files';
import { canSeeChannel } from '$lib/server/visibility';
import { shareGrantsThumb } from '$lib/server/share';
import { verifyMedia } from '$lib/server/mediaToken';
import { bucketWidth, resizedImage } from '$lib/server/imagecache';
import { fedVideoArt } from '$lib/server/fedart';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, request, url, locals }) => {
	const r = db()
		.prepare('SELECT thumb_path, channel_id, peer_id FROM videos WHERE id = ?')
		.get(params.id) as { thumb_path: string | null; channel_id: string; peer_id: string | null } | undefined;
	if (!r) throw error(404);
	// A valid per-video share token OR a valid signed URL (native grids / OG bots) bypasses channel
	// visibility; otherwise this is account access and must respect the channel's public/private setting.
	const tok = url.searchParams.get('s');
	const viaShare = !!tok && shareGrantsThumb(tok, params.id);
	const viaSignedUrl = verifyMedia('thumb', params.id, url);
	if (!viaShare && !viaSignedUrl && !canSeeChannel(locals.user, r.channel_id)) {
		throw error(404);
	}
	// Federated video: serve from the fed art cache (fetched once from the peer, same-origin to
	// clients — design §8). Same ?w= downscale path as local art below.
	if (r.peer_id != null) {
		const art = await fedVideoArt(params.id, 'thumb');
		if (!art) throw error(404);
		const fw = bucketWidth(url.searchParams.get('w'));
		if (fw) {
			const small = await resizedImage(art.absPath, art.stat, fw);
			if (small) return serveFile(request, small.absPath, small.stat);
		}
		return serveFile(request, art.absPath, art.stat);
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
