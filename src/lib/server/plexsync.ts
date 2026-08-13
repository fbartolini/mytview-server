/**
 * Plex watch-progress sync — two-way, per linked user (docs/plex-sync.md; ⇔ fedsync.ts shape:
 * single-flight latch, minute-tick driver, setting-driven cadence, never-destructive on errors).
 *
 * Correctness spine (verified against plexapi/Overseerr/PlexTraktSync, 2026-08):
 * - FULL state pull + snapshot diff every cycle. Incremental `lastViewedAt>=` filters are UNSAFE:
 *   a Plex-side unwatch deletes history and clears lastViewedAt/viewCount, so it is only visible
 *   as a tuple CHANGE against our snapshot. ~8 requests per 3k items per user on LAN — trivial.
 * - The snapshot (state.plex_sync_state) is the anti-ping-pong invariant: it records the last
 *   OBSERVED Plex tuple + the last SYNCED MytView clock, and is rewritten after every handled
 *   pair. After any push we READ THE ITEM BACK (Plex's timestamp stamping is unpredictable).
 * - Initial sync (no snapshot): watched = UNION (import Plex watched, push MytView watched,
 *   never emit an unwatch — there is no snapshot evidence of one); positions newest-wins.
 * - Pushes only on transitions (repeat scrobbles inflate viewCount); positions <60s are never
 *   pushed (PMS ignores time<minimumProgressTime and time=0 entirely).
 */
import { db } from './db';
import { stateDb, appMetaGet, appMetaSet } from './state';
import { saveWatch } from './watch';
import {
	pmsSections,
	pmsSectionItems,
	pmsMetadata,
	pmsScrobble,
	pmsUnscrobble,
	pmsProgress,
	PlexError,
	type PlexItem
} from './plexclient';
import { plexUrl, listPlexLinks, setPlexLinkSync, refreshServerToken, type PlexLink } from './plexlink';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const PAGE = 400;
const OFFSET_NOISE_S = 5; // ignore sub-5s offset drift (players round differently)
const TIE_GUARD_MS = 2000; // Plex timestamps are second-granular — near-ties prefer the MytView side
const PROGRESS_FLOOR_S = 60; // PMS ignores smaller offsets entirely
const MATCH_TTL_MS = 24 * 3600 * 1000;

// --- Cadence setting (owner, /admin/plex) -------------------------------------------------------

export function plexSyncMinutes(): number {
	const n = parseInt(appMetaGet('plex_sync_min') ?? '5', 10);
	if (!Number.isFinite(n) || n < 0) return 5;
	return n === 0 ? 0 : Math.max(n, 5);
}
export function setPlexSyncMinutes(n: number): void {
	const v = !Number.isFinite(n) || n <= 0 ? 0 : Math.max(Math.trunc(n), 5);
	appMetaSet('plex_sync_min', String(v));
}

let _lastAuto = 0;
/** Minute-tick driver (hooks init) — cadence changes apply with no restart. */
export async function maybeAutoPlexSync(): Promise<void> {
	const minutes = plexSyncMinutes();
	if (minutes === 0 || !plexUrl()) return;
	if (Date.now() - _lastAuto < minutes * 60_000) return;
	_lastAuto = Date.now();
	await runPlexSync();
}

// --- Matching (Plex item ↔ MytView video) -------------------------------------------------------

interface LocalVideo {
	id: string;
	video_path: string;
	season_number: number | null;
	episode_number: number | null;
}

/** Normalized trailing path components ('a/b/c.mkv', n=2 → 'b/c.mkv'). */
function pathTail(p: string, n: number): string {
	const parts = p.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
	return parts.slice(-n).join('/');
}

/** Content-id key from a MytView video id ('tmdb-949' → 'tmdb:949'); null for path-hash/yt ids. */
function contentKey(videoId: string): string | null {
	const m = videoId.match(/^(tmdb|imdb|tvdb)-(.+)$/);
	return m ? `${m[1]}:${m[2]}` : null;
}

/** Content-id keys off a Plex item (new-agent Guid[] first, then the legacy movie guid). */
function plexContentKeys(item: PlexItem, type: 1 | 4): string[] {
	const keys: string[] = [];
	for (const g of item.Guid ?? []) {
		const m = g.id?.match(/^(tmdb|imdb|tvdb):\/\/(.+)$/);
		if (m) keys.push(`${m[1]}:${m[2]}`);
	}
	if (keys.length === 0 && item.guid && type === 1) {
		// Legacy agent, movies: com.plexapp.agents.themoviedb://949?lang=en (episodes use the
		// show-id/season/episode shape we can't key against — the path tier covers those).
		const m = item.guid.match(/^com\.plexapp\.agents\.(themoviedb|imdb):\/\/([^?]+)/);
		if (m) keys.push(`${m[1] === 'themoviedb' ? 'tmdb' : 'imdb'}:${m[2]}`);
	}
	return keys;
}

