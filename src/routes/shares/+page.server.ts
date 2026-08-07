import { error } from '@sveltejs/kit';
import { listSharesByUser, revokeShare } from '$lib/server/share';
import type { Actions, PageServerLoad } from './$types';

function relFuture(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86400) return `in ${Math.round(s / 3600)}h`;
	return `in ${Math.round(s / 86400)}d`;
}

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw error(401);
	const now = Date.now();
	const shares = listSharesByUser(locals.user.id).map((s) => ({
		token: s.token,
		video_id: s.video_id,
		video_title: s.video_title ?? '(video removed)',
		expiresLabel:
			s.expires_at == null
				? 'never expires'
				: s.expires_at <= now
					? 'expired'
					: `expires ${relFuture(s.expires_at - now)}`,
		usesLabel:
			s.max_uses == null
				? `${s.used_count} view${s.used_count === 1 ? '' : 's'}`
				: `${s.used_count} / ${s.max_uses} views`
	}));
	return { shares };
};

export const actions: Actions = {
	revoke: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const token = String((await request.formData()).get('token') ?? '');
		revokeShare(token, locals.user.id); // owner-scoped inside revokeShare
		return { revoked: true };
	}
};
