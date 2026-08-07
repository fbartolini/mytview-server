import { error, json } from '@sveltejs/kit';
import { approveDeviceCode } from '$lib/server/auth';
import type { RequestHandler } from './$types';

// Approve a pending device code on behalf of the SIGNED-IN native user — the /api/v1 equivalent of the
// web /link form. Lets a phone app ("Link a TV") pair a device-code TV (Google TV / Tizen, or the tvOS
// manual fallback) by scanning its `…/link?code=…` QR. Auth required (only a signed-in user can approve).
// Returns { status } ∈ ok | not_found | expired | already.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401);
	const body = (await request.json().catch(() => null)) as { user_code?: unknown } | null;
	const userCode = typeof body?.user_code === 'string' ? body.user_code : '';
	if (!userCode) throw error(400, 'user_code is required');
	return json({ status: approveDeviceCode(userCode, locals.user.id) });
};
