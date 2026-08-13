/**
 * Federation state layer — server identity, pairing invites, links, grants, library mappings.
 *
 * Design + threat model: docs/federation-design.md. This module is pure durable-state CRUD over
 * state.db (fed_links / fed_invites / fed_grants / fed_library_map) plus the id-namespace helpers;
 * the sharer HTTP surface lives in fedserve.ts + routes/api/fed/*, the consumer sync in fedsync.ts.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { stateDb, appMetaGet, appMetaSet } from './state';
import { EXTERNAL_URL, ORIGIN_SET } from './config';
import { externalOrigin } from './origin';
import type { LibraryFormat } from './libraries';
import { getLibrary } from './libraries';

// --- Server identity ----------------------------------------------------------------------------

/** This server's persistent identity (lazy UUID in app_meta — the media_url_secret template).
 *  Peers key the mirrored-id namespace off it, so it must never change once minted: unlink +
 *  re-pair against the same server regenerates identical `fed:` ids and watch state survives. */
let _serverId: string | null = null;
export function serverId(): string {
	if (_serverId) return _serverId;
	const d = stateDb();
	d.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)').run('server_id', randomUUID());
	_serverId = (d.prepare('SELECT value FROM app_meta WHERE key = ?').get('server_id') as { value: string }).value;
	return _serverId;
}

/** Namespace prefix for a peer: first 12 hex chars of its server id (48 bits — collisions are
 *  theoretical). On the theoretical clash with an EXISTING link's prefix for a different peer,
 *  fall back to the full stripped id (design §7). */
export function prefixFor(peerServerId: string): string {
	const stripped = peerServerId.toLowerCase().replace(/[^a-z0-9]/g, '');
	const short = stripped.slice(0, 12);
	const clash = stateDb()
		.prepare('SELECT peer_server_id FROM fed_links WHERE peer_prefix = ?')
		.get(short) as { peer_server_id: string } | undefined;
	return clash && clash.peer_server_id !== peerServerId ? stripped : short;
}

/** Mirrored-row id helpers. Mirrored ids are `fed:<prefix>:<remoteId>` (movies-merge videos too —
 *  only their CHANNEL id is the local `movies:<libId>`). */
export const isFedId = (id: string): boolean => id.startsWith('fed:');
export function fedIdParts(id: string): { prefix: string; remoteId: string } | null {
	if (!id.startsWith('fed:')) return null;
	const rest = id.slice(4);
	const sep = rest.indexOf(':');
	if (sep <= 0 || sep === rest.length - 1) return null;
	return { prefix: rest.slice(0, sep), remoteId: rest.slice(sep + 1) };
}
export const fedId = (prefix: string, remoteId: string): string => `fed:${prefix}:${remoteId}`;

// --- Public address (what invites embed + what we send peers as our own baseUrl) ----------------
// Precedence: EXTERNAL_URL env (deployment override) > the owner SETTING (app_meta 'external_url',
// edited on /admin/federation — fixes the raw-IP case where adapter-node self-reports https) > the
// request-derived origin (right behind a proxy that sends x-forwarded-*; possibly wrong-SCHEME on
// a bare ip:port server — the admin page warns when this fallback is in use).
export function externalBaseSetting(): string | null {
	return appMetaGet('external_url');
}
export function setExternalBaseSetting(url: string | null): void {
	appMetaSet('external_url', url ? url.trim().replace(/\/+$/, '') : null);
}
export function externalBase(event: { request: Request; url: URL }): {
	base: string;
	source: 'env' | 'setting' | 'derived';
	/** False only when the derived address's SCHEME was fabricated (no ORIGIN env, no
	 *  x-forwarded-* proxy headers) — the one case worth warning the owner about. An explicit
	 *  ORIGIN or a real proxy vouches for the derived address; no manual confirmation needed. */
	trusted: boolean;
} {
	if (EXTERNAL_URL) return { base: EXTERNAL_URL, source: 'env', trusted: true };
	const setting = externalBaseSetting();
	if (setting) return { base: setting, source: 'setting', trusted: true };
	const proxied = event.request.headers.get('x-forwarded-host') != null;
	return { base: externalOrigin(event), source: 'derived', trusted: ORIGIN_SET || proxied };
}

