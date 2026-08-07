import { error, fail } from '@sveltejs/kit';
import {
	listUsers,
	userById,
	createPasswordReset,
	deactivateUser,
	reactivateUser,
	deleteUser
} from '$lib/server/auth';
import { isOwner, ownerId } from '$lib/server/visibility';
import { externalOrigin } from '$lib/server/origin';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	// Owner-only. 404 (not 403) so the admin area isn't even discoverable to other accounts.
	if (!isOwner(locals.user)) throw error(404);
	const oid = ownerId();
	return { users: listUsers().map((u) => ({ ...u, isOwner: u.id === oid })) };
};

/** Parse + validate the target user id from a form, rejecting the owner account for destructive ops.
 *  Only the owner reaches these actions, and the owner is the id-lowest user, so `ownerId()` is the one
 *  account that must never be suspended/deleted (that would brick the install). Returns the id or a fail. */
function target(form: FormData, protectOwner: boolean) {
	const id = Number(form.get('userId'));
	if (!Number.isInteger(id) || !userById(id)) return { error: 'No such user.' as const };
	if (protectOwner && id === ownerId()) return { error: 'The owner account is protected.' as const };
	return { id };
}

export const actions: Actions = {
	// Generate a single-use reset link for a user; the owner copies it and sends it out-of-band.
	reset: async (event) => {
		const { request, locals } = event;
		if (!isOwner(locals.user)) throw error(403);
		const t = target(await request.formData(), false);
		if ('error' in t) return fail(400, { error: t.error });
		const token = createPasswordReset(t.id, locals.user!.id);
		const u = userById(t.id)!;
		return { resetLink: `${externalOrigin(event)}/reset?token=${token}`, resetUser: u.username };
	},

	deactivate: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const t = target(await request.formData(), true);
		if ('error' in t) return fail(400, { error: t.error });
		deactivateUser(t.id);
		return { ok: true };
	},

	reactivate: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const t = target(await request.formData(), false);
		if ('error' in t) return fail(400, { error: t.error });
		reactivateUser(t.id);
		return { ok: true };
	},

	delete: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const t = target(await request.formData(), true);
		if ('error' in t) return fail(400, { error: t.error });
		deleteUser(t.id);
		return { ok: true };
	}
};
