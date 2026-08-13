import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { authLink, isGranted } from '$lib/server/fedserve';
import { rateLimited } from '$lib/server/ratelimit';
import { resolveInMediaRoot, serveFile } from '$lib/server/files';
import type { RequestHandler } from './$types';

// Art bytes for granted content (?kind=thumb|poster|fanart & video=<id> | channel=<id>): the
// consumer fetches each image ONCE into its own cache and serves it same-origin (design §8).
// Originals only — the consumer downscales locally. Grant re-checked per image.
export const GET: RequestHandler = async ({ request, url }) => {
	const link = authLink(request);
	if (link instanceof Response) return link;
	if (rateLimited(`fed:art:${link.id}`, 1200, 60_000)) return json({ error: 'rate limited' }, { status: 429 });
	const kind = url.searchParams.get('kind');
	const videoId = url.searchParams.get('video');
	const channelId = url.searchParams.get('channel');

	let rel: string | null = null;
	if (videoId && (kind === 'thumb' || kind === 'poster')) {
		const r = db()
			.prepare('SELECT channel_id, thumb_path, poster_path, peer_id FROM videos WHERE id = ?')
			.get(videoId) as
			| { channel_id: string; thumb_path: string | null; poster_path: string | null; peer_id: string | null }
			| undefined;
		if (!r || r.peer_id != null || !isGranted(link.id, r.channel_id)) {
			return json({ error: 'not_shared' }, { status: 404 });
		}
		rel = kind === 'thumb' ? r.thumb_path : r.poster_path;
	} else if (channelId && (kind === 'poster' || kind === 'fanart')) {
		if (!isGranted(link.id, channelId)) return json({ error: 'not_shared' }, { status: 404 });
		const r = db()
			.prepare('SELECT poster_path, fanart_path FROM channels WHERE id = ?')
			.get(channelId) as { poster_path: string | null; fanart_path: string | null } | undefined;
		rel = kind === 'poster' ? (r?.poster_path ?? null) : (r?.fanart_path ?? null);
	} else {
		return json({ error: 'invalid body' }, { status: 400 });
	}

	if (!rel) return json({ error: 'no art' }, { status: 404 });
	try {
		const { absPath, stat } = await resolveInMediaRoot(rel);
		return serveFile(request, absPath, stat);
	} catch {
		return json({ error: 'no art' }, { status: 404 });
	}
};
