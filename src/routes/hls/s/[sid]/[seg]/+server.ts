import { error } from '@sveltejs/kit';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { verifyMedia } from '$lib/server/mediaToken';
import { hlsSegment, hlsInit, hlsSessionFed } from '$lib/server/hls';
import { noteStream, noteServe } from '$lib/server/fedmeter';
import type { RequestHandler } from './$types';

// One HLS segment (MPEG-TS) of a live-transcode session. `params.sid` is the capability; the signed
// `?k=&exp=` keyed to it is verified too. Ensures the encode covers the segment (start / restart-at-offset
// / wait), then streams it. 503 when concurrency-capped, timed out, or the session was idle-GC'd.
export const GET: RequestHandler = async ({ params, url }) => {
	// TS or fMP4 segment, or the fMP4 init section (contract §HLS `fmt=fmp4`).
	const m = params.seg.match(/^seg(\d+)\.(ts|m4s)$/);
	const isInit = params.seg === 'init.mp4';
	if (!m && !isInit) throw error(404);
	if (!verifyMedia('hls', params.sid, url)) throw error(404);
	const path = isInit ? await hlsInit(params.sid) : await hlsSegment(params.sid, parseInt(m![1], 10));
	const contentType = isInit ? 'video/mp4' : m![2] === 'm4s' ? 'video/iso.segment' : 'video/mp2t';
	// At capacity / timed out: a service condition the client should RETRY, not a failure — say when.
	if (!path) return new Response('segment unavailable', { status: 503, headers: { 'retry-after': '30' } });
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
		headers: { 'content-type': contentType, 'cache-control': 'no-store' }
	});
};