export interface MatchStats {
	matched: number;
	unmatched: number;
	ambiguous: number;
}

/** Rebuild plex_matches from a full matching pull (Guids + file paths). Uses ONE healthy link's
 *  token — library metadata is identical for every account. First-match-wins per video (editions/
 *  duplicates stay unmatched-ambiguous rather than fighting over one MytView row). */
export async function rebuildMatches(link: PlexLink): Promise<MatchStats> {
	const base = plexUrl()!;
	const locals = db()
		.prepare(
			"SELECT id, video_path, season_number, episode_number FROM videos WHERE peer_id IS NULL"
		)
		.all() as LocalVideo[];
	const byKey = new Map<string, string>();
	const byTail2 = new Map<string, string[]>();
	const byTail3 = new Map<string, string[]>();
	for (const v of locals) {
		const k = contentKey(v.id);
		if (k && !byKey.has(k)) byKey.set(k, v.id);
		for (const [n, m] of [
			[2, byTail2],
			[3, byTail3]
		] as const) {
			const t = pathTail(v.video_path, n);
			if (!m.has(t)) m.set(t, []);
			m.get(t)!.push(v.id);
		}
	}

	const stats: MatchStats = { matched: 0, unmatched: 0, ambiguous: 0 };
	const found = new Map<string, { video_id: string; method: string }>();
	const claimed = new Set<string>(); // video ids already taken (first-match-wins)

	const sections = await pmsSections(base, link.server_token);
	for (const s of sections) {
		const type = s.type === 'movie' ? 1 : s.type === 'show' ? 4 : null;
		if (!type) continue;
		for (let start = 0; ; start += PAGE) {
			const { items, totalSize } = await pmsSectionItems(base, link.server_token, s.key, type, start, PAGE, true);
			for (const item of items) {
				let hit: { video_id: string; method: string } | null = null;
				for (const key of plexContentKeys(item, type)) {
					const vid = byKey.get(key);
					if (vid) {
						hit = { video_id: vid, method: item.Guid?.length ? 'guid' : 'legacy-guid' };
						break;
					}
				}
				if (!hit) {
					const file = item.Media?.[0]?.Part?.[0]?.file;
					if (file) {
						const c2 = byTail2.get(pathTail(file, 2));
						if (c2?.length === 1) hit = { video_id: c2[0], method: 'path2' };
						else if (c2 && c2.length > 1) {
							const c3 = byTail3.get(pathTail(file, 3));
							if (c3?.length === 1) hit = { video_id: c3[0], method: 'path3' };
							else stats.ambiguous++;
						}
					}
				}
				if (hit && !claimed.has(hit.video_id)) {
					claimed.add(hit.video_id);
					found.set(item.ratingKey, hit);
					stats.matched++;
				} else if (hit) stats.ambiguous++;
				else stats.unmatched++;
			}
			if (start + PAGE >= totalSize || items.length === 0) break;
			await tick();
		}
	}

	const d = stateDb();
	d.transaction(() => {
		d.prepare('DELETE FROM plex_matches').run();
		const ins = d.prepare(
			'INSERT INTO plex_matches (rating_key, video_id, method, matched_at) VALUES (?, ?, ?, ?)'
		);
		const now = Date.now();
		for (const [rk, m] of found) ins.run(rk, m.video_id, m.method, now);
	})();
	appMetaSet('plex_matched_at', String(Date.now()));
	appMetaSet('plex_match_stats', JSON.stringify(stats));
	return stats;
}

export function matchStats(): MatchStats | null {
	try {
		return JSON.parse(appMetaGet('plex_match_stats') ?? 'null') as MatchStats | null;
	} catch {
		return null;
	}
}

// --- The merge ----------------------------------------------------------------------------------

interface Snapshot {
	rating_key: string;
	plex_view_count: number;
	plex_view_offset_ms: number;
	plex_last_viewed_at: number | null;
	myt_updated_at: number | null;
}

export interface PlexSyncStats {
	users: number;
	importedToMyt: number;
	pushedToPlex: number;
	errors: number;
}

let _syncing = false;
let _last: PlexSyncStats | null = null;

export function plexSyncStatus(): { syncing: boolean; last: PlexSyncStats | null } {
	return { syncing: _syncing, last: _last };
}

const plexTuple = (i: PlexItem) => ({
	viewCount: i.viewCount ?? 0,
	offsetMs: i.viewOffset ?? 0,
	lastViewedAt: i.lastViewedAt ?? null
});

