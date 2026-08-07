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
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// Owner-only. 404 (not 403) so the admin area isn't even discoverable to other accounts.
	if (!isOwner(locals.user)) throw error(404);
	const channels = listChannels(locals.user).map((c) => {
		const v = getChannelVisibility(c.id);
		return { id: c.id, name: c.name, private: v.private, grantedUserIds: v.grantedUserIds };
	});
	return { channels, users: listGrantableUsers() };
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
		return { ok: true, channelId };
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