// --- Invites (sharer side) ----------------------------------------------------------------------

const INVITE_TTL_MS = 24 * 3600 * 1000;

export interface FedInvite {
	token: string;
	base_url: string;
	created_at: number;
	expires_at: number;
	used_at: number | null;
	used_by_server: string | null;
}

/** Mint a single-use pairing invite. baseUrl is captured NOW (EXTERNAL_URL else externalOrigin) —
 *  it's what the consumer will store as the sharer's address, so the admin page shows it loudly. */
export function createFedInvite(userId: number, baseUrl: string, now = Date.now()): string {
	const token = randomBytes(24).toString('base64url');
	stateDb()
		.prepare(
			'INSERT INTO fed_invites (token, base_url, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
		)
		.run(token, baseUrl.replace(/\/+$/, ''), userId, now, now + INVITE_TTL_MS);
	return token;
}

export function listFedInvites(now = Date.now()): FedInvite[] {
	return stateDb()
		.prepare(
			'SELECT token, base_url, created_at, expires_at, used_at, used_by_server FROM fed_invites ' +
				'WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC'
		)
		.all(now) as FedInvite[];
}

export function revokeFedInvite(token: string): void {
	stateDb().prepare('DELETE FROM fed_invites WHERE token = ?').run(token);
}

/** Atomically consume an invite (single-use guard in the UPDATE's WHERE — two racing pair calls
 *  can't both win). Returns the invite row on success, null on invalid/used/expired. */
export function consumeFedInvite(token: string, byServerId: string, now = Date.now()): FedInvite | null {
	const d = stateDb();
	const res = d
		.prepare(
			'UPDATE fed_invites SET used_at = ?, used_by_server = ? ' +
				'WHERE token = ? AND used_at IS NULL AND expires_at > ?'
		)
		.run(now, byServerId, token, now);
	if (res.changes !== 1) return null;
	return d
		.prepare(
			'SELECT token, base_url, created_at, expires_at, used_at, used_by_server FROM fed_invites WHERE token = ?'
		)
		.get(token) as FedInvite;
}

/** The paste-string the sharer owner hands over: versioned, self-contained (base URL + token). */
export function encodeInvite(baseUrl: string, token: string): string {
	const payload = Buffer.from(JSON.stringify({ u: baseUrl.replace(/\/+$/, ''), t: token })).toString('base64url');
	return `mytview-fed:1:${payload}`;
}

/** Fail-closed decode of a pasted invite. Null on anything malformed (wrong prefix/version, bad
 *  JSON, non-http(s) URL, missing token). */
export function decodeInvite(paste: string): { baseUrl: string; token: string } | null {
	const m = paste.trim().match(/^mytview-fed:1:([A-Za-z0-9_-]+)$/);
	if (!m) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
		if (typeof parsed !== 'object' || parsed === null) return null;
		const u = (parsed as { u?: unknown }).u;
		const t = (parsed as { t?: unknown }).t;
		if (typeof u !== 'string' || typeof t !== 'string' || !t) return null;
		if (!/^https?:\/\/[^\s/]+/i.test(u)) return null;
		return { baseUrl: u.replace(/\/+$/, ''), token: t };
	} catch {
		return null;
	}
}

// --- Links --------------------------------------------------------------------------------------

export type FedRole = 'sharer' | 'consumer';

export interface FedLink {
	id: number;
	role: FedRole;
	peer_server_id: string;
	peer_name: string;
	base_url: string | null;
	secret: string;
	peer_prefix: string;
	created_at: number;
	last_seen_at: number | null;
	last_sync_error: string | null;
	remote_libraries: string | null;
	/** Sharer rows: per-peer concurrent-stream cap (null/0 = unlimited) — set on /admin/federation. */
	max_streams: number | null;
}

const LINK_COLS =
	'id, role, peer_server_id, peer_name, base_url, secret, peer_prefix, created_at, last_seen_at, last_sync_error, remote_libraries, max_streams';

/** Sharer side of a pair: store the consumer's identity, mint the link secret. Re-pairing with a
 *  peer we already have (UNIQUE role+peer_server_id) replaces the old link — grants reset. */
