import { error, json } from '@sveltejs/kit';
import { redeemDeviceCode, sessionLabelFromRequest } from '$lib/server/auth';
import { rateLimited } from '$lib/server/ratelimit';
import { externalOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

// Step 3 of device pairing (public). The TV polls with its device_code at `interval`
// seconds: 200 {status:"pending"} while unapproved, 200 {status:"approved", token, ...}
// once the user approves at /link, 410 {status:"expired"} if it lapsed (restart the flow).
export const POST: RequestHandler = async (event) => {
	const { request } = event;
	// The legit poll cadence is one per `interval` (5s) → ≤12/min; 60 leaves headroom for a household
	// pairing several devices while still capping a brute-force loop against device_code.
	if (rateLimited(`devpoll:${event.getClientAddress()}`, 60)) throw error(429, 'polling too fast');
	const body = (await request.json().catch(() => null)) as { device_code?: unknown } | null;
	const deviceCode = typeof body?.device_code === 'string' ? body.device_code : '';
	if (!deviceCode) throw error(400, 'device_code is required');

	const r = redeemDeviceCode(deviceCode, sessionLabelFromRequest(request));
	if (r.status === 'approved') {
		// New clients keep the address the user typed on the TV; older ones adopt this — emit the external
		// host (proxy-aware), not url.origin's internal view. See the base-URL authority contract.
		return json({ status: 'approved', token: r.token, user: r.user, baseUrl: externalOrigin(event) });
	}
	if (r.status === 'expired') {
		return json({ status: 'expired' }, { status: 410 });
	}
	return json({ status: 'pending' });
};
