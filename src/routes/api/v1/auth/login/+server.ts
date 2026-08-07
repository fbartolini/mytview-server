import { error, json } from '@sveltejs/kit';
import { findUser, verifyPassword, DUMMY_HASH, createSession, sessionLabelFromRequest } from '$lib/server/auth';
import { rateLimited } from '$lib/server/ratelimit';
import { externalOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

// Bearer-token login for native clients (Apple TV / Google TV). Reuses the same opaque
// session tokens as the web cookie session — see src/lib/server/auth.ts. The client stores
// the token (Keychain / DataStore) and sends it as `Authorization: Bearer <token>`.
//
// WS-A hardening — per-device, hashed, expiring, revocable tokens — is tracked in
// docs/native-clients-plan.md and NOT done yet; today this mints a non-expiring session.
export const POST: RequestHandler = async (event) => {
	const { request } = event;
	const body = (await request.json().catch(() => null)) as
		| { username?: unknown; password?: unknown }
		| null;
	const username = typeof body?.username === 'string' ? body.username.trim() : '';
	const password = typeof body?.password === 'string' ? body.password : '';
	if (!username || !password) throw error(400, 'username and password are required');
	// Same brute-force damper + timing-neutral verify as the web login (see login/+page.server.ts).
	if (rateLimited(`login:ip:${event.getClientAddress()}`, 20) || rateLimited(`login:u:${username.toLowerCase()}`, 10)) {
		throw error(429, 'too many attempts — wait a minute and try again');
	}
	const user = findUser(username);
	const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
	if (!user || !ok) {
		throw error(401, 'invalid username or password');
	}
	// A deactivated account can't sign in anywhere — same generic message (don't confirm it exists).
	if (user.deactivated_at != null) throw error(401, 'invalid username or password');

	const token = createSession(user.id, sessionLabelFromRequest(request));
	// baseUrl = the externally-reachable origin. New clients ignore this (they keep the address the user
	// typed — see the base-URL authority contract), but already-shipped clients still adopt it, so emit
	// the proxy-aware external host, not the internal one url.origin sees.
	return json({ token, user: { id: user.id, username: user.username }, baseUrl: externalOrigin(event) });
};
