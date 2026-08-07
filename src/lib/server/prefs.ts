/**
 * Per-user client preferences — the server-owned home for playback settings so every client (web,
 * iOS, tvOS, and the coming Google TV / Tizen) shares ONE set of defaults and one stored value per
 * user, instead of each hard-coding its own literals. Stored in the durable state.db (see state.ts).
 */
import { stateDb } from './state';

export interface UserPrefs {
	/** Auto-advance to the next related video when one ends. */
	autoplayNext: boolean;
	/** Prompt "Are you still watching?" after N unattended auto-advances; 0 = never. */
	stillWatchingAfter: number;
}

// The single source of truth for defaults — must match the DEFAULT clauses in state.ts user_prefs.
export const DEFAULT_PREFS: UserPrefs = { autoplayNext: true, stillWatchingAfter: 3 };

export function getUserPrefs(userId: number): UserPrefs {
	const row = stateDb()
		.prepare('SELECT autoplay_next, still_watching_after FROM user_prefs WHERE user_id = ?')
		.get(userId) as { autoplay_next: number; still_watching_after: number } | undefined;
	if (!row) return { ...DEFAULT_PREFS };
	return { autoplayNext: !!row.autoplay_next, stillWatchingAfter: row.still_watching_after };
}

export function setUserPrefs(userId: number, patch: Partial<UserPrefs>): UserPrefs {
	const cur = getUserPrefs(userId);
	const next: UserPrefs = {
		autoplayNext: patch.autoplayNext ?? cur.autoplayNext,
		// clamp to a sane non-negative integer (0 = off)
		stillWatchingAfter: Math.max(0, Math.trunc(patch.stillWatchingAfter ?? cur.stillWatchingAfter))
	};
	stateDb()
		.prepare(
			`INSERT INTO user_prefs (user_id, autoplay_next, still_watching_after)
			 VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   autoplay_next = excluded.autoplay_next, still_watching_after = excluded.still_watching_after`
		)
		.run(userId, next.autoplayNext ? 1 : 0, next.stillWatchingAfter);
	return next;
}
