import { error, json } from '@sveltejs/kit';
import { getVideo, directPlayMap, needsCompat, isMatroska } from '$lib/server/queries';
import { canSeeChannel } from '$lib/server/visibility';
import { getWatch, watchedAtSeconds, resumePosition } from '$lib/server/watch';
import { signedPath, signedHlsIndex } from '$lib/server/mediaToken';
import { hlsEnabled, copyEligible } from '$lib/server/hls';
import { fedPlaybackUrls, FedError } from '$lib/server/fedclient';
import { fedIdParts, linkByPrefix } from '$lib/server/federation';
import { runFedSync } from '$lib/server/fedsync';
import { resolveTracks, audioTracksFor, prefersHlsForTextStreams } from '$lib/server/subsembed';
import { resolveInMediaRoot } from '$lib/server/files';
import { db } from '$lib/server/db';
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
	// Sidecars + whatever is inside the container, asked now (a header read, memoised per file).
	const tracks = await resolveTracks(video.id);
	const audio = video.peer_id == null ? await audioTracksFor(video.id) : [];
	const isVertical = !!video.width && !!video.height && video.height > video.width;
	const poster = video.thumb_path ? signedPath('thumb', video.id) : null;
	// The original file's size (contract §Offline): a client about to keep this video offline checks
	// it against the device's free-space reserve BEFORE fetching. One stat, local files only — a
	// federated item's size is the peer's to report (null here; the client HEADs the peer URL).
	let sizeBytes: number | null = null;
	if (video.peer_id == null) {
		try {
			const row = db().prepare('SELECT video_path FROM videos WHERE id = ?').get(video.id) as
				| { video_path: string }
				| undefined;
			if (row) sizeBytes = (await resolveInMediaRoot(row.video_path)).stat.size;
		} catch {
			/* vanished since the scan → null; the download will 404 and the client marks it stale */
		}
	}

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
		sizeBytes: number | null;
		mimeType: string;
		poster: string | null;
		canTranscode: boolean;
		/** SERVER DECISION: start on `hlsUrl` instead of attempting `url` first. True when the
		 *  container carries more embedded text streams than PREFER_HLS_TEXT_STREAMS — a silent
		 *  demuxer failure on some panels that no client can detect (contract §playback descriptor,
		 *  the same class as the web's webPrefersCompat). Absent/false = the normal fail-open ladder. */
		preferHls: boolean;
		/** SERVER DECISION (contract §Offline): a download of this file's HLS rendition can be a STREAM
		 *  COPY on an Apple client (H.264 or HEVC video + AAC/AC-3/E-AC-3/MP3 audio — decided on the REAL
		 *  probe, memoised with the session's) — the client appends `&mode=copy&copyv=h264,hevc&fmt=fmp4` and counts
		 *  it against the copy pool, not the encoder pool. false = an encode (or HLS off). */
		hlsCopy: boolean;
		/** Subtitle sidecars found next to the media file, in server-decided order — clients render
		 *  as given. `kind: 'captions'` marks SDH/CC (the accessibility-relevant ones); the player
		 *  should offer them and start with all tracks OFF unless the user chose otherwise. Empty
		 *  array = none on disk (we never fetch or generate subtitles). */
		subtitles: { lang: string | null; label: string; kind: 'captions' | 'subtitles'; url: string }[];
		/** Audio tracks in the file. Choosing a non-default one means appending `&a=<index>` to
		 *  `hlsUrl` — HTML5 video cannot switch audio inside a container, so the server delivers the
		 *  chosen stream. `default:true` marks what plays when nobody chooses. */
		audioTracks: { index: number; lang: string | null; label: string; default: boolean }[];
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
		sizeBytes,
		mimeType: 'video/mp4',
		poster,
		canTranscode: false,
		preferHls: hlsEnabled() && prefersHlsForTextStreams(tracks.filter((t) => t.streamIndex != null).length),
		// H.264 OR HEVC: with fMP4 segments (`fmt=fmp4`) Apple takes both untouched.
		hlsCopy: hlsEnabled() && video.peer_id == null && (await copyEligible(video.id, new Set(['h264', 'hevc']))),
		audioTracks: audio,
		subtitles: tracks.map((t, i) => ({
			lang: t.lang,
			label: t.label,
			kind: t.kind,
			// Reuse the MEDIA signature: a subtitle belongs to the same asset, and /subs verifies the
			// 'media' kind for exactly this id — so one grant covers the video and its captions.
			url: `/subs/${encodeURIComponent(video.id)}/${i}${signedPath('media', video.id).replace(/^[^?]*/, '')}`
		}))
	};

	// FEDERATED video: media streams DIRECT from the peer — the descriptor's url/hlsUrl become
	// ABSOLUTE peer-signed URLs (all clients pass absolute URLs through verbatim — contract
	// §Federation). `poster` stays the HOME-origin signed thumb (art is proxied+cached, design §8).
	// Peer says not_shared → our mirror is stale: 404 + a background sync to self-heal. Peer
	// unreachable → an explicit 503 (never a hang or a fake decode error).
	if (video.peer_id != null) {
		try {
			const abs = await fedPlaybackUrls(video.id);
			playback.url = abs.url;
			playback.hlsUrl = abs.hlsUrl;
			// The peer resolved these against ITS files; we have no local copy to inspect, so its
			// answer is the only correct one. Absolute, like the media URL — clients pass both through.
			playback.subtitles = abs.subtitles;
		} catch (e) {
			if (e instanceof FedError && e.kind === 'network') {
				throw error(503, 'peer server unreachable');
			}
			const parts = fedIdParts(video.id);
			const link = parts ? linkByPrefix(parts.prefix, 'consumer') : null;
			if (link) void runFedSync(link.id);
			throw error(404, 'video not found');
		}
	}

	const watch = getWatch(locals.user.id, video.id);
	// Server-owned watch decisions so every client seeks/marks identically (see watch.ts).
	return json({
		...video, // includes channel_kind — 'movies' tells clients NOT to autoplay-chain (contract §Movies)
		directPlay,
		isVertical,
		// Movies only — the signed 2:3 poster for the detail screen (thumb/playback.poster stay the
		// 16:9 fanart, which is what the player backdrop wants). Null for channel videos/episodes.
		posterUrl: video.poster_path ? signedPath('poster', video.id) : null,
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
