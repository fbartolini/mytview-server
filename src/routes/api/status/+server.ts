import { error, json } from '@sveltejs/kit';
import { scanStatus } from '$lib/server/indexer';
import { libraryCounts } from '$lib/server/queries';
import { listLibraries } from '$lib/server/libraries';
import { hlsEnabled } from '$lib/server/hls';
import { SERVER_VERSION } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	const s = scanStatus();
	const { videos, channels } = libraryCounts(locals.user); // visibility-filtered — no private-channel leak
	return json({
		// Whether the owner has defined any libraries — with none, /media scans as one implicit channels
		// library, and a 0-video result usually means the media ISN'T ytdl-style (movies/shows folders):
		// the empty states use this to say "add a library" instead of the misleading "check MEDIA_ROOT".
		librariesConfigured: listLibraries().length > 0,
		scanning: s.scanning,
		everScanned: s.everScanned,
		error: s.error,
		// Live scan progress ({library, videos, indexed} | null) — feedback while indexing runs, so
		// first boot / a just-added library reads as "working on it", never as broken-empty.
		progress: s.progress,
		// Completed-scan counter (bumps only when a scan CHANGED the index): clients re-fetch their
		// cached lists/nav when it moves — catches even scans faster than their poll interval.
		seq: s.seq,
		videos,
		channels,
		transcoding: 0, // always 0 since the background whole-file transcoder was removed; kept for client shape-compat
		// Mirrors /api/v1/status — one negotiation surface, both API layers (see the v1 route).
		serverVersion: SERVER_VERSION,
		capabilities: ['libraries', 'series', 'movies', 'sessions', 'prefs', 'shares', 'federation', ...(hlsEnabled() ? ['hls'] : [])]
	});
};
