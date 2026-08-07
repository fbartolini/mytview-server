import { error, json } from '@sveltejs/kit';
import { createWebLoginCode } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// Bearer-authed: a signed-in native client mints a single-use code, then opens
// `/link/web?code=…&to=…` in an in-app browser to reach the (cookie-only) web admin pages
// already signed in. The code is short-lived + single-use (see auth.ts).
export const POST: RequestHandler = ({ locals }) => {
	if (!locals.user) throw error(401);
	return json({ code: createWebLoginCode(locals.user.id) });
};
