/** Shared row/response types (safe to import on client and server). */

export interface ChannelSummary {
	id: string;
	name: string;
	/** 'channel' (flat videos) | 'series' (seasons/episodes). */
	kind: 'channel' | 'series';
	yt_channel_id: string | null;
	url: string | null;
	follower_count: number | null;
	poster_path: string | null;
	fanart_path: string | null;
	video_count: number;
	/** Items this user hasn't marked watched (episodes for series, videos for channels). Server-computed
	 *  per-user so every client can render the same unread-style badge. 0 when nothing is unwatched. */
	unwatched: number;
	/** Configured library this channel belongs to (null/undefined = the implicit default library). Only
	 *  populated by getChannel (SELECT *); listChannels omits it, so it's optional. */
	library_id?: number | null;
}

export interface VideoSummary {
	id: string;
	title: string;
	channel_id: string;
	channel_name?: string;
	upload_date: string | null;
	timestamp: number | null;
	duration: number | null;
	view_count: number | null;
	thumb_path: string | null;
	/** Series episodes only; NULL/omitted for channel videos. */
	season_number?: number | null;
	episode_number?: number | null;
	watched?: boolean;
	position?: number;
	/** H.264 + AAC — plays on restrictive native TV players (AVPlayer/AVPlay) without
	 *  transcoding. Populated by the /api/v1 endpoints; omitted on the web SSR path. */
	directPlay?: boolean;
}

export interface Chapter {
	start_time?: number;
	end_time?: number;
	title?: string;
}

export interface VideoDetail {
	id: string;
	title: string;
	channel_id: string;
	channel_name: string;
	description: string | null;
	upload_date: string | null;
	timestamp: number | null;
	duration: number | null;
	view_count: number | null;
	like_count: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	vcodec: string | null;
	acodec: string | null;
	tags: string[];
	chapters: Chapter[];
	webpage_url: string | null;
	thumb_path: string | null;
	season_number?: number | null;
	episode_number?: number | null;
}

export interface ChannelDetail {
	channel: ChannelSummary;
	videos: VideoSummary[];
}
