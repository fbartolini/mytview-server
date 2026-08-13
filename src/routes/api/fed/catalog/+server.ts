import { json } from '@sveltejs/kit';
import { authLink, catalogChannels, sharedLibraries } from '$lib/server/fedserve';
import { serverId } from '$lib/server/federation';
import { rateLimited } from '$lib/server/ratelimit';
import type { RequestHandler } from './$types';

// The granted catalog for the calling link: shared libraries (what the consumer's owner maps) +
// granted channels with per-channel {video_count, max_mtime} change-skip stats. Metadata only —
// videos are fetched per channel (/api/fed/videos), art per image (/api/fed/art).
export const GET: RequestHandler = ({ request }) => {
	const link = authLink(request);
	if (link instanceof Response) return link;
	if (rateLimited(`fed:cat:${link.id}`, 30, 60_000)) return json({ error: 'rate limited' }, { status: 429 });
	return json({
		serverId: serverId(),
		libraries: sharedLibraries(link.id),
		channels: catalogChannels(link.id)
	});
};
