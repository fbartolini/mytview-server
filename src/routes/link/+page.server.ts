import { fail, error } from '@sveltejs/kit';
import { approveDeviceCode } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, locals }) => {
	if (!locals.user) throw error(401);
	// ?code=XXXX-XXXX lets a QR from the TV pre-fill the field.
	return { code: url.searchParams.get('code') ?? '', username: locals.user.username };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const code = String(form.get('code') ?? '').trim();
		if (!code) return fail(400, { error: 'Enter the code shown on your TV.', code });

		const result = approveDeviceCode(code, locals.user.id);
		if (result === 'ok') return { success: true };
		const messages: Record<string, string> = {
			not_found: "That code wasn't found — check it and try again.",
			expired: 'That code has expired. Start again on your TV.',
			already: 'That code was already approved.'
		};
		return fail(400, { error: messages[result] ?? 'Could not approve that code.', code });
	}
};
