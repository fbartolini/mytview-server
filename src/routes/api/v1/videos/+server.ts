import { error, json } from '@sveltejs/kit';
import { listVideos, directPlayMap, verticalMap } from '$lib/server/queries';
import { signedPath } from '$lib/server/mediaToken';
import type { RequestHandler } from './$types';

// Versioned feed endpoint for native clients. Same query as the web feed, plus a
// `directPlay` flag per item (H.264+AAC → true) so the app knows which videos to play vs
// fail-soft badge, and simple offset pagination metadata. Auth: bearer token or cookie.
export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.user) throw error(401);

	const rawLimit = parseInt(url.searchParams.get('limit') ?? '60', 10);
	const rawOffset = parseInt(url.searchParams.get('offset') ?? '0', 10);
	const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 60));
	const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
	const q = url.searchParams.get('q');
	const tag = url.searchParams.get('tag');
	const showWatched = url.searchParams.get('watched') === '1';

	const rows = listVideos({
		limit,
		offset,
		q: q || null,
		tag: tag || null,
		userId: locals.user.id,
		showWatched
	});
	const ids = rows.map((v) => v.id);
	const dp = directPlayMap(ids);
	const vert = verticalMap(ids);
	// Each item carries a ready-to-render signed thumb URL (so the client's AsyncImage needs no auth
	// plumbing) + the server-owned direct-play / portrait flags. See mediaToken.ts, verticalMap.
	const items = rows.map((v) => ({
		...v,
		directPlay: dp.get(v.id) ?? false,
		isVertical: vert.get(v.id) ?? false,
		thumb: v.thumb_path ? signedPath('thumb', v.id) : null
	}));
	const nextOffset = rows.length === limit ? offset + limit : null;

	return json({ items, page: { limit, offset, nextOffset } });
};
