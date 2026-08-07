import { error, json } from '@sveltejs/kit';
import { listVideos } from '$lib/server/queries';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.user) throw error(401);
	const rawLimit = parseInt(url.searchParams.get('limit') ?? '60', 10);
	const rawOffset = parseInt(url.searchParams.get('offset') ?? '0', 10);
	const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 60));
	const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
	const q = url.searchParams.get('q');
	const tag = url.searchParams.get('tag');
	const showWatched = url.searchParams.get('watched') === '1';
	return json(
		listVideos({ limit, offset, q: q || null, tag: tag || null, userId: locals.user.id, showWatched })
	);
};
