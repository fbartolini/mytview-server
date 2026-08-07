/**
 * Tiny fixed-window in-memory rate limiter for the UNAUTHENTICATED surface (login, device codes,
 * password reset). Per-process and best-effort BY DESIGN: the goal is blunting credential
 * brute-force and the CPU cost of scrypt floods on a self-hosted box — not carrier-grade
 * throttling. State resets on restart; that's fine for what it defends.
 */
const buckets = new Map<string, { n: number; resetAt: number }>();

/** True when `key` has exceeded `max` hits in the current window (the call itself counts as a hit). */
export function rateLimited(key: string, max: number, windowMs = 60_000): boolean {
	const now = Date.now();
	const b = buckets.get(key);
	if (!b || b.resetAt <= now) {
		// Opportunistic GC so an address-spraying client can't grow the map without bound.
		if (buckets.size > 4096) {
			for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
		}
		buckets.set(key, { n: 1, resetAt: now + windowMs });
		return false;
	}
	b.n++;
	return b.n > max;
}
