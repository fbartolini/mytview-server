import { error, json } from '@sveltejs/kit';
import { listChannels, isFullyWatched, type ChannelSort } from '$lib/server/queries';
import { signChannelArt } from '$lib/server/mediaToken';
import { hiddenChannelIds } from '$lib/server/visibility';
import type { RequestHandler } from './$types';

// All channels (for the Channels grid), each with its video_count + ready-to-render signed
// poster/fanart URLs, plus this user's personal `isHidden` (unsubscribed-from-feed) flag so the
// client can show a Subscribe/Unsubscribe control. Auth: bearer or cookie.
// Fully-watched channels/series are hidden unless ?watched=1 (isFullyWatched — the server-owned
// grid default every client inherits; `watchedHidden` says how many were dropped so a client can
// render a "show watched" reveal / all-watched empty state). Contract §channels.
export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.user) throw error(401);
	// Optional ?library=<id> scopes the grid to one configured library (mirrors the web nav).
	const raw = url.searchParams.get('library');
	const libraryId = raw && /^\d+$/.test(raw) ? Number(raw) : null;
	const showWatched = url.searchParams.get('watched') === '1';
	// Optional ?sort — same keys as the web /channels page (name|updated|unwatched, default name),
	// so native clients can offer the sort the web already has. Contract §channels.
	const s = url.searchParams.get('sort');
	const sort: ChannelSort = s === 'updated' || s === 'unwatched' ? s : 'name';
	const all = listChannels(locals.user, libraryId, sort);
	const channels = showWatched ? all : all.filter((c) => !isFullyWatched(c));
	const hidden = hiddenChannelIds(locals.user.id);
	return json({
		items: channels.map((c) => ({
			...signChannelArt(c),
			isHidden: hidden.has(c.id)
		})),
		watchedHidden: all.length - channels.length
	});
};
