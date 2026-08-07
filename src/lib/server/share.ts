/**
 * Public per-video share links. A share grants an account-less viewer access to ONE video
 * (never the library) via an unguessable token, with an owner-chosen expiry AND an optional
 * view cap. The token is the only credential; media is authorised per-video against it in the
 * auth hook, never as a blanket bypass. See DESIGN.md §8.
 */
import { randomBytes } from 'node:crypto';
import { stateDb } from './state';
import { db } from './db';

export type ShareTtl = '1h' | '24h' | '7d' | '30d' | 'never';
export const SHARE_TTLS: ShareTtl[] = ['1h', '24h', '7d', '30d', 'never'];
const TTL_MS: Record<ShareTtl, number | null> = {
	'1h': 3_600_000,
	'24h': 86_400_000,
	'7d': 7 * 86_400_000,
	'30d': 30 * 86_400_000,
	never: null
};
export const SHARE_CAPS = [1, 5, 0] as const; // 0 = unlimited (stored as NULL)

export interface ShareRow {
	token: string;
	video_id: string;
	created_by: number;
	created_at: number;
	expires_at: number | null;
	max_uses: number | null;
	used_count: number;
}

// base64url charset only — hard stop against anything weird reaching a query.
const SAFE_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** Create a share for a video. Returns the (unguessable, 192-bit) token. */
export function createShare(
	userId: number,
	videoId: string,
	ttl: ShareTtl,
	maxUses: number | null
): string {
	const token = randomBytes(24).toString('base64url');
	const now = Date.now();
	const ttlMs = TTL_MS[ttl] ?? null;
	const expires = ttlMs == null ? null : now + ttlMs;
	const cap = maxUses && maxUses > 0 ? maxUses : null;
	stateDb()
		.prepare(
			`INSERT INTO shares (token, video_id, created_by, created_at, expires_at, max_uses, used_count)
			 VALUES (?, ?, ?, ?, ?, ?, 0)`
		)
		.run(token, videoId, userId, now, expires, cap);
	return token;
}

export function getShare(token: string): ShareRow | null {
	if (!SAFE_TOKEN.test(token)) return null;
	// JOIN the creator and treat the share as gone while that account is DEACTIVATED — suspending a user
	// makes the content they exposed inert too, not just their login. Reversible: reactivating restores
	// the links (no rows destroyed). This is the single resolver behind media/thumb grants + the /s
	// viewer, so all three honour it. (Owner can't be deactivated, so owner shares are unaffected.)
	return (
		(stateDb()
			.prepare(
				`SELECT s.* FROM shares s JOIN users u ON u.id = s.created_by
				 WHERE s.token = ? AND u.deactivated_at IS NULL`
			)
			.get(token) as ShareRow) ?? null
	);
}

/** Live = exists and not past expiry. (The view cap is enforced only at viewer open, so an
 *  in-progress stream is never cut off — see the /s/[token] load.) */
export function shareLive(share: ShareRow | null, now = Date.now()): boolean {
	return !!share && (share.expires_at == null || share.expires_at > now);
}

/** Does this token grant access to THIS video's media? Called by the auth hook per request: the
 *  token must exist, be live, and be scoped to exactly this id. For a CAPPED share we also
 *  require the per-viewer cookie the /s/[token] page issues — so the cap can't be defeated by
 *  copying the raw /media URL, while the counted viewer (who has the cookie) is never cut off. */
export function shareGrantsMedia(token: string, videoId: string, hasViewerCookie: boolean): boolean {
	const s = getShare(token);
	if (!s || s.video_id !== videoId || !shareLive(s)) return false;
	return s.max_uses == null || hasViewerCookie;
}

/** Does this token grant access to THIS video's THUMBNAIL/poster? Unlike the stream, the thumb is
 *  not the capped resource — it's already visible on the public /s/[token] page, and link-unfurl
 *  bots (no cookie) need it for the Open Graph preview image. So token + live + id-scoped is enough,
 *  regardless of the view cap; the video stream stays cap+cookie gated (shareGrantsMedia). */
export function shareGrantsThumb(token: string, videoId: string): boolean {
	const s = getShare(token);
	return !!s && s.video_id === videoId && shareLive(s);
}

/** Count one new viewer (called once per browser, cookie-gated in the load). */
export function bumpShareUse(token: string): void {
	if (!SAFE_TOKEN.test(token)) return;
	stateDb().prepare('UPDATE shares SET used_count = used_count + 1 WHERE token = ?').run(token);
}

/** Revoke — owner-scoped (can't delete someone else's share). */
export function revokeShare(token: string, userId: number): boolean {
	return (
		stateDb()
			.prepare('DELETE FROM shares WHERE token = ? AND created_by = ?')
			.run(token, userId).changes > 0
	);
}

export interface ShareListRow extends ShareRow {
	video_title: string | null;
}
/** The caller's shares, newest first, with the video title (joined via the ATTACHed state db). */
export function listSharesByUser(userId: number): ShareListRow[] {
	return db()
		.prepare(
			`SELECT s.token, s.video_id, s.created_by, s.created_at, s.expires_at, s.max_uses,
			        s.used_count, v.title AS video_title
			   FROM state.shares s
			   LEFT JOIN videos v ON v.id = s.video_id
			  WHERE s.created_by = ?
			  ORDER BY s.created_at DESC`
		)
		.all(userId) as ShareListRow[];
}

/** Drop expired shares on scan. (Capped-out shares stay inert — denied at open, revocable by
 *  the owner — so a still-watching viewer of a 1-use link isn't cut off mid-stream.) */
export function gcShares(): void {
	stateDb()
		.prepare('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?')
		.run(Date.now());
}
