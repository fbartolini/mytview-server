import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveInMediaRoot, serveFile } from '$lib/server/files';
import { canSeeChannel } from '$lib/server/visibility';
import { verifyMedia } from '$lib/server/mediaToken';
import { bucketWidth, resizedImage } from '$lib/server/imagecache';
import { fedChannelArt } from '$lib/server/fedart';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, request, url, locals }) => {
	// params.id is a CHANNEL id here; a valid signed URL (native art) authorizes in place of the session.
	if (!verifyMedia('fanart', params.id, url) && !canSeeChannel(locals.user, params.id))
		throw error(404);
	const r = db().prepare('SELECT fanart_path, peer_id FROM channels WHERE id = ?').get(params.id) as
		| { fanart_path: string | null; peer_id: string | null }
		| undefined;
	if (!r) throw error(404);
	// Federated channel: fanart comes from the fed art cache (peer-fetched once — design §8).
	if (r.peer_id != null) {
		if (!r.fanart_path) throw error(404);
		const art = await fedChannelArt(params.id, 'fanart');
		if (!art) throw error(404);
		const fw = bucketWidth(url.searchParams.get('w'));
		if (fw) {
			const small = await resizedImage(art.absPath, art.stat, fw);
			if (small) return serveFile(request, small.absPath, small.stat);
		}
		return serveFile(request, art.absPath, art.stat);
	}
	const { absPath, stat } = await resolveInMediaRoot(r.fanart_path);
	const w = bucketWidth(url.searchParams.get('w')); // WS-I downscale; falls through to original on miss
	if (w) {
		const small = await resizedImage(absPath, stat, w);
		if (small) return serveFile(request, small.absPath, small.stat);
	}
	return serveFile(request, absPath, stat);
};
