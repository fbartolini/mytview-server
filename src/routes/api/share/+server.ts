import { error, json } from '@sveltejs/kit';
import { createShare, SHARE_TTLS, type ShareTtl } from '$lib/server/share';
import { canSeeVideo } from '$lib/server/visibility';
import { externalOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

// Owner-only (behind the login guard). Creates a public share link for one video.
export const POST: RequestHandler = async (event) => {
	const { request, locals } = event;
	if (!locals.user) throw error(401);
	const body = (await request.json().catch(() => ({}))) as {
		videoId?: unknown;
		ttl?: unknown;
		maxUses?: unknown;
	};
	const videoId = typeof body.videoId === 'string' ? body.videoId : '';
	// The sharer must be able to see the video (owner always can) — no sharing a private channel
	// you weren't granted; canSeeVideo also fails closed on an unknown id.
	if (!videoId || !canSeeVideo(locals.user, videoId)) throw error(400, 'unknown video');

	const ttl: ShareTtl = SHARE_TTLS.includes(body.ttl as ShareTtl) ? (body.ttl as ShareTtl) : '7d';
	// only 1 / 5 / unlimited(null) are offered; anything else → unlimited
	const maxUses = body.maxUses === 1 || body.maxUses === 5 ? body.maxUses : null;

	const token = createShare(locals.user.id, videoId, ttl, maxUses);
	// A share link is sent to OTHER people, so it must be the externally-reachable host (proxy-aware) —
	// url.origin would emit the container's internal name behind a reverse proxy. See externalOrigin.
	return json({ token, url: `${externalOrigin(event)}/s/${token}` });
};
