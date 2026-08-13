import { error, json } from '@sveltejs/kit';
import { scanStatus } from '$lib/server/indexer';
import { libraryCounts } from '$lib/server/queries';
import { hlsEnabled } from '$lib/server/hls';
import { SERVER_VERSION } from '$lib/server/config';
import type { RequestHandler } from './$types';

// Server-owned library/scan state for native clients: lets them tell "still indexing" from "empty"
// on first run (everScanned/scanning) and show library totals — counts are visibility-filtered, so
// private channels never leak. Mirrors /api/status; kept on /api/v1 so bearer clients don't need a cookie.
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	const s = scanStatus();
	const { videos, channels } = libraryCounts(locals.user);
	return json({
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
		// Version negotiation, additive-only: clients feature-gate on `capabilities` membership (and can
		// show serverVersion in diagnostics) instead of probing endpoints and guessing from 404s. New
		// server features append a name here; nothing is ever removed once shipped.
		serverVersion: SERVER_VERSION,
		capabilities: ['libraries', 'series', 'movies', 'sessions', 'prefs', 'shares', 'federation', ...(hlsEnabled() ? ['hls'] : [])]
	});
};
