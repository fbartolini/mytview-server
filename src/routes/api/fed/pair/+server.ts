import { json } from '@sveltejs/kit';
import { consumeFedInvite, createSharerLink, serverId } from '$lib/server/federation';
import { rateLimited } from '$lib/server/ratelimit';
import type { RequestHandler } from './$types';

// Server↔server pairing (design §2): the CONSUMER's server redeems a single-use invite the sharer
// owner minted, identifying itself with its persistent serverId + a display name (+ its own base
// URL when it can share back). Response = the sharer's identity + the freshly-minted link secret.
// Rate limit BEFORE any lookup — failed attempts count (invite brute-force ≤ 5/15min/IP vs 192 bits).
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (rateLimited(`fed:pair:${getClientAddress()}`, 5, 15 * 60_000)) {
		return json({ error: 'rate limited' }, { status: 429 });
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid body' }, { status: 400 });
	}
	const b = body as { invite?: unknown; serverId?: unknown; name?: unknown; baseUrl?: unknown };
	const invite = typeof b.invite === 'string' ? b.invite.trim() : '';
	const peerId = typeof b.serverId === 'string' ? b.serverId.trim() : '';
	const name = typeof b.name === 'string' ? b.name.trim().slice(0, 64) : '';
	const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim().slice(0, 256) : null;
	if (!invite || invite.length > 128 || !/^[0-9a-zA-Z-]{8,64}$/.test(peerId) || !name) {
		return json({ error: 'invalid body' }, { status: 400 });
	}
	if (baseUrl && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
		return json({ error: 'invalid baseUrl' }, { status: 400 });
	}
	if (!consumeFedInvite(invite, peerId)) {
		return json({ error: 'invalid invite' }, { status: 403 });
	}
	const { secret } = createSharerLink(peerId, name, baseUrl);
	console.log(`[mytview] federation: paired with "${name}" (${peerId.slice(0, 12)}…) as sharer`);
	return json({ serverId: serverId(), secret });
};
