/**
 * Channel visibility — owner-controlled public/private with per-user grants.
 *
 * A channel is PUBLIC by default (no row). The owner can mark it PRIVATE, hiding it from every
 * other account except users explicitly granted it. This is real access control, not just UI
 * hiding: the SQL predicate below filters the feed/channel lists, and `canSeeChannel()` guards
 * direct access to a video/channel (so a private channel 404s even by guessed URL). The owner
 * (the first account) always sees everything.
 *
 * Prefs live in `state.db` (durable, keyed by the index-db channel_id — survives rescans), and
 * that db is ATTACHed as `state` on the index connection, so the predicate joins in one query.
 */
import { stateDb } from './state';
import { db } from './db';
import { ALLOW_INVITES } from './config';

type UserLike = { id: number } | null | undefined;

// The owner is the first account (bootstrap; see ALLOW_SIGNUP=invite). No roles beyond that today.
// Cached once resolved — the first user never changes.
let _ownerId: number | null = null;
export function ownerId(): number | null {
	if (_ownerId != null) return _ownerId;
	const row = stateDb().prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as
		| { id: number }
		| undefined;
	_ownerId = row?.id ?? null;
	return _ownerId;
}
export function isOwner(user: UserLike): boolean {
	return !!user && user.id === ownerId();
}

/** Whether this user may create invite links — the owner always; others only when ALLOW_INVITES=all. */
export function canInvite(user: UserLike): boolean {
	return !!user && (ALLOW_INVITES === 'all' || isOwner(user));
}

/** Owner marks a channel public/private. Public = drop the row (grants become moot; clear them). */
export function setChannelPrivate(channelId: string, priv: boolean, now = Date.now()): void {
	const db = stateDb();
	if (priv) {
		db.prepare(
			`INSERT INTO channel_visibility (channel_id, private, updated_at) VALUES (?, 1, ?)
			 ON CONFLICT(channel_id) DO UPDATE SET private = 1, updated_at = excluded.updated_at`
		).run(channelId, now);
	} else {
		db.transaction(() => {
			db.prepare('DELETE FROM channel_visibility WHERE channel_id = ?').run(channelId);
			db.prepare('DELETE FROM channel_grants WHERE channel_id = ?').run(channelId);
		})();
	}
}

/** Apply a library's default visibility to a genuinely-new channel/show. `newPrivate` comes from the
 *  owning library (set at /admin/libraries); false → PUBLIC (no row). INSERT OR IGNORE, so it NEVER
 *  overrides a choice the owner already made. The indexer calls this only for channels it's seeing for
 *  the first time, so existing channels keep exactly their current visibility. */
export function applyNewChannelDefault(channelId: string, newPrivate: boolean, now = Date.now()): void {
	if (!newPrivate) return; // public default → no row needed
	stateDb()
		.prepare(
			`INSERT OR IGNORE INTO channel_visibility (channel_id, private, updated_at) VALUES (?, 1, ?)`
		)
		.run(channelId, now);
}

/** Bulk: make EVERY indexed channel private (the "lock down the whole library" action). Reads the
 *  channel list from the index db and upserts private=1 for each; existing grants are kept. */
export function setAllChannelsPrivate(now = Date.now()): void {
	const ids = (db().prepare('SELECT id FROM channels').all() as { id: string }[]).map((r) => r.id);
	const s = stateDb();
	s.transaction((list: string[]) => {
		const up = s.prepare(
			`INSERT INTO channel_visibility (channel_id, private, updated_at) VALUES (?, 1, ?)
			 ON CONFLICT(channel_id) DO UPDATE SET private = 1, updated_at = excluded.updated_at`
		);
		for (const id of list) up.run(id, now);
	})(ids);
}

/** Bulk: make EVERY channel public (the "open up the whole library" action) — drop all visibility
 *  rows and all grants, so nothing is private. */
export function setAllChannelsPublic(): void {
	const s = stateDb();
	s.transaction(() => {
		s.prepare('DELETE FROM channel_grants').run();
		s.prepare('DELETE FROM channel_visibility').run();
	})();
}

/** Bulk grant: give ONE user access to every CURRENTLY-private channel (the owner "share everything"
 *  action). A snapshot of the current private set — a channel made private later isn't auto-granted,
 *  so re-run it to re-share. INSERT OR IGNORE, so it's idempotent and never disturbs other users' grants. */
export function grantUserAllPrivateChannels(userId: number): void {
	stateDb()
		.prepare(
			`INSERT OR IGNORE INTO channel_grants (channel_id, user_id)
			 SELECT channel_id, ? FROM channel_visibility WHERE private = 1`
		)
		.run(Math.trunc(userId));
}

/** Bulk revoke: remove ONE user from every private channel's grant list (the "unshare everything"
 *  action). Only touches that user's grants; other users keep theirs. */
export function revokeUserAllChannels(userId: number): void {
	stateDb().prepare('DELETE FROM channel_grants WHERE user_id = ?').run(Math.trunc(userId));
}

