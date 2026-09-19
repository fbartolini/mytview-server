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
	/** Caption size. A PREFERENCE, not a decision — but server-owned like the others so someone who
	 *  needs larger captions sets it once rather than on every device they own. */
	subtitleSize: 'small' | 'medium' | 'large';
	/** Caption text colour. White is the convention; yellow is the long-standing broadcast
	 *  alternative and markedly easier for some viewers to separate from the picture. */
	subtitleColor: 'white' | 'yellow';
	/** Per-LIBRARY browse state (contract §Browse persistence): how each library opens, everywhere.
	 *  Keyed by library id; a missing key means server defaults (name-ish sort, no genre filter).
	 *  Deliberately per-library, not global — your movie wall by year and a series library by name
	 *  can coexist. Show-watched stays transient (a peek, not a mode). */
	browse: Record<string, BrowsePref>;
}

export interface BrowsePref {
	sort?: (typeof BROWSE_SORTS)[number];
	genre?: string;
}

const SIZES = ['small', 'medium', 'large'] as const;
const COLORS = ['white', 'yellow'] as const;
// Union of every sort token the browse surfaces use (channels grids: name|updated|unwatched;
// movie walls: title|year|added). The server stores, clients interpret per surface.
const BROWSE_SORTS = ['name', 'updated', 'unwatched', 'title', 'year', 'added'] as const;
const MAX_BROWSE_LIBRARIES = 200; // junk-growth cap; updates to existing keys always land
const MAX_GENRE_LEN = 60;

/** A patch may null a library's entry to clear it; stored prefs never hold nulls. */
export type PrefsPatch = Partial<Omit<UserPrefs, 'browse'>> & {
	browse?: Record<string, BrowsePref | null | undefined>;
};

// The single source of truth for defaults — must match the DEFAULT clauses in state.ts user_prefs.
export const DEFAULT_PREFS: Omit<UserPrefs, 'browse'> = {
	autoplayNext: true,
	stillWatchingAfter: 3,
	subtitleSize: 'medium',
	subtitleColor: 'white'
};

/** Keep only what a client may store: a known sort token and/or a bounded genre string. An entry
 *  with neither surviving is a clear (returns null) — so garbage can never occupy a library slot. */
function cleanBrowseEntry(v: unknown): BrowsePref | null {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
	const raw = v as { sort?: unknown; genre?: unknown };
	const out: BrowsePref = {};
	if ((BROWSE_SORTS as readonly string[]).includes(raw.sort as string)) {
		out.sort = raw.sort as BrowsePref['sort'];
	}
	if (typeof raw.genre === 'string') {
		const g = raw.genre.trim().slice(0, MAX_GENRE_LEN);
		if (g) out.genre = g;
	}
	return out.sort || out.genre ? out : null;
}

function parseBrowse(text: string | null | undefined): Record<string, BrowsePref> {
	if (!text) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
	const out: Record<string, BrowsePref> = {};
	for (const [k, v] of Object.entries(parsed)) {
		if (!/^\d{1,10}$/.test(k)) continue; // library ids are numeric
		const clean = cleanBrowseEntry(v);
		if (clean) out[k] = clean;
	}
	return out;
}

export function getUserPrefs(userId: number): UserPrefs {
	const row = stateDb()
		.prepare(
			'SELECT autoplay_next, still_watching_after, subtitle_size, subtitle_color, browse_prefs FROM user_prefs WHERE user_id = ?'
		)
		.get(userId) as
		| {
				autoplay_next: number;
				still_watching_after: number;
				subtitle_size: string | null;
				subtitle_color: string | null;
				browse_prefs: string | null;
		  }
		| undefined;
	if (!row) return { ...DEFAULT_PREFS, browse: {} };
	return {
		autoplayNext: !!row.autoplay_next,
		stillWatchingAfter: row.still_watching_after,
		// Validate on the way OUT too: these columns were added later, so an older row holds NULL.
		subtitleSize: (SIZES as readonly string[]).includes(row.subtitle_size ?? '')
			? (row.subtitle_size as UserPrefs['subtitleSize'])
			: DEFAULT_PREFS.subtitleSize,
		subtitleColor: (COLORS as readonly string[]).includes(row.subtitle_color ?? '')
			? (row.subtitle_color as UserPrefs['subtitleColor'])
			: DEFAULT_PREFS.subtitleColor,
		browse: parseBrowse(row.browse_prefs)
	};
}

export function setUserPrefs(userId: number, patch: PrefsPatch): UserPrefs {
	const cur = getUserPrefs(userId);
	// Browse merges at the LIBRARY level: each entry sent REPLACES that library's saved state
	// whole (sort+genre together), null/invalid clears it, unmentioned libraries keep theirs.
	const browse = { ...cur.browse };
	for (const [k, v] of Object.entries(patch.browse ?? {})) {
		if (!/^\d{1,10}$/.test(k)) continue;
		const clean = v == null ? null : cleanBrowseEntry(v);
		if (!clean) delete browse[k];
		else if (k in browse || Object.keys(browse).length < MAX_BROWSE_LIBRARIES) browse[k] = clean;
	}
	const next: UserPrefs = {
		autoplayNext: patch.autoplayNext ?? cur.autoplayNext,
		// clamp to a sane non-negative integer (0 = off)
		stillWatchingAfter: Math.max(0, Math.trunc(patch.stillWatchingAfter ?? cur.stillWatchingAfter)),
		// Unknown values fall back rather than being stored: a client sending nonsense must not be
		// able to leave a user with captions that render as nothing.
		subtitleSize: (SIZES as readonly string[]).includes(patch.subtitleSize ?? '')
			? patch.subtitleSize!
			: cur.subtitleSize,
		subtitleColor: (COLORS as readonly string[]).includes(patch.subtitleColor ?? '')
			? patch.subtitleColor!
			: cur.subtitleColor,
		browse
	};
	stateDb()
		.prepare(
			`INSERT INTO user_prefs (user_id, autoplay_next, still_watching_after, subtitle_size, subtitle_color, browse_prefs)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   autoplay_next = excluded.autoplay_next,
			   still_watching_after = excluded.still_watching_after,
			   subtitle_size = excluded.subtitle_size,
			   subtitle_color = excluded.subtitle_color,
			   browse_prefs = excluded.browse_prefs`
		)
		.run(
			userId,
			next.autoplayNext ? 1 : 0,
			next.stillWatchingAfter,
			next.subtitleSize,
			next.subtitleColor,
			Object.keys(browse).length ? JSON.stringify(browse) : null
		);
	return next;
}
