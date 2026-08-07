import { error, json } from '@sveltejs/kit';
import { relatedVideos, directPlayMap, verticalMap } from '$lib/server/queries';
import { canSeeVideo } from '$lib/server/visibility';
import { signedPath } from '$lib/server/mediaToken';
import type { RequestHandler } from './$types';

// Related videos for native clients — the same neighbour query as the web `/api/related/[id]`, but
// each item carries a ready-to-render SIGNED thumb URL plus the server-owned `directPlay`/`isVertical`
// flags (mirrors /api/v1/videos), so the app's AsyncImage needs no auth plumbing. Feeds the detail
// "Related" rail and the player's autoplay-next. Auth: bearer token or cookie; visibility-guarded.
export const GET: RequestHandler = ({ params, locals }) => {
	if (!locals.user) throw error(401);
	if (!canSeeVideo(locals.user, params.id)) throw error(404);

	const rows = relatedVideos(params.id, locals.user.id, 12);
	const ids = rows.map((v) => v.id);
	const dp = directPlayMap(ids);
	const vert = verticalMap(ids);
	const items = rows.map((v) => ({
		...v,
		directPlay: dp.get(v.id) ?? false,
		isVertical: vert.get(v.id) ?? false,
		thumb: v.thumb_path ? signedPath('thumb', v.id) : null
	}));

	return json({ items });
};
