/** Minimal username/password auth: scrypt hashing + opaque session tokens. */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

// scrypt on the libuv THREADPOOL. The sync variant blocked the event loop ~30–120ms per call, so an
// unauthenticated login flood stalled every stream/page for everyone — the same hazard files.ts
// documents for statSync, reintroduced on a public endpoint. Same hash format as before;
// scripts/set-password.mjs keeps its own sync copy (offline CLI — blocking is fine there).
const scryptAsync = promisify(scryptCb);
import { stateDb } from './state';

export interface User {
	id: number;
	username: string;
}

export const SESSION_COOKIE = 'session';

// LAN over plain HTTP, so secure:false (else the cookie never sets). httpOnly +
// lax is enough here — "high security is not the objective."
export const cookieOpts = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	secure: false,
	maxAge: 60 * 60 * 24 * 365
} as const;

// Shared minimum so signup, change-password, and reset all agree (was inline-6 in signup).
export const MIN_PASSWORD_LEN = 6;

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = (await scryptAsync(password, salt, 64)) as Buffer;
	return `${salt.toString('hex')}:${key.toString('hex')}`;
}

/** Valid-format stand-in hash for login attempts against a USERNAME that doesn't exist: verifying
 *  against it costs the same scrypt work as a real user, so response TIMING can't enumerate accounts
 *  (a miss used to return in <1ms vs ~50ms+ for a hit). All-zero key → can never actually match. */
export const DUMMY_HASH = `${'00'.repeat(16)}:${'00'.repeat(64)}`;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltHex, keyHex] = stored.split(':');
	if (!saltHex || !keyHex) return false;
	const key = Buffer.from(keyHex, 'hex');
	const test = (await scryptAsync(password, Buffer.from(saltHex, 'hex'), key.length)) as Buffer;
	return key.length === test.length && timingSafeEqual(key, test);
}

export async function createUser(username: string, password: string): Promise<User> {
	const info = stateDb()
		.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
		.run(username, await hashPassword(password), Date.now());
	return { id: Number(info.lastInsertRowid), username };
}

/** Set (replace) a user's password hash. The ONLY update-password path — used by self-service
 *  change-password and by redeeming an owner reset link. Callers verify authorization first. */
export async function setPassword(userId: number, newPassword: string): Promise<void> {
	stateDb()
		.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
		.run(await hashPassword(newPassword), userId);
}

export function findUser(username: string):
	| { id: number; username: string; password_hash: string; deactivated_at: number | null }
	| undefined {
	return stateDb()
		.prepare('SELECT id, username, password_hash, deactivated_at FROM users WHERE username = ?')
		.get(username) as
		| { id: number; username: string; password_hash: string; deactivated_at: number | null }
		| undefined;
}

// Server-side session lifetime: IDLE (no request in 90 days) + ABSOLUTE (~13 months — just past the
// 1-year cookie maxAge, so browsers normally expire first and this is the backstop that finally
// bounds NATIVE bearer tokens, which have no cookie to expire). Enforced at the userForSession choke
// point (like deactivation) so a stolen token is no longer valid forever; an expired client gets a
// 401 and drops to login per the contract. Dead rows are swept opportunistically at each login.
const SESSION_IDLE_MS = 90 * 24 * 3600 * 1000;
const SESSION_ABS_MS = 400 * 24 * 3600 * 1000;

export function createSession(userId: number, label?: string | null): string {
	const token = randomBytes(32).toString('hex');
	const now = Date.now();
	stateDb()
		.prepare('DELETE FROM sessions WHERE created_at < ? OR COALESCE(last_seen, created_at) < ?')
		.run(now - SESSION_ABS_MS, now - SESSION_IDLE_MS);
	stateDb()
		.prepare(
			'INSERT INTO sessions (token, user_id, created_at, last_seen, label) VALUES (?, ?, ?, ?, ?)'
		)
		.run(token, userId, now, now, label ?? null);
	return token;
}

