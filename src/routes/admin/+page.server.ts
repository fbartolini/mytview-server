import { error } from '@sveltejs/kit';
import { isOwner } from '$lib/server/visibility';
import { stateDb } from '$lib/server/state';
import { listLibraries } from '$lib/server/libraries';
import { listLinks } from '$lib/server/federation';
import { listPlexLinks, plexUrl } from '$lib/server/plexlink';
import { libraryCounts } from '$lib/server/queries';
import { runScan, scanStatus } from '$lib/server/indexer';
import type { Actions, PageServerLoad } from './$types';

/** Owner hub: one entry in the avatar menu instead of one per admin page (the menu was growing with
 *  every feature). Each card carries a live count so the hub doubles as a server overview. */
export const load: PageServerLoad = ({ locals }) => {
	// Owner-only. 404 (not 403) so the admin area isn't even discoverable to other accounts.
	if (!isOwner(locals.user)) throw error(404);
	const users = (stateDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
	const active = (
		stateDb().prepare('SELECT COUNT(*) AS c FROM users WHERE deactivated_at IS NULL').get() as { c: number }
	).c;
	const libs = listLibraries();
	const { videos, channels } = libraryCounts(locals.user);
	const s = scanStatus();
	return {
		libraries: { count: libs.length, phantom: libs.filter((l) => l.virtual).length },
		media: { videos, channels },
		users: { total: users, deactivated: users - active },
		federation: {
			sharing: listLinks('sharer').length,
			consuming: listLinks('consumer').length
		},
		plex: { configured: plexUrl() != null, linked: listPlexLinks().length },
		scan: { scanning: s.scanning, everScanned: s.everScanned, last: s.last }
	};
};

export const actions: Actions = {
	// The heavy re-parse: moved OFF the avatar menu (it was one click from every page) to here,
	// where it sits next to an explanation of what it does.
	fullRescan: async ({ locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		void runScan(true);
		return { ok: true };
	}
};
