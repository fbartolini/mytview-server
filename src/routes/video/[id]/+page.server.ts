import { error } from '@sveltejs/kit';
import { getVideo, relatedVideos, webPrefersCompat } from '$lib/server/queries';
import { resolveTracks, audioTracksFor } from '$lib/server/subsembed';
import { canSeeChannel } from '$lib/server/visibility';
import { getWatch, watchedAtSeconds, resumePosition } from '$lib/server/watch';
import { hlsEnabled } from '$lib/server/hls';
import { getUserPrefs, DEFAULT_PREFS } from '$lib/server/prefs';
import { fedPlaybackUrls } from '$lib/server/fedclient';
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

	// FEDERATED video: media streams DIRECT from the peer — fetch absolute peer-signed URLs for the
	// player (contract §Federation). Peer down → the page still renders (metadata + related are
	// local); the player slot shows an explicit "peer unreachable" card instead of a fake error.
	const remote = video.peer_id != null;
	let srcUrl: string | null = null;
	let fedHlsUrl: string | null = null;
	// A federated video's subtitles come from the PEER (it alone can see the files); local ones are
	// resolved below. Same field either way, so the player needs no idea which it got.
	let fedSubtitles: { lang: string | null; label: string; kind: 'captions' | 'subtitles'; url: string }[] = [];
	let peerUnavailable = false;
	if (remote) {
		try {
			const abs = await fedPlaybackUrls(video.id);
			srcUrl = abs.url;
			fedHlsUrl = abs.hlsUrl;
			fedSubtitles = abs.subtitles;
		} catch {
			peerUnavailable = true;
		}
	}

	// Whether on-the-fly HLS is available — the player's ONLY fallback on a decode failure (the
	// whole-file compat tier was removed 2026-08-07). For a federated video that's the PEER's HLS.
	const hls = remote ? fedHlsUrl != null : hlsEnabled();
	// Some sources play VIDEO but silently drop AUDIO on the web <video> with no MediaError, so fail-open
	// can't catch them — a Matroska container OR a Chrome-undecodable audio codec (AC-3/E-AC-3/DTS/TrueHD).
	// For those the player must START on live HLS rather than attempt the original (see webPrefersCompat).
	// Gated on HLS actually being enabled: with it off there's nothing to prefer, so stay fail-open (the
	// original plays — silent audio, but better than starting on a source that can't load).
	const preferCompat = webPrefersCompat(params.id) && hls;
	// Server-owned watch decisions so web + native seek/mark identically (see watch.ts).
	// Sidecars + container tracks, resolved now (see subsembed.ts — a header read, memoised).
	const tracks = remote ? [] : await resolveTracks(video.id);
	const audio = remote ? [] : await audioTracksFor(video.id);

	return {
		video,
		watch,
		related,
		preferCompat,
		hlsEnabled: hls,
		srcUrl,
		hlsUrl: fedHlsUrl,
		// Subtitle sidecars (server-discovered, server-ordered). Same-origin here: the web player is
		// already inside the auth guard, so no signature is needed the way native clients need one.
		audioTracks: audio,
		subtitles: remote
			? fedSubtitles
			: tracks.map((t, i) => ({
					lang: t.lang,
					label: t.label,
					kind: t.kind,
					url: `/subs/${encodeURIComponent(video.id)}/${i}`
				})),
		remote,
		peerUnavailable,
		watchedAt: watchedAtSeconds(video.duration),
		resumePosition: resumePosition(watch, video.duration),
		prefs: locals.user ? getUserPrefs(locals.user.id) : { ...DEFAULT_PREFS, browse: {} }
	};
};
