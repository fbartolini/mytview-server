import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { verifyMedia } from '$lib/server/mediaToken';
import { hlsSegment } from '$lib/server/hls';
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
	return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
		headers: { 'content-type': 'video/mp2t', 'cache-control': 'no-store' }
	});
};
