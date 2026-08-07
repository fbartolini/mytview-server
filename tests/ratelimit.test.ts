/** Fixed-window limiter: under the cap passes, over it blocks, and a new window resets. */
import { describe, it, expect } from 'vitest';
import { rateLimited } from '../src/lib/server/ratelimit';

describe('rateLimited', () => {
	it('allows up to max hits, blocks beyond', () => {
		for (let i = 0; i < 5; i++) expect(rateLimited('k1', 5, 60_000)).toBe(false);
		expect(rateLimited('k1', 5, 60_000)).toBe(true);
		expect(rateLimited('k1', 5, 60_000)).toBe(true);
	});

	it('keys are independent', () => {
		expect(rateLimited('k2', 1, 60_000)).toBe(false);
		expect(rateLimited('k3', 1, 60_000)).toBe(false);
		expect(rateLimited('k2', 1, 60_000)).toBe(true);
	});

	it('a fresh window resets the count', async () => {
		expect(rateLimited('k4', 1, 50)).toBe(false);
		expect(rateLimited('k4', 1, 50)).toBe(true);
		await new Promise((r) => setTimeout(r, 70));
		expect(rateLimited('k4', 1, 50)).toBe(false);
	});
});
