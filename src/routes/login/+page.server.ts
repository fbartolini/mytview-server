import { fail, redirect } from '@sveltejs/kit';
import {
	findUser,
	verifyPassword,
	DUMMY_HASH,
	createSession,
	sessionLabelFromRequest,
	SESSION_COOKIE,
	cookieOpts
} from '$lib/server/auth';
import { rateLimited } from '$lib/server/ratelimit';
import type { Actions, PageServerLoad } from './$types';

/** Only ever return to a local path — never an open redirect to another origin (blocks //evil, /\evil). */
function safeNext(next: string | null | undefined): string {
	return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next'));
	if (locals.user) throw redirect(303, next);
	// `next`: where a bounced request (expired session) wants to return — carried through the form below.
	return { reset: url.searchParams.get('reset') === '1', next };
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const form = await request.formData();
		const username = String(form.get('username') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const next = safeNext(String(form.get('next') ?? ''));
		if (!username || !password) {
			return fail(400, { error: 'Enter a username and password.', username });
		}
		// Best-effort brute-force damper: per client address AND per target account (so a distributed
		// guess against one username is still capped). Generous enough that a human never hits it.
		if (rateLimited(`login:ip:${getClientAddress()}`, 20) || rateLimited(`login:u:${username.toLowerCase()}`, 10)) {
			return fail(429, { error: 'Too many attempts — wait a minute and try again.', username });
		}
		const u = findUser(username);
		// Verify against a dummy hash when the user doesn't exist — same scrypt cost either way, so
		// response timing can't confirm which usernames are real (see DUMMY_HASH).
		const ok = await verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
		if (!u || !ok) {
			return fail(400, { error: 'Wrong username or password.', username });
		}
		if (u.deactivated_at != null) {
			// Same generic wording as a bad password — don't confirm the account exists.
			return fail(400, { error: 'Wrong username or password.', username });
		}
		cookies.set(SESSION_COOKIE, createSession(u.id, sessionLabelFromRequest(request)), cookieOpts);
		throw redirect(303, next);
	}
};