/** Sync one user (by id) or every linked user. Null when a sync is already running. */
export async function runPlexSync(userId?: number): Promise<PlexSyncStats | null> {
	if (_syncing) return null;
	const base = plexUrl();
	if (!base) return null;
	_syncing = true;
	const stats: PlexSyncStats = { users: 0, importedToMyt: 0, pushedToPlex: 0, errors: 0 };
	try {
		const links = listPlexLinks().filter((l) => userId == null || l.user_id === userId);
		if (links.length === 0) return stats;

		// Matching refresh: empty, stale (>24h), or forced — one pull with any healthy token.
		const matchedAt = parseInt(appMetaGet('plex_matched_at') ?? '0', 10);
		const haveMatches =
			(stateDb().prepare('SELECT COUNT(*) AS c FROM plex_matches').get() as { c: number }).c > 0;
		if (!haveMatches || Date.now() - matchedAt > MATCH_TTL_MS) {
			try {
				await rebuildMatches(links[0]);
			} catch (e) {
				// Matching failure with an existing table is survivable; without one there's nothing to do.
				if (!haveMatches) throw e;
			}
		}
		const matches = new Map(
			(stateDb().prepare('SELECT rating_key, video_id FROM plex_matches').all() as {
				rating_key: string;
				video_id: string;
			}[]).map((r) => [r.rating_key, r.video_id])
		);

		for (const link of links) {
			stats.users++;
			try {
				await syncUser(link, matches, stats);
				setPlexLinkSync(link.user_id, null);
			} catch (e) {
				stats.errors++;
				const msg =
					e instanceof PlexError
						? e.kind === 'auth'
							? 'Plex rejected the token — relink your account'
							: e.kind === 'network'
								? 'Plex server unreachable'
								: `Plex error (HTTP ${e.status})`
						: e instanceof Error
							? e.message
							: String(e);
				setPlexLinkSync(link.user_id, msg);
				console.error(`[mytview] plexsync: user ${link.user_id}: ${msg}`);
			}
			await tick();
		}
	} finally {
		_syncing = false;
	}
	_last = stats;
	return stats;
}

