/**
 * Per-user Plex account linking — the plex.tv PIN ceremony (docs/plex-sync.md).
 *
 * Flow: a user starts a link from /account → we mint a 4-char PIN with THEIR client identifier
 * (`<server_id>-u<userId>` — tokens are registered per (account, identifier), so users never
 * share one and can revoke "MytView (name)" on plex.tv/devices individually) → they enter it at
 * https://plex.tv/link → a background 3s poll collects the authToken → we resolve the account
 * identity + the SERVER-SCOPED access token for the owner's PMS (via /api/v2/resources, matched
 * on the PMS machine id) and persist the link. Manual token paste rides the same finalize path.
 *
 * Ceremonies are in-memory (a server restart just means "start the link again"). ALL token
 * acquisition lives here so Plex's in-progress JWT migration is contained to one file.
 */
import { stateDb, appMetaGet, appMetaSet } from './state';
import { serverId } from './federation';
import {
	createPin,
	checkPin,
	plexUser,
	plexResources,
	pmsIdentity,
	PlexError
} from './plexclient';

// --- Settings (owner, /admin/plex — app settings, never env) ------------------------------------

export function plexUrl(): string | null {
	return appMetaGet('plex_url');
}
export function setPlexUrl(url: string | null): void {
	appMetaSet('plex_url', url ? url.trim().replace(/\/+$/, '') : null);
}

// --- Link rows ----------------------------------------------------------------------------------

export interface PlexLink {
	user_id: number;
	account_token: string;
	server_token: string;
	plex_username: string | null;
	plex_uuid: string | null;
	machine_id: string | null;
	linked_at: number;
	last_sync_at: number | null;
	last_error: string | null;
}

const LINK_COLS =
	'user_id, account_token, server_token, plex_username, plex_uuid, machine_id, linked_at, last_sync_at, last_error';

export function getPlexLink(userId: number): PlexLink | null {
	return (
		(stateDb().prepare(`SELECT ${LINK_COLS} FROM plex_links WHERE user_id = ?`).get(userId) as PlexLink) ?? null
	);
}

export function listPlexLinks(): PlexLink[] {
	return stateDb().prepare(`SELECT ${LINK_COLS} FROM plex_links ORDER BY user_id`).all() as PlexLink[];
}

export function deletePlexLink(userId: number): void {
	const d = stateDb();
	d.prepare('DELETE FROM plex_links WHERE user_id = ?').run(userId);
	// Snapshots go too: a re-link starts with a clean initial-sync union (never-destructive).
	d.prepare('DELETE FROM plex_sync_state WHERE user_id = ?').run(userId);
}

export function setPlexLinkSync(userId: number, error: string | null, now = Date.now()): void {
	stateDb()
		.prepare('UPDATE plex_links SET last_sync_at = ?, last_error = ? WHERE user_id = ?')
		.run(now, error, userId);
}

/** The per-user plex.tv client identifier (see header). */
export const plexClientId = (userId: number): string => `${serverId()}-u${userId}`;

// --- The PIN ceremony ---------------------------------------------------------------------------

export interface PendingLink {
	status: 'waiting' | 'resolving' | 'error' | 'expired';
	code: string;
	url: string; // prefilled plex.tv/link
	expiresAt: number; // ms
	error?: string;
}

interface PendingInternal extends PendingLink {
	pinId: number;
	polling: boolean;
}

const pending = new Map<number, PendingInternal>();
let timer: ReturnType<typeof setInterval> | null = null;
// 3s per the plexapi/Overseerr norm (1s is aggressive against plex.tv); fast under vitest.
const POLL_MS = process.env.VITEST ? 100 : 3000;

function ensureTimer(): void {
	if (timer) return;
	timer = setInterval(() => void pollPending(), POLL_MS);
	timer.unref?.();
}

