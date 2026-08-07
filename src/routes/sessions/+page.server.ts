import { error } from '@sveltejs/kit';
import { listSessions, revokeSession, revokeOtherSessions } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

function relPast(ts: number | null, now: number): string {
	if (ts == null) return 'unknown';
	const s = Math.round((now - ts) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw error(401);
	const now = Date.now();
	const sessions = listSessions(locals.user.id, locals.sessionToken).map((s) => ({
		id: s.id,
		label: s.label ?? 'Unknown device',
		current: s.current,
		lastSeenLabel: s.current ? 'active now' : `last active ${relPast(s.lastSeen, now)}`,
		createdLabel: `signed in ${relPast(s.createdAt, now)}`
	}));
	return { sessions };
};

export const actions: Actions = {
	// Both actions are user-scoped inside auth.ts — you can only revoke your OWN sessions.
	revoke: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const id = String((await request.formData()).get('id') ?? '');
		revokeSession(locals.user.id, id);
		return { revoked: true };
	},
	revokeOthers: ({ locals }) => {
		if (!locals.user) throw error(401);
		if (locals.sessionToken) revokeOtherSessions(locals.user.id, locals.sessionToken);
		return { revoked: true };
	}
};
