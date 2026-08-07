import { fail, redirect } from '@sveltejs/kit';
import { passwordResetTarget, consumePasswordReset, MIN_PASSWORD_LEN } from '$lib/server/auth';
import { rateLimited } from '$lib/server/ratelimit';
import type { Actions, PageServerLoad } from './$types';

// Login-exempt (hooks.server.ts): opened while logged OUT via an owner-issued single-use link.
export const load: PageServerLoad = ({ url }) => {
	const token = url.searchParams.get('token') ?? '';
	const target = passwordResetTarget(token);
	// Echo the token back so the form can POST it; it's already in the URL the user opened.
	return { token, valid: !!target, username: target?.username ?? null };
};

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		// Public endpoint (opened logged-out) — cap redeem attempts so the 256-bit token stays
		// un-brute-forceable in practice too, not just in theory.
		if (rateLimited(`reset:${getClientAddress()}`, 10)) {
			return fail(429, { error: 'Too many attempts — wait a minute and try again.' });
		}
		const form = await request.formData();
		const token = String(form.get('token') ?? '');
		const next = String(form.get('next') ?? '');
		const confirm = String(form.get('confirm') ?? '');

		// Re-validate: the link could have expired or been used between page load and submit.
		if (!passwordResetTarget(token)) {
			return fail(400, { error: 'This reset link is no longer valid — ask the owner for a new one.' });
		}
		if (next.length < MIN_PASSWORD_LEN) {
			return fail(400, { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
		}
		if (next !== confirm) {
			return fail(400, { error: "The passwords don't match." });
		}
		// consumePasswordReset is atomic + single-use; it also revokes the user's existing sessions.
		if (!(await consumePasswordReset(token, next))) {
			return fail(400, { error: 'This reset link is no longer valid — ask the owner for a new one.' });
		}
		throw redirect(303, '/login?reset=1');
	}
};
