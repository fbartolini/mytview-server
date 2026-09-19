/**
 * Per-library browse persistence (contract §Browse persistence): user_prefs.browse_prefs holds a
 * JSON map libraryId → { sort?, genre? }, merged at the LIBRARY level — each PATCHed entry
 * replaces that library's state whole, null clears it, unmentioned libraries keep theirs.
 * Validation never stores junk: unknown sorts drop, genres trim + clamp, non-numeric keys are
 * ignored, and an entry with nothing surviving clears the slot instead of occupying it.
 */
import { describe, it, expect } from 'vitest';
import { tempEnv } from './helpers';

tempEnv();
const { getUserPrefs, setUserPrefs } = await import('../src/lib/server/prefs');
const { createUser } = await import('../src/lib/server/auth');

const uid = (await createUser('browser', 'pw123456')).id;

describe('browse prefs', () => {
	it('defaults to an empty map (fresh user, and rows written before the column existed)', () => {
		expect(getUserPrefs(uid).browse).toEqual({});
	});

	it('persists sort+genre per library and merges across libraries', () => {
		setUserPrefs(uid, { browse: { '3': { sort: 'year', genre: 'Drama' } } });
		setUserPrefs(uid, { browse: { '5': { sort: 'updated' } } });
		expect(getUserPrefs(uid).browse).toEqual({
			'3': { sort: 'year', genre: 'Drama' },
			'5': { sort: 'updated' }
		});
	});

	it('replaces a library entry whole: a sort-only patch drops that library’s old genre', () => {
		setUserPrefs(uid, { browse: { '3': { sort: 'title' } } });
		expect(getUserPrefs(uid).browse['3']).toEqual({ sort: 'title' });
	});

	it('null clears one library; the others survive', () => {
		setUserPrefs(uid, { browse: { '3': null } });
		const b = getUserPrefs(uid).browse;
		expect(b['3']).toBeUndefined();
		expect(b['5']).toEqual({ sort: 'updated' });
	});

	it('never stores junk: bad sorts drop, genres clamp, non-numeric keys are ignored', () => {
		setUserPrefs(uid, {
			browse: {
				// nothing survives cleaning → the entry clears rather than occupying the slot
				'5': { sort: 'evil', genre: '   ' } as never,
				'not-a-library': { sort: 'name' } as never,
				'7': { genre: '  ' + 'g'.repeat(100) } as never
			}
		});
		const b = getUserPrefs(uid).browse;
		expect(b['5']).toBeUndefined();
		expect(Object.keys(b)).toEqual(['7']);
		expect(b['7']).toEqual({ genre: 'g'.repeat(60) });
	});

	it('coexists with the other prefs in both directions', () => {
		setUserPrefs(uid, { autoplayNext: false });
		const p = getUserPrefs(uid);
		expect(p.autoplayNext).toBe(false);
		expect(p.browse['7']).toEqual({ genre: 'g'.repeat(60) });
		setUserPrefs(uid, { browse: { '7': null } });
		expect(getUserPrefs(uid).autoplayNext).toBe(false);
	});
});