async function syncUser(
	link: PlexLink,
	matches: Map<string, string>,
	stats: PlexSyncStats
): Promise<void> {
	const base = plexUrl()!;
	const d = stateDb();

	// One auth self-heal per cycle: share tokens rotate when the owner re-shares (plexlink).
	let token = link.server_token;
	const withAuthRetry = async <T>(fn: (t: string) => Promise<T>): Promise<T> => {
		try {
			return await fn(token);
		} catch (e) {
			if (e instanceof PlexError && e.kind === 'auth' && (await refreshServerToken(link.user_id))) {
				token = (listPlexLinks().find((l) => l.user_id === link.user_id) ?? link).server_token;
				return await fn(token);
			}
			throw e;
		}
	};

	// FULL state pull (see header for why incremental filters are unsafe).
	const observed = new Map<string, ReturnType<typeof plexTuple>>();
	const sections = await withAuthRetry((t) => pmsSections(base, t));
	for (const s of sections) {
		const type = s.type === 'movie' ? 1 : s.type === 'show' ? 4 : null;
		if (!type) continue;
		for (let start = 0; ; start += PAGE) {
			const { items, totalSize } = await withAuthRetry((t) =>
				pmsSectionItems(base, t, s.key, type, start, PAGE)
			);
			for (const i of items) if (matches.has(i.ratingKey)) observed.set(i.ratingKey, plexTuple(i));
			if (start + PAGE >= totalSize || items.length === 0) break;
			await tick();
		}
	}

	const getSnap = d.prepare(
		'SELECT rating_key, plex_view_count, plex_view_offset_ms, plex_last_viewed_at, myt_updated_at ' +
			'FROM plex_sync_state WHERE user_id = ? AND video_id = ?'
	);
	const putSnap = d.prepare(
		`INSERT INTO plex_sync_state (user_id, video_id, rating_key, plex_view_count, plex_view_offset_ms, plex_last_viewed_at, myt_updated_at, synced_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, video_id) DO UPDATE SET
		   rating_key = excluded.rating_key, plex_view_count = excluded.plex_view_count,
		   plex_view_offset_ms = excluded.plex_view_offset_ms, plex_last_viewed_at = excluded.plex_last_viewed_at,
		   myt_updated_at = excluded.myt_updated_at, synced_at = excluded.synced_at`
	);
	const getMyt = d.prepare(
		'SELECT position, watched, updated_at FROM watch_state WHERE user_id = ? AND video_id = ?'
	);

	for (const [ratingKey, plex] of observed) {
		const videoId = matches.get(ratingKey)!;
		const snap = getSnap.get(link.user_id, videoId) as Snapshot | undefined;
		const myt = (getMyt.get(link.user_id, videoId) as
			| { position: number; watched: number; updated_at: number }
			| undefined) ?? { position: 0, watched: 0, updated_at: 0 };

		const plexWatched = plex.viewCount > 0;
		const mytWatched = !!myt.watched;
		const offsetDiffers = Math.abs(plex.offsetMs / 1000 - myt.position) >= OFFSET_NOISE_S;

		let finalPlex = plex;

		if (!snap) {
			// INITIAL SYNC — watched = union; positions newest-wins; never an unwatch.
			if (plexWatched && !mytWatched) {
				saveWatch(link.user_id, videoId, { watched: true });
				stats.importedToMyt++;
			} else if (mytWatched && !plexWatched) {
				finalPlex = await pushWatched(base, withAuthRetry, ratingKey);
				stats.pushedToPlex++;
			} else if (!plexWatched && !mytWatched && offsetDiffers) {
				const plexTs = (plex.lastViewedAt ?? 0) * 1000;
				if (plexTs > myt.updated_at && plex.offsetMs > 0) {
					saveWatch(link.user_id, videoId, { position: plex.offsetMs / 1000 });
					stats.importedToMyt++;
				} else if (myt.position >= PROGRESS_FLOOR_S) {
					finalPlex = await pushProgress(base, withAuthRetry, ratingKey, myt.position);
					stats.pushedToPlex++;
				}
			}
		} else {
			const plexChanged =
				plex.viewCount !== snap.plex_view_count ||
				plex.lastViewedAt !== snap.plex_last_viewed_at ||
				Math.abs(plex.offsetMs - snap.plex_view_offset_ms) / 1000 >= OFFSET_NOISE_S;
			const mytChanged = myt.updated_at !== (snap.myt_updated_at ?? 0);

			let winner: 'plex' | 'myt' | null = null;
			if (plexChanged && mytChanged) {
				// Both moved since last sync: newest wins; an unwatch clears lastViewedAt, so use now.
				const plexTs = plex.lastViewedAt != null ? plex.lastViewedAt * 1000 : Date.now();
				winner = plexTs - myt.updated_at > TIE_GUARD_MS ? 'plex' : 'myt';
			} else if (plexChanged) winner = 'plex';
			else if (mytChanged) winner = 'myt';

			if (winner === 'plex') {
				if (plexWatched && !mytWatched) {
					saveWatch(link.user_id, videoId, { watched: true });
					stats.importedToMyt++;
				} else if (!plexWatched && mytWatched && snap.plex_view_count > 0) {
					saveWatch(link.user_id, videoId, { watched: false }); // the unwatch import
					stats.importedToMyt++;
				} else if (!plexWatched && offsetDiffers && plex.offsetMs > 0) {
					saveWatch(link.user_id, videoId, { position: plex.offsetMs / 1000 });
					stats.importedToMyt++;
				}
			} else if (winner === 'myt') {
				if (mytWatched && !plexWatched) {
					finalPlex = await pushWatched(base, withAuthRetry, ratingKey);
					stats.pushedToPlex++;
				} else if (!mytWatched && plexWatched) {
					finalPlex = await pushUnwatched(base, withAuthRetry, ratingKey);
					stats.pushedToPlex++;
				} else if (!mytWatched && offsetDiffers && myt.position >= PROGRESS_FLOOR_S) {
					finalPlex = await pushProgress(base, withAuthRetry, ratingKey, myt.position);
					stats.pushedToPlex++;
				}
			}
		}

		// Anti-ping-pong: snapshot what ACTUALLY stands now (post-push values read back; myt clock
		// re-read because imports above bumped it).
		const mytNow = (getMyt.get(link.user_id, videoId) as { updated_at: number } | undefined) ?? {
			updated_at: 0
		};
		putSnap.run(
			link.user_id,
			videoId,
			ratingKey,
			finalPlex.viewCount,
			finalPlex.offsetMs,
			finalPlex.lastViewedAt,
			mytNow.updated_at,
			Date.now()
		);
	}
}

// Pushes read the item back so the snapshot records reality, never a prediction.
type Retry = <T>(fn: (t: string) => Promise<T>) => Promise<T>;
async function readBack(base: string, retry: Retry, ratingKey: string) {
	const item = await retry((t) => pmsMetadata(base, t, ratingKey));
	return item ? plexTuple(item) : { viewCount: 0, offsetMs: 0, lastViewedAt: null };
}
async function pushWatched(base: string, retry: Retry, ratingKey: string) {
	await retry((t) => pmsScrobble(base, t, ratingKey));
	return readBack(base, retry, ratingKey);
}
async function pushUnwatched(base: string, retry: Retry, ratingKey: string) {
	await retry((t) => pmsUnscrobble(base, t, ratingKey));
	return readBack(base, retry, ratingKey);
}
async function pushProgress(base: string, retry: Retry, ratingKey: string, positionS: number) {
	await retry((t) => pmsProgress(base, t, ratingKey, positionS * 1000));
	return readBack(base, retry, ratingKey);
}
