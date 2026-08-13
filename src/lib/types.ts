/** Shared row/response types (safe to import on client and server). */

export interface ChannelSummary {
	id: string;
	name: string;
	/** 'channel' (flat videos) | 'series' (seasons/episodes) | 'movies' (one synthetic channel = the
	 *  whole movies library; its videos carry `year` + a 2:3 poster). */
	kind: 'channel' | 'series' | 'movies';
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
	/** Genre list: a series' tvshow.nfo <genre>s, or the movies channel's aggregate of its films'
	 *  genres. Drives the genre filter chips (client-side over the delivered list). Null/omitted for
	 *  ytdl channels. */
	genres?: string[] | null;
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
	/** Movies only — release year (card meta line + the movies grid's year sort). */
	year?: number | null;
	/** Movies only — the 2:3 poster (served by /poster/[videoId]); selected by getChannel so the
	 *  movies grid can render the poster wall. NULL/omitted elsewhere. */
	poster_path?: string | null;
	/** Movies only, in getChannel responses — the film's visible genres, so the wall can filter
	 *  client-side over the fully-delivered list (no refetch). Omitted elsewhere. */
	genres?: string[];
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
	/** Federation: the owning peer's namespace prefix; NULL/undefined = local. Informational for
	 *  clients (a "from Bob's server" badge); the playback descriptor already carries the absolute
	 *  peer URLs, so no client logic branches on this. */
	peer_id?: string | null;
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
	/** Movies only. */
	year?: number | null;
	poster_path?: string | null;
	/** The owning channel's kind — how clients tell a movie from an episode from a channel video
	 *  (drives the no-autoplay-chain rule for movies; see api-client-contract §Movies). */
	channel_kind?: 'channel' | 'series' | 'movies';
}

export interface ChannelDetail {
	channel: ChannelSummary;
	videos: VideoSummary[];
}
