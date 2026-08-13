import { error } from '@sveltejs/kit';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { verifyMedia } from '$lib/server/mediaToken';
import { hlsSegment, hlsSessionFed } from '$lib/server/hls';
import { noteStream, noteServe } from '$lib/server/fedmeter';
import type { RequestHandler } from './$types';

// One HLS segment (MPEG-TS) of a live-transcode session. `params.sid` is the capability; the signed
// `?k=&exp=` keyed to it is verified too. Ensures the encode covers the segment (start / restart-at-offset
// / wait), then streams it. 503 when concurrency-capped, timed out, or the session was idle-GC'd.
export const GET: RequestHandler = async ({ params, url }) => {
	const m = params.seg.match(/^seg(\d+)\.ts$/);
	if (!m) throw error(404);
	if (!verifyMedia('hls', params.sid, url)) throw error(404);
	const path = await hlsSegment(params.sid, parseInt(m[1], 10));
	if (!path) throw error(503, 'segment unavailable');
	// Federated session: keep the stream marked live + meter the segment bytes (fedmeter.ts). The
	// cap was enforced at the index; an active stream is never cut mid-play.
	const fed = hlsSessionFed(params.sid);
	if (fed) {
		noteStream(fed.linkId, fed.key);
		try {
			noteServe(fed.linkId, 'hls', statSync(path).size);
		} catch {
			noteServe(fed.linkId, 'hls');
		}
	}
	return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
		headers: { 'content-type': 'video/mp2t', 'cache-control': 'no-store' }
	});
};
