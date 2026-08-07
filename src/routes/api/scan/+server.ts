import { error, json } from '@sveltejs/kit';
import { runScan, scanStatus } from '$lib/server/indexer';
import { isOwner } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

// `?full=1` forces a full re-parse (ignores mtime) — re-derives thumb_path + all metadata for every
// video, self-healing stale references (e.g. a thumbnail the source later removed). Default is the
// fast incremental scan.
//
// A full re-parse is EXPENSIVE (whole library, ignores mtime), so it's OWNER-ONLY — mirroring the web UI,
// which shows "Full rescan" to the owner only. Without this any signed-in user (or bearer token) could
// force it: a privilege-escalation / DoS. The cheap mtime-gated incremental scan stays open to any user
// (the web "Rescan library" button is ungated), and the scan lock already prevents concurrent runs.
export const POST: RequestHandler = async ({ url, locals }) => {
	const full = url.searchParams.get('full') === '1';
	if (full && !isOwner(locals.user)) throw error(403, 'full re-parse is owner-only');
	return json(
		(await runScan(full)) ??
			scanStatus().last ?? { channels: 0, videos: 0, indexed: 0, pruned: 0, elapsed_s: 0 }
	);
};
