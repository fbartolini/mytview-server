import { error, json } from '@sveltejs/kit';
import { getVideo, directPlayMap, needsCompat, isMatroska } from '$lib/server/queries';
import { canSeeChannel } from '$lib/server/visibility';
import { getWatch, watchedAtSeconds, resumePosition } from '$lib/server/watch';
import { signedPath, signedHlsIndex } from '$lib/server/mediaToken';
import { hlsEnabled } from '$lib/server/hls';
import type { RequestHandler } from './$types';

// Video detail for the player screen — one round-trip: full metadata (incl. tags + chapters), this
// user's watch state (resume + watched) so the app can seek on open, `isVertical`, and a `playback`
// descriptor that folds the direct-play / transcode / fail-soft decision into ONE server-owned object
// (a signed, ready-to-play URL or null + a `kind`) so every native client renders play/badge
// identically. `directPlay` is kept for back-compat. Auth: bearer token or cookie.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401);
	const video = getVideo(params.id);
	if (!video || !canSeeChannel(locals.user, video.channel_id)) throw error(404, 'video not found');
	const directPlay = directPlayMap([video.id]).get(video.id) ?? false;
	// Codec residue OR a Matroska container — i.e. NOT every client can take the original as-is (an
	// .mkv whose codec is fine still can't be demuxed by AVPlayer). Drives the `kind` hint below.
	const compat = needsCompat(video.id);
	const isVertical = !!video.width && !!video.height && video.height > video.width;
	const poster = video.thumb_path ? signedPath('thumb', video.id) : null;

	// Fail-open playback (mirrors the web <video>): the client ALWAYS attempts the original `url`
	// first — a capable decoder (ExoPlayer/Tizen, or AVPlayer on a file whose codec fields don't match
	// the muxed reality) plays it directly — and only on a real decode failure falls back to the live
	// HLS stream. The whole-file compat tier was REMOVED (2026-08-07): `compatUrl`/`canTranscode` are
	// pinned to null/false — exactly the shape shipped clients already handle from a server that never
	// enabled it — and `kind` degrades to direct|unavailable. `kind` stays an informational hint
	// (badge/analytics), NOT a gate; the playability decision lives at the player, on the real error.
	const playback: {
		kind: 'direct' | 'transcoded' | 'pending' | 'unavailable';
		url: string;
		compatUrl: string | null;
		hlsUrl: string | null;
		mimeType: string;
		poster: string | null;
		canTranscode: boolean;
	} = {
		kind: !compat ? 'direct' : 'unavailable',
		url: signedPath('media', video.id),
		compatUrl: null,
		// On-the-fly HLS — the fallback that starts in SECONDS. Present for EVERY id when HLS is enabled,
		// NOT gated on `compat`: keying the fallback off the residue predicate would strip it exactly when
		// classification misses (mislabeled AV1/DTS, or HEVC on a chip without a decoder). hlsUrl is a
		// UNIVERSAL fail-open — the client still tries `url` first and only reaches for HLS on a real
		// decode error (the /hls route already starts a session for any id).
		hlsUrl: hlsEnabled() ? signedHlsIndex(video.id) : null,
		mimeType: 'video/mp4',
		poster,
		canTranscode: false
	};

	const watch = getWatch(locals.user.id, video.id);
	// Server-owned watch decisions so every client seeks/marks identically (see watch.ts).
	return json({
		...video,
		directPlay,
		isVertical,
		// A Matroska container can't be demuxed by AVPlayer at all (whatever the codec), so an Apple client
		// should START on the fallback (compat/HLS) instead of eating a guaranteed decode failure + stall on
		// every episode. Factual signal (⇔ isVertical); other clients (ExoPlayer/Tizen play .mkv) ignore it.
		isMkv: isMatroska(video.id),
		playback,
		watch,
		watchedAt: watchedAtSeconds(video.duration),
		resumePosition: resumePosition(watch, video.duration)
	});
};
