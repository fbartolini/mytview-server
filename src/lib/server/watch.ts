/** Per-user watch state (resume position + watched flag), in the durable state.db. */
import { stateDb } from './state';
import { db } from './db';

export interface Watch {
	position: number;
	watched: boolean;
}

export function getWatch(userId: number, videoId: string): Watch {
	const row = stateDb()
		.prepare('SELECT position, watched FROM watch_state WHERE user_id = ? AND video_id = ?')
		.get(userId, videoId) as { position: number; watched: number } | undefined;
	return row ? { position: row.position, watched: !!row.watched } : { position: 0, watched: false };
}

export function saveWatch(
	userId: number,
	videoId: string,
	patch: { position?: number; watched?: boolean }
): void {
	const cur = getWatch(userId, videoId);
	const watched = patch.watched ?? cur.watched;
	// Server rule: a watched video has no resume point — force position to 0 so no client leaves a
	// stale offset behind (and none needs to send position:0 itself).
	const position = watched ? 0 : (patch.position ?? cur.position);
	stateDb()
		.prepare(
			`INSERT INTO watch_state (user_id, video_id, position, watched, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, video_id) DO UPDATE SET
			   position = excluded.position, watched = excluded.watched, updated_at = excluded.updated_at`
		)
		.run(userId, videoId, position, watched ? 1 : 0, Date.now());
}

/** Mark every video in a channel/series watched (or unwatched) for this user — e.g. a new account that
 *  has already seen a show and wants it out of their unwatched feed/badge. Reads the channel's ids from
 *  the index db, then bulk-upserts state.watch_state in one transaction. Watched rows get position 0
 *  (same rule as saveWatch). Returns how many videos were affected. */
export function setChannelWatched(userId: number, channelId: string, watched: boolean): number {
	const ids = db().prepare('SELECT id FROM videos WHERE channel_id = ?').all(channelId) as {
		id: string;
	}[];
	const now = Date.now();
	const w = watched ? 1 : 0;
	const stmt = stateDb().prepare(
		`INSERT INTO watch_state (user_id, video_id, position, watched, updated_at)
		 VALUES (?, ?, 0, ?, ?)
		 ON CONFLICT(user_id, video_id) DO UPDATE SET
		   position = 0, watched = excluded.watched, updated_at = excluded.updated_at`
	);
	const tx = stateDb().transaction((rows: { id: string }[]) => {
		for (const r of rows) stmt.run(userId, r.id, w, now);
	});
	tx(ids);
	return ids.length;
}

/** Watched video ids for a user, as a Set (used to hide/badge in the feed). */
export function watchedIds(userId: number): Set<string> {
	const rows = stateDb()
		.prepare('SELECT video_id FROM watch_state WHERE user_id = ? AND watched = 1')
		.all(userId) as { video_id: string }[];
	return new Set(rows.map((r) => r.video_id));
}

/** When (in seconds) a video counts as "watched": the last 10% of its length, but never more than 60s
 *  before the end — so a 2h film isn't marked watched 12 min early while a 30s clip still needs ~90%.
 *  ONE server-owned curve every client shares (replaces web's flat 90% and native's last-15s). Returns
 *  null when the duration is unknown → the client marks watched at end-of-item instead. */
export function watchedAtSeconds(duration: number | null | undefined): number | null {
	if (!duration || duration <= 0) return null;
	return Math.max(0, duration - Math.min(duration * 0.1, 60));
}

/** Where to resume to when opening a video, or null to start from the beginning. Server-owned so every
 *  client applies the same gate: not if already watched, not within the first 5s, and not once you're
 *  past the "watched" threshold — the last of which is how native used to wrongly "resume" 1s from the
 *  end. */
export function resumePosition(watch: Watch, duration: number | null | undefined): number | null {
	if (watch.watched || watch.position <= 5) return null;
	const end = watchedAtSeconds(duration);
	if (end !== null && watch.position >= end) return null;
	return watch.position;
}
