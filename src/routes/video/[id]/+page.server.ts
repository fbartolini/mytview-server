import { error } from '@sveltejs/kit';
import { getVideo, relatedVideos, webPrefersCompat } from '$lib/server/queries';
import { canSeeChannel } from '$lib/server/visibility';
import { getWatch, watchedAtSeconds, resumePosition } from '$lib/server/watch';
import { hlsEnabled } from '$lib/server/hls';
import { getUserPrefs, DEFAULT_PREFS } from '$lib/server/prefs';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const video = getVideo(params.id);
	if (!video || !canSeeChannel(locals.user, video.channel_id)) throw error(404, 'Video not found');
	const watch = locals.user
		? getWatch(locals.user.id, params.id)
		: { position: 0, watched: false };
	// Indexed (video_tags) so it's ~0.2ms — cheap to load in SSR, which lets the page place
	// it under the video on mobile and in the sidebar on desktop from a single source.
	const related = locals.user ? relatedVideos(params.id, locals.user.id, 8) : [];
	// Whether on-the-fly HLS is available — the player's ONLY fallback on a decode failure (the
	// whole-file compat tier was removed 2026-08-07).
	const hls = hlsEnabled();
	// Some sources play VIDEO but silently drop AUDIO on the web <video> with no MediaError, so fail-open
	// can't catch them — a Matroska container OR a Chrome-undecodable audio codec (AC-3/E-AC-3/DTS/TrueHD).
	// For those the player must START on live HLS rather than attempt the original (see webPrefersCompat).
	// Gated on HLS actually being enabled: with it off there's nothing to prefer, so stay fail-open (the
	// original plays — silent audio, but better than starting on a source that can't load).
	const preferCompat = webPrefersCompat(params.id) && hls;
	// Server-owned watch decisions so web + native seek/mark identically (see watch.ts).
	return {
		video,
		watch,
		related,
		preferCompat,
		hlsEnabled: hls,
		watchedAt: watchedAtSeconds(video.duration),
		resumePosition: resumePosition(watch, video.duration),
		prefs: locals.user ? getUserPrefs(locals.user.id) : DEFAULT_PREFS
	};
};
