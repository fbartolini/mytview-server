import { error, json } from '@sveltejs/kit';
import { scanStatus } from '$lib/server/indexer';
import { libraryCounts } from '$lib/server/queries';
import { hlsEnabled } from '$lib/server/hls';
import { SERVER_VERSION } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	const s = scanStatus();
	const { videos, channels } = libraryCounts(locals.user); // visibility-filtered — no private-channel leak
	return json({
		scanning: s.scanning,
		everScanned: s.everScanned,
		error: s.error,
		videos,
		channels,
		transcoding: 0, // always 0 since the background whole-file transcoder was removed; kept for client shape-compat
		// Mirrors /api/v1/status — one negotiation surface, both API layers (see the v1 route).
		serverVersion: SERVER_VERSION,
		capabilities: ['libraries', 'series', 'movies', 'sessions', 'prefs', 'shares', ...(hlsEnabled() ? ['hls'] : [])]
	});
};
