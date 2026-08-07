import { getShare, shareLive, bumpShareUse } from '$lib/server/share';
import { getVideo, directPlayMap, webPrefersCompat } from '$lib/server/queries';
import { hlsEnabled } from '$lib/server/hls';
import { signedHlsIndex } from '$lib/server/mediaToken';
import { externalOrigin } from '$lib/server/origin';
import type { PageServerLoad } from './$types';

// Public — the auth hook exempts /s/[token]. Returns a discriminated result so the page can
// show a branded "expired / limit reached" state instead of a bare error page.
export const load: PageServerLoad = async ({ params, cookies, url, request }) => {
	const share = getShare(params.token);
	if (!shareLive(share) || !share) return { state: 'gone' as const };

	// Link-unfurl bots (WhatsApp, Slack, Telegram, iMessage, Discord, …) fetch this page to build a
	// preview card. They carry no cookie and must NOT burn a view-cap use — otherwise pasting the
	// link once could consume a single-use share before the recipient ever opens it. Skip counting
	// for them (they still get the OG tags below). Not a security control: a spoofed bot UA gets no
	// viewer cookie either, so it still can't stream a capped share.
	const ua = request.headers.get('user-agent') ?? '';
	const isPreviewBot =
		/bot|crawler|spider|facebookexternalhit|whatsapp|telegram|slack|discord|twitter|linkedin|embed|preview|iframely|skype|pinterest|redditbot|vkshare|google-inspectiontool/i.test(
			ua
		);

	// Per-viewer view cap: a cookie means THIS browser already counted, so a refresh or
	// re-seek never burns a use — only a different browser does. The cookie is scoped to this
	// share's path so it can't be read elsewhere.
	const cookieName = `mv_share_${share.token}`;
	const seen = cookies.get(cookieName) === '1';
	if (share.max_uses != null && !seen && share.used_count >= share.max_uses) {
		return { state: 'limit' as const };
	}
	if (!seen && !isPreviewBot) {
		bumpShareUse(share.token); // count every new viewer (shown in the owner's shares list)
		// path '/' (not just /s/[token]) so the cookie also reaches /media & /thumb — that's how
		// the cap is held on the actual stream, not only the page. httpOnly + token-scoped name.
		cookies.set(cookieName, '1', {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 60 * 60 * 24 * 90
		});
	}

	const video = getVideo(share.video_id);
	if (!video) return { state: 'gone' as const };

	// Open Graph preview (the card link-unfurlers render). og:image must be ABSOLUTE, so build it from the
	// externally-reachable origin (reverse proxy's forwarded host, falling back to url.origin) — the same
	// helper every server-address emitter uses. The thumb is authorised by token alone (shareGrantsThumb),
	// so a cookieless crawler can load it even for a capped share.
	const origin = externalOrigin({ request, url });
	const ogImage = video.thumb_path
		? `${origin}/thumb/${encodeURIComponent(share.video_id)}?s=${encodeURIComponent(share.token)}`
		: null;
	const ogDescription =
		[video.channel_name, video.description?.replace(/\s+/g, ' ').trim().slice(0, 180)]
			.filter(Boolean)
			.join(' — ') || undefined;

	// The full display detail for THIS video (parity with the regular page, minus related) —
	// but never the server-side paths (video_path/info_path/mtime) or channel_id.
	const hls = hlsEnabled();
	return {
		state: 'ok' as const,
		token: share.token,
		// Live-HLS fallback for the recipient (no account): a SHORT-TTL signed capability URL for
		// exactly this video — the same `?k=&exp=` mechanism native players use, so the auth hook
		// already admits it. 2h (window-aligned → valid 2–4h): enough to watch, without outliving a
		// just-expired/capped share by a whole day. (A strict share-state re-check on the /hls route
		// is deliberately deferred — the share token still gates the PAGE and the direct stream.)
		hlsUrl: hls ? signedHlsIndex(share.video_id, 2 * 3600) : null,
		// Start ON HLS for sources the web <video> would play with SILENT audio (.mkv / Dolby-family
		// audio): no MediaError ever fires for those, so fail-open can't rescue them after the fact.
		preferHls: hls && webPrefersCompat(share.video_id),
		directPlay: directPlayMap([share.video_id]).get(share.video_id) ?? false,
		ogImage,
		ogDescription,
		video: {
			id: video.id,
			title: video.title,
			channel_name: video.channel_name,
			description: video.description,
			upload_date: video.upload_date,
			timestamp: video.timestamp,
			duration: video.duration,
			view_count: video.view_count,
			like_count: video.like_count,
			width: video.width,
			height: video.height,
			fps: video.fps,
			vcodec: video.vcodec,
			acodec: video.acodec,
			tags: video.tags,
			webpage_url: video.webpage_url,
			thumb_path: video.thumb_path
		}
	};
};
