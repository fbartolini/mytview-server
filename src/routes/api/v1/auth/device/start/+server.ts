import { error, json } from '@sveltejs/kit';
import { createDeviceCode } from '$lib/server/auth';
import { rateLimited } from '$lib/server/ratelimit';
import { externalOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

// Step 1 of device pairing (public — the TV has no token yet). The TV shows the
// user_code + verification_url, then polls /api/v1/auth/device/poll with device_code.
export const POST: RequestHandler = (event) => {
	// Each call inserts a device_codes row — cap the mint rate so an unauthenticated loop can't
	// grow the table (expired rows are GC'd, but only every 15 min as they lapse).
	if (rateLimited(`devstart:${event.getClientAddress()}`, 10)) throw error(429, 'too many pairing attempts');
	const dc = createDeviceCode();
	// The verification URL is displayed/QR-encoded for the user to open on their PHONE, so it must be
	// the externally-reachable host — url.origin would print the container's internal name behind a proxy
	// and the phone couldn't reach it. externalOrigin honours the reverse proxy's forwarded host.
	const verificationUrl = `${externalOrigin(event)}/link`;
	return json({
		device_code: dc.deviceCode,
		user_code: dc.userCode,
		verification_url: verificationUrl,
		verification_url_complete: `${verificationUrl}?code=${encodeURIComponent(dc.userCode)}`,
		interval: dc.intervalS,
		expires_in: dc.expiresInS
	});
};
