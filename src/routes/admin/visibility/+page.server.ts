import { error, fail } from '@sveltejs/kit';
import { listChannels } from '$lib/server/queries';
import {
	isOwner,
	ownerId,
	getChannelVisibility,
	setChannelPrivate,
	setChannelGrants,
	grantUserAllPrivateChannels,
	revokeUserAllChannels,
	setAllChannelsPrivate,
	setAllChannelsPublic,
	listGrantableUsers
} from '$lib/server/visibility';
import {
	listLinks,
	grantedChannelIds,
	grantedLibraryIds,
	setLinkChannelGrant,
	setLinkLibraryGrant
} from '$lib/server/federation';
import { listLibraries } from '$lib/server/libraries';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// Owner-only. 404 (not 403) so the admin area isn't even discoverable to other accounts.
	if (!isOwner(locals.user)) throw error(404);
	const channels = listChannels(locals.user).map((c) => {
		const v = getChannelVisibility(c.id);
		return {
			id: c.id,
			name: c.name,
			library_id: c.library_id ?? null,
			private: v.private,
			grantedUserIds: v.grantedUserIds
		};
	});
	// Federation links appear as additional SHARE principals ("one more user"): per-channel grants
	// plus whole-library grants (current + future — fed_library_grants). Secrets never leave here.
	const links = listLinks('sharer').map((l) => ({
		id: l.id,
		name: l.peer_name,
		grantedChannelIds: [...grantedChannelIds(l.id)],
		grantedLibraryIds: [...grantedLibraryIds(l.id)]
	}));
	return {
		channels,
		users: listGrantableUsers(),
		links,
		libraries: listLibraries().map((l) => ({ id: l.id, name: l.name, format: l.format }))
	};
};

export const actions: Actions = {
	setVisibility: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const channelId = String(data.get('channelId') ?? '');
		if (!channelId) return fail(400, { error: 'missing channel' });
		const priv = data.get('private') != null; // the checkbox only submits when checked
		const grants = data
			.getAll('grant')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n));
		setChannelPrivate(channelId, priv);
		setChannelGrants(channelId, priv ? grants : []); // public → no grants
		// Federation columns ride the same row form: `fedgrant` = link ids that should have THIS
		// channel. Independent of the private flag (fed sharing is allow-list, never default-on).
		// A library-covered checkbox is disabled → not submitted → the redundant channel grant is
		// dropped here, while the library grant keeps the channel effectively shared (fedserve).
		const fedGranted = new Set(data.getAll('fedgrant').map(String));
		for (const l of listLinks('sharer')) setLinkChannelGrant(l.id, channelId, fedGranted.has(String(l.id)));
		return { ok: true, channelId };
	},

	// Whole-library federation grant toggle: current AND FUTURE content of the library (the
	// library-section header control in the matrix).
	setFedLibraryGrant: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const linkId = Number(data.get('linkId'));
		const libraryId = Number(data.get('libraryId'));
		const on = String(data.get('on') ?? '') === '1';
		const link = Number.isInteger(linkId) ? listLinks('sharer').find((l) => l.id === linkId) : null;
		if (!link || !Number.isInteger(libraryId) || libraryId <= 0) return fail(400, { error: 'bad request' });
		setLinkLibraryGrant(linkId, libraryId, on);
		return { ok: true };
	},

	// Bulk "share everything / nothing" for ONE user across all private channels (select-all per user).
	setUserGrants: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const userId = Number(data.get('userId'));
		const mode = String(data.get('mode') ?? '');
		if (!Number.isInteger(userId) || userId <= 0) return fail(400, { error: 'bad user' });
		if (userId === ownerId()) return fail(400, { error: 'the owner already sees everything' });
		if (mode !== 'all' && mode !== 'none') return fail(400, { error: 'bad mode' });
		if (mode === 'all') grantUserAllPrivateChannels(userId);
		else revokeUserAllChannels(userId);
		return { bulk: true, userId, mode };
	},

	// Bulk visibility for the whole library: make every channel private, or every channel public.
	setAllVisibility: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const mode = String((await request.formData()).get('mode') ?? '');
		if (mode !== 'private' && mode !== 'public') return fail(400, { error: 'bad mode' });
		if (mode === 'private') setAllChannelsPrivate();
		else setAllChannelsPublic();
		return { bulkAll: true, mode };
	}
};
