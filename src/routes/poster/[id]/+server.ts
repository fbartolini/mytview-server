import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveInMediaRoot, serveFile } from '$lib/server/files';
import { canSeeChannel } from '$lib/server/visibility';
import { verifyMedia } from '$lib/server/mediaToken';
import { bucketWidth, resizedImage } from '$lib/server/imagecache';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, request, url, locals }) => {
	// params.id is a CHANNEL id (channels.poster_path — the historical shape) OR, for movies, a VIDEO
	// id (each movie carries its own 2:3 poster in videos.poster_path). Channel and video ids live in
	// disjoint namespaces, so try channel first, then fall back to a video. A valid signed URL
	// (native art) authorizes in place of the session; the cookie path checks channel visibility —
	// for a video, its OWNING channel's.
	const signed = verifyMedia('poster', params.id, url);
	const ch = db().prepare('SELECT poster_path FROM channels WHERE id = ?').get(params.id) as
		| { poster_path: string | null }
		| undefined;
	let posterPath: string | null;
	if (ch) {
		if (!signed && !canSeeChannel(locals.user, params.id)) throw error(404);
		posterPath = ch.poster_path;
	} else {
		const v = db()
			.prepare('SELECT poster_path, channel_id FROM videos WHERE id = ?')
			.get(params.id) as { poster_path: string | null; channel_id: string } | undefined;
		if (!v) throw error(404);
		if (!signed && !canSeeChannel(locals.user, v.channel_id)) throw error(404);
		posterPath = v.poster_path;
	}
	const { absPath, stat } = await resolveInMediaRoot(posterPath);
	const w = bucketWidth(url.searchParams.get('w')); // WS-I downscale; falls through to original on miss
	if (w) {
		const small = await resizedImage(absPath, stat, w);
		if (small) return serveFile(request, small.absPath, small.stat);
	}
	return serveFile(request, absPath, stat);
};
