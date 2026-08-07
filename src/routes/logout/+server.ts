import { redirect } from '@sveltejs/kit';
import { deleteSession, SESSION_COOKIE, cookieOpts } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) deleteSession(token);
	cookies.delete(SESSION_COOKIE, { path: cookieOpts.path });
	throw redirect(303, '/login');
};
