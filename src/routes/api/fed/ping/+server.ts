import { json } from '@sveltejs/kit';
import { authLink } from '$lib/server/fedserve';
import { serverId } from '$lib/server/federation';
import { rateLimited } from '$lib/server/ratelimit';
import { SERVER_VERSION } from '$lib/server/config';
import type { RequestHandler } from './$types';

// Link liveness/health for the consumer's admin page.
export const GET: RequestHandler = ({ request }) => {
	const link = authLink(request);
	if (link instanceof Response) return link;
	if (rateLimited(`fed:ping:${link.id}`, 30, 60_000)) return json({ error: 'rate limited' }, { status: 429 });
	return json({ ok: true, serverId: serverId(), serverVersion: SERVER_VERSION });
};