export function createSharerLink(
	peerServerId: string,
	peerName: string,
	baseUrl: string | null,
	now = Date.now()
): { id: number; secret: string } {
	const d = stateDb();
	const secret = randomBytes(32).toString('base64url');
	d.prepare('DELETE FROM fed_links WHERE role = ? AND peer_server_id = ?').run('sharer', peerServerId);
	const res = d
		.prepare(
			'INSERT INTO fed_links (role, peer_server_id, peer_name, base_url, secret, peer_prefix, created_at) ' +
				'VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.run('sharer', peerServerId, peerName, baseUrl, secret, prefixFor(peerServerId), now);
	return { id: Number(res.lastInsertRowid), secret };
}

/** Consumer side of a pair: store the sharer's identity + address + the secret it minted. */
export function createConsumerLink(
	peerServerId: string,
	peerName: string,
	baseUrl: string,
	secret: string,
	now = Date.now()
): number {
	const d = stateDb();
	d.prepare('DELETE FROM fed_links WHERE role = ? AND peer_server_id = ?').run('consumer', peerServerId);
	const res = d
		.prepare(
			'INSERT INTO fed_links (role, peer_server_id, peer_name, base_url, secret, peer_prefix, created_at) ' +
				'VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.run('consumer', peerServerId, peerName, baseUrl.replace(/\/+$/, ''), secret, prefixFor(peerServerId), now);
	return Number(res.lastInsertRowid);
}

export function listLinks(role?: FedRole): FedLink[] {
	const d = stateDb();
	return (
		role
			? d.prepare(`SELECT ${LINK_COLS} FROM fed_links WHERE role = ? ORDER BY created_at`).all(role)
			: d.prepare(`SELECT ${LINK_COLS} FROM fed_links ORDER BY created_at`).all()
	) as FedLink[];
}

export function getLink(id: number): FedLink | null {
	return (stateDb().prepare(`SELECT ${LINK_COLS} FROM fed_links WHERE id = ?`).get(id) as FedLink) ?? null;
}

export function linkByPrefix(prefix: string, role: FedRole): FedLink | null {
	return (
		(stateDb()
			.prepare(`SELECT ${LINK_COLS} FROM fed_links WHERE peer_prefix = ? AND role = ?`)
			.get(prefix, role) as FedLink) ?? null
	);
}

/** Resolve the sharer link a presented bearer secret belongs to — constant-time compare per row
 *  (the table holds a handful of rows; iteration cost is nil). Null on no match. */
export function linkBySecret(secret: string): FedLink | null {
	if (!secret) return null;
	const probe = Buffer.from(secret);
	for (const link of listLinks('sharer')) {
		const stored = Buffer.from(link.secret);
		if (stored.length === probe.length && timingSafeEqual(stored, probe)) return link;
	}
	return null;
}

export function deleteLink(id: number): void {
	stateDb().prepare('DELETE FROM fed_links WHERE id = ?').run(id); // grants/maps cascade
}

/** Per-peer concurrent-stream cap (sharer side; null/0 = unlimited). Enforced by fedmeter. */
export function setLinkMaxStreams(id: number, cap: number | null): void {
	const v = cap != null && cap > 0 ? Math.trunc(cap) : null;
	stateDb().prepare('UPDATE fed_links SET max_streams = ? WHERE id = ?').run(v, id);
}

/** Rename the LOCAL alias for a peer (what this owner calls them — never transmitted). */
export function renameLink(id: number, name: string): void {
	const trimmed = name.trim().slice(0, 64);
	if (trimmed) stateDb().prepare('UPDATE fed_links SET peer_name = ? WHERE id = ?').run(trimmed, id);
}

/** Throttled liveness/health touch (sharer: authed call; consumer: clean sync). */
export function touchLinkSeen(id: number, now = Date.now()): void {
	stateDb().prepare('UPDATE fed_links SET last_seen_at = ? WHERE id = ?').run(now, id);
}

export function setLinkSyncError(id: number, error: string | null): void {
	stateDb().prepare('UPDATE fed_links SET last_sync_error = ? WHERE id = ?').run(error, id);
}

export function cacheRemoteLibraries(id: number, librariesJson: string): void {
	stateDb().prepare('UPDATE fed_links SET remote_libraries = ? WHERE id = ?').run(librariesJson, id);
}

// --- Grants (sharer side) -----------------------------------------------------------------------

/** Replace-set of the channels/series shared to a link (mirrors setChannelGrants' shape). */
export function setLinkGrants(linkId: number, channelIds: string[]): void {
	const d = stateDb();
	d.transaction(() => {
		d.prepare('DELETE FROM fed_grants WHERE link_id = ?').run(linkId);
		const ins = d.prepare('INSERT OR IGNORE INTO fed_grants (link_id, channel_id) VALUES (?, ?)');
		for (const cid of channelIds) ins.run(linkId, cid);
	})();
}

export function grantedChannelIds(linkId: number): Set<string> {
	return new Set(
		(stateDb().prepare('SELECT channel_id FROM fed_grants WHERE link_id = ?').all(linkId) as {
			channel_id: string;
		}[]).map((r) => r.channel_id)
	);
}

/** Toggle ONE channel grant for a link (the sharing-matrix row form; setLinkGrants stays the
 *  bulk replace-set). */
export function setLinkChannelGrant(linkId: number, channelId: string, on: boolean): void {
	const d = stateDb();
	if (on) d.prepare('INSERT OR IGNORE INTO fed_grants (link_id, channel_id) VALUES (?, ?)').run(linkId, channelId);
	else d.prepare('DELETE FROM fed_grants WHERE link_id = ? AND channel_id = ?').run(linkId, channelId);
}

/** WHOLE-LIBRARY grant: everything in the library, current AND FUTURE (state.fed_library_grants). */
export function setLinkLibraryGrant(linkId: number, libraryId: number, on: boolean): void {
	const d = stateDb();
	if (on)
		d.prepare('INSERT OR IGNORE INTO fed_library_grants (link_id, library_id) VALUES (?, ?)').run(linkId, libraryId);
	else d.prepare('DELETE FROM fed_library_grants WHERE link_id = ? AND library_id = ?').run(linkId, libraryId);
}

export function grantedLibraryIds(linkId: number): Set<number> {
	return new Set(
		(stateDb().prepare('SELECT library_id FROM fed_library_grants WHERE link_id = ?').all(linkId) as {
			library_id: number;
		}[]).map((r) => r.library_id)
	);
}

// --- Library mappings (consumer side) -----------------------------------------------------------

export interface FedLibraryMap {
	link_id: number;
	remote_library_id: number;
	local_library_id: number;
	remote_name: string | null;
	remote_format: string | null;
}

export function listLibraryMaps(linkId?: number): FedLibraryMap[] {
	const d = stateDb();
	return (
		linkId != null
			? d.prepare('SELECT * FROM fed_library_map WHERE link_id = ?').all(linkId)
			: d.prepare('SELECT * FROM fed_library_map').all()
	) as FedLibraryMap[];
}

/** Map a remote library into a local one. Format compatibility is enforced HERE (the one write
 *  path): a movies source merges only into a movies library, etc. Throws on mismatch/missing. */
export function setLibraryMap(
	linkId: number,
	remoteLibraryId: number,
	localLibraryId: number,
	remoteName: string,
	remoteFormat: LibraryFormat
): void {
	const local = getLibrary(localLibraryId);
	if (!local) throw new Error('no-such-library');
	if (local.format !== remoteFormat) {
		throw new Error(`format-mismatch: ${remoteFormat} library cannot map into a ${local.format} one`);
	}
	stateDb()
		.prepare(
			'INSERT INTO fed_library_map (link_id, remote_library_id, local_library_id, remote_name, remote_format) ' +
				'VALUES (?, ?, ?, ?, ?) ' +
				'ON CONFLICT(link_id, remote_library_id) DO UPDATE SET ' +
				'local_library_id=excluded.local_library_id, remote_name=excluded.remote_name, remote_format=excluded.remote_format'
		)
		.run(linkId, remoteLibraryId, localLibraryId, remoteName, remoteFormat);
}

export function deleteLibraryMap(linkId: number, remoteLibraryId: number): void {
	stateDb()
		.prepare('DELETE FROM fed_library_map WHERE link_id = ? AND remote_library_id = ?')
		.run(linkId, remoteLibraryId);
}
