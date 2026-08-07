import type { LayoutServerLoad } from './$types';
import { isOwner, canInvite } from '$lib/server/visibility';
import { listLibraries } from '$lib/server/libraries';
import { visibleLibraryIds } from '$lib/server/queries';

export const load: LayoutServerLoad = ({ locals }) => {
	const user = locals.user;
	// Per-library nav tabs, but only libraries this user can actually see media in (≥1 visible channel
	// with videos, regardless of watched state) — an all-private or empty library is hidden entirely.
	// Empty → the header falls back to a single generic "Channels" link. Nav needs only id/name/format.
	const vis = visibleLibraryIds(user);
	const libraries = user
		? listLibraries()
				.filter((l) => vis.has(l.id))
				.map((l) => ({ id: l.id, name: l.name, format: l.format }))
		: [];
	return {
		user,
		isOwner: isOwner(user),
		canInvite: canInvite(user),
		libraries
	};
};
