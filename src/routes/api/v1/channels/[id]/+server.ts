import { error, json } from '@sveltejs/kit';
import { getChannel, directPlayMap, verticalMap, nextEpisode, asMovieSort } from '$lib/server/queries';
import { signChannelArt, signedPath } from '$lib/server/mediaToken';
import { isChannelHidden } from '$lib/server/visibility';
import type { VideoSummary } from '$lib/types';
import type { RequestHandler } from './$types';

// One channel + its videos (newest first; a series returns all episodes in season/episode order; a
// movies channel hides watched movies by default like a flat channel — since 2026-08-12, contract
// §Movies; hidden count = channel.video_count - videos.length — `?sort=title|year|added`, default
// title), each carrying
// `directPlay`/`isVertical` flags, a signed thumb URL (movies also a signed 2:3 `poster` URL), and this
// user's watch state; the channel carries signed poster/fanart + `isHidden`. For a series, `nextEpisode`
// is the server-owned continue pointer (first unwatched episode in order, or null). `?watched=1`
// reveals watched videos (hidden by default, like the feed). Auth: bearer token or cookie.
export const GET: RequestHandler = ({ params, url, locals }) => {
	if (!locals.user) throw error(401);
	const showWatched = url.searchParams.get('watched') === '1';
	const data = getChannel(params.id, locals.user.id, showWatched, asMovieSort(url.searchParams.get('sort')));
	if (!data) throw error(404, 'channel not found');
	const ids = data.videos.map((v) => v.id);
	const dp = directPlayMap(ids);
	const vert = verticalMap(ids);
	const enrich = (v: VideoSummary) => ({
		...v,
		directPlay: dp.get(v.id) ?? false,
		isVertical: vert.get(v.id) ?? false,
		thumb: v.thumb_path ? signedPath('thumb', v.id) : null,
		// Movies only — the per-video 2:3 poster for poster-wall grids (null elsewhere).
		poster: v.poster_path ? signedPath('poster', v.id) : null
	});
	const videos = data.videos.map(enrich);
	const channel = {
		...signChannelArt(data.channel),
		isHidden: isChannelHidden(locals.user.id, params.id)
	};
	// Series only: the continue pointer (first unwatched episode, season/episode order); null for a flat
	// channel or a fully-watched series. Its id is among `ids` (a series returns all its episodes), so
	// the dp/vert lookups inside enrich() resolve.
	const nextRaw = data.channel.kind === 'series' ? nextEpisode(params.id, locals.user.id) : null;
	return json({ channel, videos, nextEpisode: nextRaw ? enrich(nextRaw) : null });
};
