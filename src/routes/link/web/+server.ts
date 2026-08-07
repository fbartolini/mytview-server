import { error, redirect } from '@sveltejs/kit';
import {
	redeemWebLoginCode,
	createSession,
	sessionLabelFromRequest,
	SESSION_COOKIE,
	cookieOpts
} from '$lib/server/auth';
import type { RequestHandler } from './$types';

// Browser landing for the native owner-admin punch-out. The app opens this URL (login-exempt in
// hooks) with a single-use `code` minted over its bearer API; we trade it for a WEB session cookie
// and redirect to the requested admin page. `to` is whitelisted to the punch-out targets so this
// can't be turned into an open redirect.
const ALLOWED_TARGETS = new Set(['/admin/visibility', '/invite', '/shares', '/sessions']);

export const GET: RequestHandler = ({ url, cookies, request }) => {
	const code = url.searchParams.get('code') ?? '';
	const requested = url.searchParams.get('to') ?? '/';
	const to = ALLOWED_TARGETS.has(requested) ? requested : '/';

	const userId = redeemWebLoginCode(code);
	if (userId == null) {
		throw error(401, 'This link has expired. Open the page again from the app.');
	}

	cookies.set(SESSION_COOKIE, createSession(userId, sessionLabelFromRequest(request)), cookieOpts);
	throw redirect(303, to);
};
