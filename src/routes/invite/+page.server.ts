import { error } from '@sveltejs/kit';
import { createInvite, listInvites } from '$lib/server/auth';
import { canInvite } from '$lib/server/visibility';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw error(401);
	if (!canInvite(locals.user)) throw error(403, 'Only the owner can invite people on this server.');
	return { invites: listInvites(locals.user.id) };
};

export const actions: Actions = {
	default: ({ locals }) => {
		if (!locals.user) throw error(401);
		if (!canInvite(locals.user)) throw error(403);
		return { token: createInvite(locals.user.id) };
	}
};
