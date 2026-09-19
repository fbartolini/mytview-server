import { error } from '@sveltejs/kit';
import { ALLOW_SIGNUP, BUILD_SHA, BUILD_TIME, IMAGE_CACHE_DIR, SERVER_VERSION } from '$lib/server/config';
import { contentStats } from '$lib/server/queries';
import { ffmpegVersion, hlsStatus } from '$lib/server/hls';
import { listLibraries } from '$lib/server/libraries';
import { listLinks } from '$lib/server/federation';
import { getPlexLink, plexUrl } from '$lib/server/plexlink';
import { isOwner } from '$lib/server/visibility';
import { scanStatus } from '$lib/server/indexer';
import type { PageServerLoad } from './$types';

/** About page — the ONE place the project introduces itself to every web user (not just the owner,
 *  who is the only person a GitHub link would ever reach). It is a destination, never a banner:
 *  nobody is nagged, so there is nothing to dismiss and no need to detect who has contributed.
 *  Doubles as app discovery — household members on the web player learn the native apps exist.
 *
 *  It also plays the role the native apps' Settings screen does: what this server holds and what it
 *  can do. The split is deliberate — CAPABILITIES (what playback will do for you, how big your
 *  library is) are for everyone, because they explain the behaviour every user experiences;
 *  CONFIGURATION (host, uptime, caps, peer counts, signup mode) is owner-only, since it's the
 *  server's setup rather than the product's behaviour. Content numbers go through the same
 *  visibility filter as every other read, so nobody learns the size of a library they can't see. */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw error(401);
	const owner = isOwner(locals.user);
	const hls = hlsStatus();
	const ffmpeg = await ffmpegVersion();
	const plexLink = getPlexLink(locals.user.id);
	return {
		version: SERVER_VERSION,
		// Which BUILD is running — the question a version number can't answer between releases.
		build: BUILD_SHA,
		builtAt: BUILD_TIME,
		content: contentStats(locals.user),
		// Every row answers "will this work here?", never "was this configured?" — no ffmpeg on PATH
		// means transcoding and artwork resizing are both dead however the flags are set, and claiming
		// otherwise would send an owner hunting the wrong problem. The owner block names the cause.
		playback: {
			hls: hls.enabled && ffmpeg != null,
			hwaccel: ffmpeg ? hls.hwaccel : 'unavailable',
			imageCache: IMAGE_CACHE_DIR != null && ffmpeg != null,
			ffmpeg
		},
		plex: { configured: plexUrl() != null, linked: plexLink?.plex_username ?? null },
		owner: owner
			? {
					node: process.version,
					platform: `${process.platform}/${process.arch}`,
					uptimeSec: Math.round(process.uptime()),
					libraries: listLibraries().length,
					peers: { sharing: listLinks('sharer').length, consuming: listLinks('consumer').length },
					hlsDevice: hls.device,
					hlsEncoding: hls.encoding,
					hlsMax: hls.maxEncoders,
					signup: ALLOW_SIGNUP,
					lastScan: scanStatus().last
				}
			: null
	};
};
