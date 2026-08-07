import { fail, redirect } from '@sveltejs/kit';
import {
	findUser,
	createUser,
	createSession,
	sessionLabelFromRequest,
	inviteValid,
	consumeInvite,
	userCount,
	MIN_PASSWORD_LEN,
	SESSION_COOKIE,
	cookieOpts
} from '$lib/server/auth';
import { ALLOW_SIGNUP } from '$lib/server/config';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) throw redirect(303, '/');
	return {
		mode: ALLOW_SIGNUP,
		bootstrap: userCount() === 0, // first account needs no invite
		invite: url.searchParams.get('invite') ?? ''
	};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const bootstrap = userCount() === 0;
		if (ALLOW_SIGNUP === 'off' && !bootstrap) {
			return fail(403, { error: 'Signups are disabled on this server.' });
		}

		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const invite = String(form.get('invite') ?? '').trim();

		const needInvite = ALLOW_SIGNUP === 'invite' && !bootstrap;
		if (needInvite && !inviteValid(invite)) {
			return fail(403, { error: 'A valid invite is required to sign up.', username, invite });
		}
		if (username.length < 2) {
			return fail(400, { error: 'Username must be at least 2 characters.', username, invite });
		}
		if (password.length < MIN_PASSWORD_LEN) {
			return fail(400, {
				error: `Password must be at least ${MIN_PASSWORD_LEN} characters.`,
				username,
				invite
			});
		}
		if (findUser(username)) {
			return fail(400, { error: 'That username is taken.', username, invite });
		}

		const u = await createUser(username, password);
		if (needInvite) consumeInvite(invite, u.id);
		cookies.set(SESSION_COOKIE, createSession(u.id, sessionLabelFromRequest(request)), cookieOpts);
		throw redirect(303, '/');
	}
};
