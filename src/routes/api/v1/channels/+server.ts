import { error, json } from '@sveltejs/kit';
import { listChannels } from '$lib/server/queries';
import { signChannelArt } from '$lib/server/mediaToken';
import { hiddenChannelIds } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

// All channels (for the Channels grid), each with its video_count + ready-to-render signed
// poster/fanart URLs, plus this user's personal `isHidden` (unsubscribed-from-feed) flag so the
// client can show a Subscribe/Unsubscribe control. Auth: bearer or cookie.
export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.user) throw error(401);
	// Optional ?library=<id> scopes the grid to one configured library (mirrors the web nav).
	const raw = url.searchParams.get('library');
	const libraryId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
	const hidden = hiddenChannelIds(locals.user.id);
	return json({
		items: listChannels(locals.user, libraryId).map((c) => ({
			...signChannelArt(c),
			isHidden: hidden.has(c.id)
		}))
	});
};
