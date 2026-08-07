import { fail, error } from '@sveltejs/kit';
import {
	findUser,
	verifyPassword,
	setPassword,
	revokeOtherSessions,
	MIN_PASSWORD_LEN
} from '$lib/server/auth';
import { isOwner } from '$lib/server/visibility';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw error(401);
	return { username: locals.user.username, isOwner: isOwner(locals.user) };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const current = String(form.get('current') ?? '');
		const next = String(form.get('next') ?? '');
		const confirm = String(form.get('confirm') ?? '');

		// locals.user carries no hash — re-read it to check the CURRENT password before changing it.
		const u = findUser(locals.user.username);
		if (!u || !(await verifyPassword(current, u.password_hash))) {
			return fail(400, { error: 'Your current password is wrong.' });
		}
		if (next.length < MIN_PASSWORD_LEN) {
			return fail(400, { error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` });
		}
		if (next !== confirm) {
			return fail(400, { error: "The new passwords don't match." });
		}
		if (next === current) {
			return fail(400, { error: 'The new password must be different from the current one.' });
		}

		await setPassword(u.id, next);
		// A password change should lock out whatever had the old one: sign out every OTHER device but
		// keep THIS session so the user isn't bounced. (Only if we know the current token — we always do
		// for a logged-in web request.)
		const killed = locals.sessionToken ? revokeOtherSessions(u.id, locals.sessionToken) : 0;
		return { ok: true, killed };
	}
};
