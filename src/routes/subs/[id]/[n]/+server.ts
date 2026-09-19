import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveInMediaRoot } from '$lib/server/files';
import { canSeeChannel } from '$lib/server/visibility';
import { shareGrantsMedia } from '$lib/server/share';
import { verifyMedia } from '$lib/server/mediaToken';
import { srtToVtt } from '$lib/server/subtitles';
import { extractEmbeddedVtt, resolveTracks } from '$lib/server/subsembed';
import { readFile } from 'node:fs/promises';
import type { RequestHandler } from './$types';

/**
 * Serve one subtitle sidecar as **WebVTT**, converting SRT on the way out — every client we ship
 * speaks VTT, and almost every sidecar in the wild is SRT.
 *
 * Access mirrors `/media/[id]` exactly, and that is deliberate: a subtitle is part of the video, so
 * anything that would let you watch it lets you read its captions, and nothing else does. Channel
 * visibility, a per-video share token, or a signed media URL (native players) — same three doors,
 * same 404 for a guessed id.
 */
export const GET: RequestHandler = async ({ params, url, cookies, locals }) => {
	const v = db()
		.prepare('SELECT channel_id, peer_id FROM videos WHERE id = ?')
		.get(params.id) as { channel_id: string; peer_id: string | null } | undefined;
	if (!v) throw error(404);
	// Federated rows: the peer serves its own subtitles alongside its own media (we never proxy it).
	if (v.peer_id != null) throw error(404);

	const tok = url.searchParams.get('s');
	const viaShare = !!tok && shareGrantsMedia(tok, params.id, cookies.get(`mv_share_${tok}`) === '1');
	const viaSignedUrl = verifyMedia('media', params.id, url);
	if (!viaShare && !viaSignedUrl && !canSeeChannel(locals.user, v.channel_id)) throw error(404);

	const n = Number(params.n);
	if (!Number.isInteger(n) || n < 0) throw error(404);
	// Same resolver the descriptor used, so index N here is the track the viewer picked there.
	const row = (await resolveTracks(params.id))[n];
	if (!row) throw error(404);

	let body: string;
	if (row.streamIndex != null) {
		// EMBEDDED track: no file to read — ffmpeg extracts the stream to WebVTT (cached).
		const m = db()
			.prepare('SELECT video_path, mtime FROM videos WHERE id = ?')
			.get(params.id) as { video_path: string; mtime: number };
		const vtt = await extractEmbeddedVtt(m.video_path, row.streamIndex, m.mtime);
		if (vtt === null) throw error(404, 'subtitle track could not be extracted');
		body = vtt;
	} else {
		const { absPath } = await resolveInMediaRoot(row.path!);
		const raw = await readFile(absPath, 'utf-8');
		body = absPath.toLowerCase().endsWith('.srt') ? srtToVtt(raw) : raw;
	}
	return new Response(body, {
		headers: {
			'content-type': 'text/vtt; charset=utf-8',
			// Same-origin only; subtitle files are small and change only when the file on disk does.
			'cache-control': 'private, max-age=3600'
		}
	});
};
