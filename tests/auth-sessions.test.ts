/**
 * Async password hashing (threadpool scrypt, timing-neutral DUMMY_HASH) and server-side session
 * expiry: idle (last_seen) + absolute (created_at) bounds enforced at the userForSession choke
 * point, with dead rows swept at login time.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { tempEnv } from './helpers';

const env = tempEnv();
const { stateDb } = await import('../src/lib/server/state');
const auth = await import('../src/lib/server/auth');

afterAll(() => env.cleanup());

describe('password hashing', () => {
	it('hash/verify roundtrip works and rejects wrong passwords', async () => {
		const h = await auth.hashPassword('correct horse');
		expect(await auth.verifyPassword('correct horse', h)).toBe(true);
		expect(await auth.verifyPassword('wrong', h)).toBe(false);
	});

	it('DUMMY_HASH is valid-format and never matches', async () => {
		expect(await auth.verifyPassword('anything', auth.DUMMY_HASH)).toBe(false);
	});
});

describe('session expiry', () => {
	const DAY = 24 * 3600 * 1000;

	it('a fresh session authenticates', async () => {
		const u = await auth.createUser('alice', 'password1');
		const token = auth.createSession(u.id, 'test');
		expect(auth.userForSession(token)?.id).toBe(u.id);
	});

	it('an idle-expired session (last_seen too old) is rejected', async () => {
		const u = await auth.createUser('bob', 'password1');
		const token = auth.createSession(u.id, 'test');
		stateDb()
			.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
			.run(Date.now() - 91 * DAY, token);
		expect(auth.userForSession(token)).toBeNull();
	});

	it('an absolutely-expired session (created_at too old) is rejected even if recently seen', async () => {
		const u = await auth.createUser('carol', 'password1');
		const token = auth.createSession(u.id, 'test');
		stateDb()
			.prepare('UPDATE sessions SET created_at = ?, last_seen = ? WHERE token = ?')
			.run(Date.now() - 401 * DAY, Date.now(), token);
		expect(auth.userForSession(token)).toBeNull();
	});

	it('login-time sweep deletes dead rows', async () => {
		const u = await auth.createUser('dave', 'password1');
		const stale = auth.createSession(u.id, 'stale');
		stateDb()
			.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
			.run(Date.now() - 100 * DAY, stale);
		auth.createSession(u.id, 'fresh'); // prune runs here
		const gone = stateDb().prepare('SELECT 1 FROM sessions WHERE token = ?').get(stale);
		expect(gone).toBeUndefined();
	});
});
