import { json } from '@sveltejs/kit';
import path from 'node:path';
import { db } from '$lib/server/db';
import { authLink, isGranted } from '$lib/server/fedserve';
import { rateLimited } from '$lib/server/ratelimit';
import { signedPath, signedHlsIndex } from '$lib/server/mediaToken';
import { hlsEnabled } from '$lib/server/hls';
import { linkTag, noteServe } from '$lib/server/fedmeter';
import type { RequestHandler } from './$types';

// Playback capability URLs for ONE granted video (design §4): RELATIVE signed paths the consumer
// absolutizes against this link's stored base_url and ships in its own playback descriptor. Media
// keeps the default 12h window (AVPlayer URL reuse); HLS gets the tighter 2h share-viewer window.
// The signed URL itself is then the credential — /media and /hls need no link auth to stream.
export const POST: RequestHandler = async ({ request }) => {
	const link = authLink(request);
	if (link instanceof Response) return link;
	if (rateLimited(`fed:url:${link.id}`, 120, 60_000)) return json({ error: 'rate limited' }, { status: 429 });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid body' }, { status: 400 });
	}
	const videoId = typeof (body as { videoId?: unknown }).videoId === 'string' ? (body as { videoId: string }).videoId : '';
	if (!videoId) return json({ error: 'invalid body' }, { status: 400 });
	const row = db()
		.prepare('SELECT channel_id, video_path, peer_id FROM videos WHERE id = ?')
		.get(videoId) as { channel_id: string; video_path: string; peer_id: string | null } | undefined;
	if (!row || row.peer_id != null || !isGranted(link.id, row.channel_id)) {
		return json({ error: 'not_shared' }, { status: 404 });
	}
	// The link tag rides INSIDE the MAC (mediaToken.ts) — the media/HLS routes attribute + cap the
	// resulting streams per peer (fedmeter.ts), and a mint ≈ one play start for the analytics.
	noteServe(link.id, 'mint');
	return json({
		url: signedPath('media', videoId, { tag: linkTag(link.id) }),
		hlsUrl: hlsEnabled() ? signedHlsIndex(videoId, 2 * 3600, linkTag(link.id)) : null,
		ext: path.extname(row.video_path)
	});
};