export function userForSession(token: string | undefined): User | null {
	if (!token) return null;
	// `deactivated_at IS NULL` makes deactivation enforced on EVERY request at this single choke point —
	// not just at the two login sites. So a session minted for a suspended account by any path (a device
	// code approved-then-redeemed after suspension, a web-login code) is treated as unauthenticated,
	// and reactivation restores access. Active users are unaffected (their deactivated_at is null).
	// The created_at/last_seen bounds are the session-lifetime backstop (see the constants above).
	const now = Date.now();
	const row = stateDb()
		.prepare(
			`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token = ? AND u.deactivated_at IS NULL
			   AND s.created_at > ? AND COALESCE(s.last_seen, s.created_at) > ?`
		)
		.get(token, now - SESSION_ABS_MS, now - SESSION_IDLE_MS) as User | undefined;
	return row ?? null;
}

export function deleteSession(token: string): void {
	stateDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// --- session management: list a user's logged-in devices + revoke them individually ------------
//
// A session is exposed to clients by a non-secret PUBLIC id (a hash of its token), so the manage-
// devices UI can name and revoke a session without ever handling the raw token. Revocation is always
// scoped to the caller's own user_id — you can only kill your OWN sessions.

const TOUCH_THROTTLE_MS = 5 * 60 * 1000; // don't write last_seen more than once per 5 min per session

/** Bump a session's last-seen, at most once per TOUCH_THROTTLE_MS (so it's ~free per request). */
export function touchSession(token: string): void {
	const now = Date.now();
	stateDb()
		.prepare(
			'UPDATE sessions SET last_seen = ? WHERE token = ? AND (last_seen IS NULL OR last_seen < ?)'
		)
		.run(now, token, now - TOUCH_THROTTLE_MS);
}

/** Stable, non-secret id for a session (hash of the token) — safe to hand to clients. */
function sessionPublicId(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export interface SessionInfo {
	id: string;
	label: string | null;
	createdAt: number;
	lastSeen: number | null;
	current: boolean;
}

/** A user's active sessions, most-recently-seen first, flagging the one making this request. */
export function listSessions(userId: number, currentToken: string | undefined): SessionInfo[] {
	const rows = stateDb()
		.prepare(
			`SELECT token, created_at, last_seen, label FROM sessions WHERE user_id = ?
			 ORDER BY last_seen DESC NULLS LAST, created_at DESC`
		)
		.all(userId) as {
		token: string;
		created_at: number;
		last_seen: number | null;
		label: string | null;
	}[];
	return rows.map((r) => ({
		id: sessionPublicId(r.token),
		label: r.label,
		createdAt: r.created_at,
		lastSeen: r.last_seen,
		current: r.token === currentToken
	}));
}

/** Revoke one of the caller's sessions by its public id. Returns false if no such session is theirs. */
export function revokeSession(userId: number, id: string): boolean {
	const rows = stateDb()
		.prepare('SELECT token FROM sessions WHERE user_id = ?')
		.all(userId) as { token: string }[];
	const match = rows.find((r) => sessionPublicId(r.token) === id);
	if (!match) return false;
	stateDb().prepare('DELETE FROM sessions WHERE token = ?').run(match.token);
	return true;
}

/** Revoke every OTHER session for this user (keep the current one). Returns how many were killed. */
export function revokeOtherSessions(userId: number, currentToken: string): number {
	return stateDb()
		.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
		.run(userId, currentToken).changes;
}

/** Revoke ALL sessions for a user (no current-session exception). Used when a password is reset or an
 *  account is deactivated — every existing login for that user is forced back to sign-in. */
export function revokeAllSessions(userId: number): number {
	return stateDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/** Best-effort friendly device name for a session, from an explicit client name or the User-Agent.
 *  Used only for the manage-devices list — never for access decisions. */
export function describeClient(userAgent: string | null, clientName?: string | null): string {
	if (clientName && clientName.trim()) return clientName.trim().slice(0, 80);
	const ua = userAgent ?? '';
	let device = '';
	if (/apple ?tv|tvos/i.test(ua)) device = 'Apple TV';
	else if (/iphone/i.test(ua)) device = 'iPhone';
	else if (/ipad/i.test(ua)) device = 'iPad';
	else if (/android/i.test(ua)) device = 'Android';
	else if (/macintosh|mac os x/i.test(ua)) device = 'Mac';
	else if (/windows/i.test(ua)) device = 'Windows';
	else if (/linux/i.test(ua)) device = 'Linux';
	let browser = '';
	if (/edg\//i.test(ua)) browser = 'Edge';
	else if (/chrome\//i.test(ua)) browser = 'Chrome';
	else if (/firefox\//i.test(ua)) browser = 'Firefox';
	else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
	if (device && browser) return `${browser} on ${device}`;
	return device || browser || 'Unknown device';
}

/** Build a session label from a request's headers (native clients may send X-Client-Name). */
export function sessionLabelFromRequest(request: Request): string {
	return describeClient(request.headers.get('user-agent'), request.headers.get('x-client-name'));
}

export function userCount(): number {
	return (stateDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

// --- invite tokens: single-use links so the owner can share access -------------

export function createInvite(createdBy: number): string {
	const token = randomBytes(18).toString('base64url');
	stateDb()
		.prepare('INSERT INTO invites (token, created_by, created_at) VALUES (?, ?, ?)')
		.run(token, createdBy, Date.now());
	return token;
}

export function inviteValid(token: string): boolean {
	if (!token) return false;
	const row = stateDb().prepare('SELECT used_at FROM invites WHERE token = ?').get(token) as
		| { used_at: number | null }
		| undefined;
	return !!row && row.used_at == null;
}

/** Atomically mark an invite used; returns false if it was already consumed. */
export function consumeInvite(token: string, userId: number): boolean {
	const info = stateDb()
		.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE token = ? AND used_at IS NULL')
		.run(userId, Date.now(), token);
	return info.changes > 0;
}

export interface InviteRow {
	token: string;
	created_at: number;
	used_at: number | null;
}

export function listInvites(userId: number): InviteRow[] {
	return stateDb()
		.prepare(
			'SELECT token, created_at, used_at FROM invites WHERE created_by = ? ORDER BY created_at DESC'
		)
		.all(userId) as InviteRow[];
}

// --- password reset: owner-generated single-use links (we track no email) -------------
//
// The owner generates a link on /admin/users and hands it to the user out-of-band; the user opens
// /reset?token=… while logged OUT and sets their own password. Single-use (used_at) + expiring; the
// owner never sees the password. Redeeming also revokes the target's existing sessions.

const PASSWORD_RESET_TTL_MS = 72 * 60 * 60 * 1000; // 3 days — forgiving for out-of-band delivery

/** Create a single-use reset token for `userId` (generated by the owner). GCs spent/expired rows first. */
export function createPasswordReset(userId: number, createdBy: number): string {
	const now = Date.now();
	stateDb()
		.prepare('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL')
		.run(now);
	const token = randomBytes(32).toString('base64url');
	stateDb()
		.prepare(
			'INSERT INTO password_resets (token, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
		)
		.run(token, userId, createdBy, now, now + PASSWORD_RESET_TTL_MS);
	return token;
}

/** The user a LIVE (unused, unexpired) reset token targets — lets /reset greet them by name. Null when
 *  the token is unknown / already used / expired. */
export function passwordResetTarget(token: string): { userId: number; username: string } | null {
	if (!token) return null;
	const row = stateDb()
		.prepare(
			`SELECT r.user_id AS userId, u.username AS username, r.expires_at AS expiresAt, r.used_at AS usedAt
			 FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token = ?`
		)
		.get(token) as
		| { userId: number; username: string; expiresAt: number; usedAt: number | null }
		| undefined;
	if (!row || row.usedAt != null || row.expiresAt < Date.now()) return null;
	return { userId: row.userId, username: row.username };
}

/** Redeem a reset token: atomically mark it used, set the new password, revoke the target's sessions.
 *  The `used_at IS NULL AND expires_at >= now` guard makes it single-use — a double-submit returns false. */
export async function consumePasswordReset(token: string, newPassword: string): Promise<boolean> {
	const s = stateDb();
	const now = Date.now();
	const info = s
		.prepare(
			'UPDATE password_resets SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at >= ?'
		)
		.run(now, token, now);
	if (info.changes === 0) return false; // unknown / already used / expired
	const row = s.prepare('SELECT user_id FROM password_resets WHERE token = ?').get(token) as {
		user_id: number;
	};
	await setPassword(row.user_id, newPassword);
	revokeAllSessions(row.user_id);
	return true;
}

// --- user administration (owner-only; the /admin/users route enforces owner + self/owner guards) ----

export interface AdminUser {
	id: number;
	username: string;
	created_at: number;
	deactivated_at: number | null;
	last_seen: number | null; // most recent session activity; null if no live session
}

/** All users with their most-recent session activity, lowest-id first (the owner is always id-lowest). */
export function listUsers(): AdminUser[] {
	return stateDb()
		.prepare(
			`SELECT u.id, u.username, u.created_at, u.deactivated_at,
			        (SELECT MAX(last_seen) FROM sessions WHERE user_id = u.id) AS last_seen
			 FROM users u ORDER BY u.id ASC`
		)
		.all() as AdminUser[];
}

/** Look up one user by id (owner actions validate the target exists / isn't the owner). */
export function userById(userId: number): AdminUser | undefined {
	return stateDb()
		.prepare(
			`SELECT u.id, u.username, u.created_at, u.deactivated_at,
			        (SELECT MAX(last_seen) FROM sessions WHERE user_id = u.id) AS last_seen
			 FROM users u WHERE u.id = ?`
		)
		.get(userId) as AdminUser | undefined;
}

/** Suspend an account: block login (deactivated_at) + kill its sessions. Watch state kept — reversible.
 *  Also purge PENDING credentials the user could otherwise cash in after suspension — an approved-but-
 *  unpolled device code, or a web-login code — so no dead session can be minted. (userForSession also
 *  fails closed on deactivated_at, so this is defense-in-depth + cleanup, not the sole guard.) */
export function deactivateUser(userId: number): void {
	const s = stateDb();
	s.prepare('UPDATE users SET deactivated_at = ? WHERE id = ?').run(Date.now(), userId);
	revokeAllSessions(userId);
	s.prepare('DELETE FROM device_codes WHERE user_id = ?').run(userId);
	s.prepare('DELETE FROM web_login_codes WHERE user_id = ?').run(userId);
}

export function reactivateUser(userId: number): void {
	stateDb().prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(userId);
}

/** Permanently delete a user; FK cascades drop their sessions / watch state / shares / grants / prefs
 *  (invites they created survive, created_by → NULL). The route guards owner + self before calling. */
export function deleteUser(userId: number): void {
	stateDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// --- device pairing: TV shows a short code, user approves it, TV polls for a token ----

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000; // codes expire after 15 minutes
const DEVICE_POLL_INTERVAL_S = 5;
// Unambiguous alphabet (no 0/O/1/I/L) for the human-entered code.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomUserCode(): string {
	const bytes = randomBytes(8);
	let s = '';
	for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
	return s.slice(0, 4) + '-' + s.slice(4); // XXXX-XXXX
}

/** Normalize a user-typed code: uppercase, strip separators, re-hyphenate 8 chars. */
function normalizeUserCode(input: string): string {
	const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
	return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : s;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	intervalS: number;
	expiresInS: number;
}

export function createDeviceCode(): DeviceCode {
	const now = Date.now();
	stateDb().prepare('DELETE FROM device_codes WHERE expires_at < ?').run(now); // opportunistic GC
	const deviceCode = randomBytes(32).toString('base64url');
	const expiresAt = now + DEVICE_CODE_TTL_MS;
	for (let attempt = 0; ; attempt++) {
		const userCode = randomUserCode();
		try {
			stateDb()
				.prepare(
					'INSERT INTO device_codes (device_code, user_code, created_at, expires_at) VALUES (?, ?, ?, ?)'
				)
				.run(deviceCode, userCode, now, expiresAt);
			return {
				deviceCode,
				userCode,
				intervalS: DEVICE_POLL_INTERVAL_S,
				expiresInS: Math.floor(DEVICE_CODE_TTL_MS / 1000)
			};
		} catch (e) {
			if (attempt < 3) continue; // astronomically-unlikely user_code collision → retry
			throw e;
		}
	}
}

export type ApproveResult = 'ok' | 'not_found' | 'expired' | 'already';

/** Approve a pending device code on behalf of an authenticated user. */
export function approveDeviceCode(userCodeInput: string, userId: number): ApproveResult {
	const userCode = normalizeUserCode(userCodeInput);
	const row = stateDb()
		.prepare('SELECT user_id, expires_at FROM device_codes WHERE user_code = ?')
		.get(userCode) as { user_id: number | null; expires_at: number } | undefined;
	if (!row) return 'not_found';
	if (row.expires_at < Date.now()) {
		stateDb().prepare('DELETE FROM device_codes WHERE user_code = ?').run(userCode);
		return 'expired';
	}
	if (row.user_id != null) return 'already';
	stateDb()
		.prepare('UPDATE device_codes SET user_id = ?, approved_at = ? WHERE user_code = ?')
		.run(userId, Date.now(), userCode);
	return 'ok';
}

export type PollResult =
	| { status: 'pending' }
	| { status: 'expired' }
	| { status: 'approved'; token: string; user: User };

/** A TV polls with its device_code. Once approved, mint a session and consume the code. */
export function redeemDeviceCode(deviceCode: string, label?: string | null): PollResult {
	const s = stateDb();
	const row = s
		.prepare('SELECT user_id, expires_at FROM device_codes WHERE device_code = ?')
		.get(deviceCode) as { user_id: number | null; expires_at: number } | undefined;
	if (!row) return { status: 'expired' }; // unknown, or already redeemed
	if (row.expires_at < Date.now()) {
		s.prepare('DELETE FROM device_codes WHERE device_code = ?').run(deviceCode);
		return { status: 'expired' };
	}
	if (row.user_id == null) return { status: 'pending' };
	const token = createSession(row.user_id, label);
	const user = s.prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id) as User;
	s.prepare('DELETE FROM device_codes WHERE device_code = ?').run(deviceCode); // single use
	return { status: 'approved', token, user };
}

// --- web punch-out: hand a signed-in native client off to a browser session ------------

const WEB_CODE_TTL_MS = 60 * 1000; // single-use, 60s — just long enough to open the browser

/** Mint a short-lived, single-use code for an already-authenticated native user. The app opens
 *  /link/web?code=… in an in-app browser, which redeems it for a session cookie. */
export function createWebLoginCode(userId: number): string {
	const now = Date.now();
	stateDb().prepare('DELETE FROM web_login_codes WHERE expires_at < ?').run(now); // opportunistic GC
	const code = randomBytes(32).toString('base64url');
	stateDb()
		.prepare(
			'INSERT INTO web_login_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
		)
		.run(code, userId, now, now + WEB_CODE_TTL_MS);
	return code;
}

/** Redeem a web-login code once: returns the user id and deletes it (single use, even if expired),
 *  or null when unknown / already used / expired. */
export function redeemWebLoginCode(code: string): number | null {
	if (!code) return null;
	const s = stateDb();
	const row = s
		.prepare('SELECT user_id, expires_at FROM web_login_codes WHERE code = ?')
		.get(code) as { user_id: number; expires_at: number } | undefined;
	if (!row) return null;
	s.prepare('DELETE FROM web_login_codes WHERE code = ?').run(code); // consume immediately
	return row.expires_at < Date.now() ? null : row.user_id;
}

/** True if the address is loopback / private (RFC1918 / ULA / link-local). */
export function isPrivateAddress(addr: string | null | undefined): boolean {
	if (!addr) return false;
	let ip = addr.trim().toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip); // IPv4-mapped IPv6
	if (mapped) ip = mapped[1];
	if (ip === '::1') return true; // IPv6 loopback
	if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
	if (ip.startsWith('fe80')) return true; // link-local
	const p = ip.split('.').map(Number);
	if (p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
		const [a, b] = p;
		return (
			a === 127 || // loopback
			a === 10 || // 10/8
			(a === 172 && b >= 16 && b <= 31) || // 172.16/12
			(a === 192 && b === 168) || // 192.168/16
			(a === 169 && b === 254) // link-local
		);
	}
	return false;
}
