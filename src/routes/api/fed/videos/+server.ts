import { json } from '@sveltejs/kit';
import { authLink, exportVideos, isGranted } from '$lib/server/fedserve';
import { rateLimited } from '$lib/server/ratelimit';
import type { RequestHandler } from './$types';

// Full metadata for ONE granted channel's videos (?channel=<remote id>). Grant re-checked here —
// a revoked channel 404s as not_shared regardless of what an older catalog said.
export const GET: RequestHandler = ({ request, url }) => {
	const link = authLink(request);
	if (link instanceof Response) return link;
	if (rateLimited(`fed:vid:${link.id}`, 1200, 60_000)) return json({ error: 'rate limited' }, { status: 429 });
	const channelId = url.searchParams.get('channel');
	if (!channelId) return json({ error: 'invalid body' }, { status: 400 });
	if (!isGranted(link.id, channelId)) return json({ error: 'not_shared' }, { status: 404 });
	return json({ items: exportVideos(channelId) });
};
