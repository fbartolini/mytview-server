import { error, json } from '@sveltejs/kit';
import { createSession, describeClient } from '$lib/server/auth';
import { externalOrigin } from '$lib/server/origin';
import type { RequestHandler } from './$types';

// Mint a NEW bearer token for ANOTHER device, on behalf of the already-authenticated caller. This is
// the primitive behind QR TV-linking (see docs/native-clients-plan.md → mytview.com pairing broker):
// a signed-in phone scans the TV's QR, calls this to issue an INDEPENDENT session for the TV, and
// relays {baseUrl, token} to it through the broker — so the linked TV is separately revocable and the
// phone never shares its own token. The server itself never talks to the broker; it just issues a
// token to a client it already trusts. Auth: bearer token or cookie (the caller must be signed in).
export const POST: RequestHandler = async (event) => {
	const { locals, request } = event;
	if (!locals.user) throw error(401);
	// The QR-linked device's name is only known to the phone doing the linking, so let it pass a
	// `label` (from the QR payload); fall back to a generic name for the manage-devices list.
	const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
	const label =
		typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : 'Linked device';
	const token = createSession(locals.user.id, describeClient(null, label));
	// Fixed phones seal their OWN known-good address into the broker payload and ignore this baseUrl; a
	// pre-fix phone relays it to the TV verbatim, so emit the external host (proxy-aware) rather than the
	// internal url.origin — otherwise the TV inherits the container name. See base-URL authority contract.
	return json({
		token,
		user: { id: locals.user.id, username: locals.user.username },
		baseUrl: externalOrigin(event)
	});
};