/** Owner replaces the grant set for a private channel (which non-owner accounts may see it). */
export function setChannelGrants(channelId: string, userIds: number[]): void {
	const db = stateDb();
	db.transaction((ids: number[]) => {
		db.prepare('DELETE FROM channel_grants WHERE channel_id = ?').run(channelId);
		const ins = db.prepare(
			'INSERT OR IGNORE INTO channel_grants (channel_id, user_id) VALUES (?, ?)'
		);
		for (const uid of ids) ins.run(channelId, Math.trunc(uid));
	})(userIds);
}

export interface ChannelVisibility {
	private: boolean;
	grantedUserIds: number[];
}
export function getChannelVisibility(channelId: string): ChannelVisibility {
	const db = stateDb();
	const row = db.prepare('SELECT private FROM channel_visibility WHERE channel_id = ?').get(channelId) as
		| { private: number }
		| undefined;
	const grants = db
		.prepare('SELECT user_id FROM channel_grants WHERE channel_id = ?')
		.all(channelId) as { user_id: number }[];
	return { private: !!row?.private, grantedUserIds: grants.map((g) => g.user_id) };
}

/** Users the owner can grant a private channel to (everyone but the owner, who always sees all). */
export function listGrantableUsers(): { id: number; username: string }[] {
	const oid = ownerId();
	return stateDb()
		.prepare('SELECT id, username FROM users WHERE id != ? ORDER BY username COLLATE NOCASE')
		.all(oid ?? -1) as { id: number; username: string }[];
}

/** Guard by video id — looks up the video's channel and defers to canSeeChannel. Unknown video →
 *  false, so a private and a non-existent video both 404 (no existence leak via enumeration). */
export function canSeeVideo(user: UserLike, videoId: string): boolean {
	const row = db().prepare('SELECT channel_id FROM videos WHERE id = ?').get(videoId) as
		| { channel_id: string }
		| undefined;
	return !!row && canSeeChannel(user, row.channel_id);
}

/** Direct-access guard: owner → always; public → yes; private → only if the user is granted. */
export function canSeeChannel(user: UserLike, channelId: string): boolean {
	if (!user) return false;
	// Unknown channel → false, so a private and a non-existent channel both 404 — the same
	// no-enumeration rule canSeeVideo applies. Without this, the channel WRITE endpoints answered
	// 200 for made-up ids but 404 for real-private ones (an existence oracle over guessable
	// directory-name ids), and /channels/[id]/hidden accepted junk rows for ids that don't exist.
	if (!db().prepare('SELECT 1 FROM channels WHERE id = ?').get(channelId)) return false;
	if (isOwner(user)) return true;
	const s = stateDb();
	const row = s.prepare('SELECT private FROM channel_visibility WHERE channel_id = ?').get(channelId) as
		| { private: number }
		| undefined;
	if (!row?.private) return true; // public (or unset)
	return !!s
		.prepare('SELECT 1 FROM channel_grants WHERE channel_id = ? AND user_id = ?')
		.get(channelId, user.id);
}

// --- Per-user feed hiding (personal "unsubscribe from my feed" — NOT access control) ----------

export function isChannelHidden(userId: number, channelId: string): boolean {
	return !!stateDb()
		.prepare('SELECT 1 FROM user_hidden_channels WHERE user_id = ? AND channel_id = ?')
		.get(userId, channelId);
}
/** All channels this user has hidden — batch form for annotating a channel list in one query. */
export function hiddenChannelIds(userId: number): Set<string> {
	const rows = stateDb()
		.prepare('SELECT channel_id FROM user_hidden_channels WHERE user_id = ?')
		.all(userId) as { channel_id: string }[];
	return new Set(rows.map((r) => r.channel_id));
}
export function setChannelHidden(userId: number, channelId: string, hidden: boolean): void {
	const db = stateDb();
	if (hidden) {
		db.prepare(
			'INSERT OR IGNORE INTO user_hidden_channels (user_id, channel_id) VALUES (?, ?)'
		).run(userId, channelId);
	} else {
		db.prepare('DELETE FROM user_hidden_channels WHERE user_id = ? AND channel_id = ?').run(
			userId,
			channelId
		);
	}
}
/** SQL WHERE fragment excluding the user's hidden channels — for the FEED and related only (opening
 *  a channel directly is intentionally unfiltered). uid is inlined as a validated integer, like
 *  visibilityClause. Requires the `state` ATTACH. */
export function notHiddenClause(userId: number, channelCol: string): string {
	const uid = Math.trunc(userId);
	return `${channelCol} NOT IN (SELECT channel_id FROM state.user_hidden_channels WHERE user_id = ${uid})`;
}

/**
 * A SQL WHERE fragment restricting rows to channels this user may see, for embedding in the
 * list queries (feed/channels/related). `channelCol` is the channel-id column/expression in that
 * query (e.g. `videos.channel_id`, `channels.id`). Owner → no restriction. The user id is inlined
 * as a validated integer literal (session-derived, never user input), so no extra bind param.
 */
export function visibilityClause(user: UserLike, channelCol: string): string {
	if (!user) return '0 = 1'; // unauthenticated → nothing (routes already require auth)
	if (isOwner(user)) return '1 = 1';
	const uid = Math.trunc(user.id);
	return `${channelCol} NOT IN (
		SELECT cv.channel_id FROM state.channel_visibility cv
		WHERE cv.private = 1
		  AND cv.channel_id NOT IN (SELECT channel_id FROM state.channel_grants WHERE user_id = ${uid})
	)`;
}