async function pollPending(): Promise<void> {
	if (pending.size === 0) {
		if (timer) clearInterval(timer);
		timer = null;
		return;
	}
	for (const [userId, p] of pending) {
		if (p.status !== 'waiting' || p.polling) continue;
		if (Date.now() > p.expiresAt) {
			p.status = 'expired';
			continue;
		}
		p.polling = true;
		try {
			const pin = await checkPin(plexClientId(userId), p.pinId);
			if (pin.authToken) {
				p.status = 'resolving';
				await finalizeLink(userId, pin.authToken);
				pending.delete(userId);
			}
		} catch (e) {
			// Transient plex.tv hiccups just retry on the next tick; a hard auth error ends it.
			if (e instanceof PlexError && e.kind === 'auth') {
				p.status = 'error';
				p.error = 'plex.tv rejected the link — try again';
			}
			if (p.status === 'resolving') {
				p.status = 'error';
				p.error = e instanceof Error ? e.message : 'linking failed';
			}
		} finally {
			p.polling = false;
		}
	}
}

/** Start (or restart) a link ceremony for a user. Requires the owner to have set the PMS URL —
 *  finalize must match the account's server access against it. */
export async function startPlexLink(userId: number): Promise<PendingLink> {
	if (!plexUrl()) throw new Error('no-plex-url');
	const pin = await createPin(plexClientId(userId));
	const entry: PendingInternal = {
		status: 'waiting',
		pinId: pin.id,
		code: pin.code,
		url: `https://plex.tv/link/?pin=${encodeURIComponent(pin.code)}`,
		expiresAt: Date.parse(pin.expiresAt) || Date.now() + 15 * 60_000,
		polling: false
	};
	pending.set(userId, entry);
	ensureTimer();
	return publicPending(entry);
}

export function cancelPlexLink(userId: number): void {
	pending.delete(userId);
}

const publicPending = (p: PendingInternal): PendingLink => ({
	status: p.status,
	code: p.code,
	url: p.url,
	expiresAt: p.expiresAt,
	error: p.error
});

export function pendingLink(userId: number): PendingLink | null {
	const p = pending.get(userId);
	return p ? publicPending(p) : null;
}

/** Resolve identity + the server-scoped token and persist the link. Shared by the PIN ceremony
 *  and the manual token paste. Throws user-facing Error messages. */
export async function finalizeLink(userId: number, accountToken: string): Promise<PlexLink> {
	const url = plexUrl();
	if (!url) throw new Error('The owner has not configured the Plex server address yet.');
	const clientId = plexClientId(userId);
	const account = await plexUser(clientId, accountToken); // also validates the token
	const ident = await pmsIdentity(url);
	const resources = await plexResources(clientId, accountToken);
	const server = resources.find((r) => r.clientIdentifier === ident.machineIdentifier);
	if (!server?.accessToken) {
		throw new Error(
			`Your Plex account (${account.username}) has no access to this Plex server — ask its owner to share the libraries with you.`
		);
	}
	stateDb()
		.prepare(
			`INSERT INTO plex_links (user_id, account_token, server_token, plex_username, plex_uuid, machine_id, linked_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   account_token = excluded.account_token, server_token = excluded.server_token,
			   plex_username = excluded.plex_username, plex_uuid = excluded.plex_uuid,
			   machine_id = excluded.machine_id, linked_at = excluded.linked_at, last_error = NULL`
		)
		.run(userId, accountToken, server.accessToken, account.username, account.uuid, ident.machineIdentifier, Date.now());
	return getPlexLink(userId)!;
}

/** Server-token refresh after a PMS 401 mid-sync (share tokens rotate when the owner re-shares):
 *  re-resolve ONCE from the stored account token before declaring "relink needed". */
export async function refreshServerToken(userId: number): Promise<boolean> {
	const link = getPlexLink(userId);
	const url = plexUrl();
	if (!link || !url) return false;
	try {
		const ident = await pmsIdentity(url);
		const resources = await plexResources(plexClientId(userId), link.account_token);
		const server = resources.find((r) => r.clientIdentifier === ident.machineIdentifier);
		if (!server?.accessToken) return false;
		stateDb()
			.prepare('UPDATE plex_links SET server_token = ?, machine_id = ? WHERE user_id = ?')
			.run(server.accessToken, ident.machineIdentifier, userId);
		return true;
	} catch {
		return false;
	}
}
