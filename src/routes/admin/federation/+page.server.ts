import { error, fail } from '@sveltejs/kit';
import { isOwner } from '$lib/server/visibility';
import { EXTERNAL_URL } from '$lib/server/config';
import { activeStreamCount, serveStats } from '$lib/server/fedmeter';
import { fedSyncMinutes, setFedSyncMinutes } from '$lib/server/fedsync';
import {
	serverId,
	createFedInvite,
	listFedInvites,
	revokeFedInvite,
	encodeInvite,
	decodeInvite,
	listLinks,
	getLink,
	deleteLink,
	renameLink,
	setLinkMaxStreams,
	externalBase,
	externalBaseSetting,
	setExternalBaseSetting,
	grantedChannelIds,
	grantedLibraryIds,
	createConsumerLink,
	listLibraryMaps,
	setLibraryMap,
	deleteLibraryMap
} from '$lib/server/federation';
import { fedPair, FedError } from '$lib/server/fedclient';
import { runFedSync, scheduleFedSync, fedSyncStatus, purgeLinkRows } from '$lib/server/fedsync';
import { addVirtualLibrary, listLibraries, type LibraryFormat } from '$lib/server/libraries';
import type { Actions, PageServerLoad } from './$types';

/** The sharer-side remote-libraries cache, parsed defensively (it's peer-supplied JSON). */
function parseRemoteLibraries(raw: string | null): { id: number; name: string; format: string }[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(l): l is { id: number; name: string; format: string } =>
					typeof l === 'object' &&
					l !== null &&
					typeof (l as { id?: unknown }).id === 'number' &&
					typeof (l as { name?: unknown }).name === 'string' &&
					typeof (l as { format?: unknown }).format === 'string'
			)
			.map((l) => ({ id: l.id, name: l.name.slice(0, 128), format: l.format.slice(0, 16) }));
	} catch {
		return [];
	}
}

export const load: PageServerLoad = (event) => {
	// Owner-only. 404 (not 403) so the admin area isn't even discoverable to other accounts.
	if (!isOwner(event.locals.user)) throw error(404);
	const base = externalBase(event);
	return {
		serverId: serverId(),
		// What an invite will embed as this server's address — shown loudly so a wrong scheme/host is
		// caught BEFORE an invite goes out. Precedence: env override > the owner setting below > the
		// request-derived origin (whose https:// may be WRONG on a bare ip:port server — design §9).
		publicBase: base.base,
		publicBaseSource: base.source,
		publicBaseTrusted: base.trusted,
		publicBaseSetting: externalBaseSetting(),
		envOverride: EXTERNAL_URL != null,
		syncMinutes: fedSyncMinutes(),
		invites: listFedInvites().map((i) => ({
			token: i.token,
			expires_at: i.expires_at,
			paste: encodeInvite(i.base_url, i.token)
		})),
		// What each peer gets is managed on the SHARING page (/admin/visibility — links are one more
		// principal there, incl. whole-library grants); here we just summarize.
		sharerLinks: listLinks('sharer').map((l) => ({
			id: l.id,
			peerName: l.peer_name,
			peerServerId: l.peer_server_id,
			lastSeenAt: l.last_seen_at,
			createdAt: l.created_at,
			sharedChannels: grantedChannelIds(l.id).size,
			sharedLibraries: grantedLibraryIds(l.id).size,
			// Consumption analytics (fedmeter): live stream count + today/30d rollups.
			streamingNow: activeStreamCount(l.id),
			stats: serveStats(l.id),
			maxStreams: l.max_streams ?? 0
		})),
		consumerLinks: listLinks('consumer').map((l) => ({
			id: l.id,
			peerName: l.peer_name,
			peerServerId: l.peer_server_id,
			baseUrl: l.base_url,
			lastSeenAt: l.last_seen_at,
			lastSyncError: l.last_sync_error,
			createdAt: l.created_at,
			remoteLibraries: parseRemoteLibraries(l.remote_libraries),
			mappings: listLibraryMaps(l.id)
		})),
		libraries: listLibraries(),
		syncing: fedSyncStatus().syncing
	};
};

export const actions: Actions = {
	// --- Sharing to peers -----------------------------------------------------------------------
	createInvite: async (event) => {
		if (!isOwner(event.locals.user) || !event.locals.user) throw error(403);
		const { base } = externalBase(event);
		const token = createFedInvite(event.locals.user.id, base);
		return { ok: true, paste: encodeInvite(base, token) };
	},

	// This server's public address — an OWNER SETTING (app_meta), editable here so a bare-ip:port
	// server can fix the wrong self-reported https:// scheme without touching compose. Blank clears
	// (back to request-derived). EXTERNAL_URL env, when set, overrides and locks this.
	setExternalUrl: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const raw = String((await request.formData()).get('url') ?? '').trim();
		if (raw && !/^https?:\/\/[^\s/]+/i.test(raw)) {
			return fail(400, { error: 'The public address must start with http:// or https://' });
		}
		setExternalBaseSetting(raw || null);
		return { ok: true };
	},

	// Auto-sync cadence (minutes; 0 = manual only, values 1–4 clamp to 5) — owner setting, no restart.
	setSyncMin: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const n = Number((await request.formData()).get('minutes'));
		if (!Number.isFinite(n) || n < 0 || n > 10080) return fail(400, { error: 'bad sync cadence' });
		setFedSyncMinutes(n);
		return { ok: true };
	},

	revokeInvite: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const token = String((await request.formData()).get('token') ?? '');
		if (token) revokeFedInvite(token);
		return { ok: true };
	},

	// Per-peer concurrent-stream cap (sharer side; 0/blank = unlimited) — an owner SETTING here,
	// deliberately NOT an env var (keeps compose clean; changes apply instantly, no restart).
	setStreamCap: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const linkId = Number(data.get('linkId'));
		const raw = String(data.get('cap') ?? '').trim();
		const cap = raw === '' ? null : Number(raw);
		const link = Number.isInteger(linkId) ? getLink(linkId) : null;
		if (!link || link.role !== 'sharer' || (cap != null && (!Number.isInteger(cap) || cap < 0 || cap > 999))) {
			return fail(400, { error: 'bad stream cap' });
		}
		setLinkMaxStreams(linkId, cap);
		return { ok: true };
	},

	// Rename the LOCAL alias of a peer (either role) — display-only, never sent to the peer.
	renameLink: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const linkId = Number(data.get('linkId'));
		const name = String(data.get('name') ?? '').trim();
		const link = Number.isInteger(linkId) ? getLink(linkId) : null;
		if (!link || !name) return fail(400, { error: 'bad rename' });
		renameLink(link.id, name);
		return { ok: true };
	},

	unlinkSharer: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const linkId = Number((await request.formData()).get('linkId'));
		const link = Number.isInteger(linkId) ? getLink(linkId) : null;
		if (!link || link.role !== 'sharer') return fail(400, { error: 'bad link' });
		deleteLink(link.id);
		return { ok: true };
	},

	// --- Consuming from peers -------------------------------------------------------------------
	pair: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const invite = decodeInvite(String(data.get('paste') ?? ''));
		if (!invite) return fail(400, { error: 'That does not look like a MytView federation invite.' });
		const peerName = String(data.get('peerName') ?? '').trim().slice(0, 64) || new URL(invite.baseUrl).host;
		const myName = String(data.get('myName') ?? '').trim().slice(0, 64) || 'a MytView server';
		try {
			const resp = await fedPair(invite.baseUrl, {
				invite: invite.token,
				serverId: serverId(),
				name: myName,
				...(EXTERNAL_URL ? { baseUrl: EXTERNAL_URL } : {})
			});
			createConsumerLink(resp.serverId, peerName, invite.baseUrl, resp.secret);
			const link = listLinks('consumer').find((l) => l.peer_server_id === resp.serverId);
			if (link) void runFedSync(link.id);
			return {
				ok: true,
				paired: peerName,
				// http sharer: web playback breaks from an https consumer page + iOS ATS blocks it (design §9).
				warning: invite.baseUrl.startsWith('http://')
					? 'This peer uses plain http — playback will fail from an https page and on Apple devices.'
					: null
			};
		} catch (e) {
			const msg =
				e instanceof FedError
					? e.kind === 'network'
						? `Could not reach the peer at ${invite.baseUrl}.` +
							(invite.baseUrl.startsWith('https://')
								? ' If that server has no TLS (a raw ip:port), its owner should set its PUBLIC ADDRESS (http://…) on their Federation page and send a fresh invite.'
								: '')
						: e.status === 403
							? 'The invite was rejected (already used or expired).'
							: `The peer refused the pairing (HTTP ${e.status ?? '?'}).`
					: 'Pairing failed.';
			return fail(400, { error: msg });
		}
	},

	mapLibrary: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const linkId = Number(data.get('linkId'));
		const remoteLibraryId = Number(data.get('remoteLibraryId'));
		const target = String(data.get('target') ?? '');
		const link = Number.isInteger(linkId) ? getLink(linkId) : null;
		if (!link || link.role !== 'consumer' || !Number.isInteger(remoteLibraryId)) {
			return fail(400, { error: 'bad mapping request' });
		}
		// The remote library's name/format come from OUR cached copy of the peer's catalog — never
		// from the form (the format decides what the mapping may target).
		const remote = parseRemoteLibraries(link.remote_libraries).find((l) => l.id === remoteLibraryId);
		if (!remote) return fail(400, { error: 'Unknown remote library — sync first.' });
		const format = remote.format as LibraryFormat;
		if (format !== 'channels' && format !== 'series' && format !== 'movies') {
			return fail(400, { error: 'Unknown remote library format.' });
		}
		try {
			const localId = target === 'new' ? addVirtualLibrary(remote.name, format) : Number(target);
			if (!Number.isInteger(localId) || localId <= 0) return fail(400, { error: 'bad target library' });
			setLibraryMap(link.id, remoteLibraryId, localId, remote.name, format);
		} catch (e) {
			return fail(400, {
				error: e instanceof Error && e.message.startsWith('format-mismatch')
					? `A ${format} library can only merge into a ${format} library.`
					: 'Could not create the mapping.'
			});
		}
		// Coalesced: mapping several libraries back-to-back yields ONE sync, not one per click.
		scheduleFedSync(link.id);
		return { ok: true };
	},

	unmapLibrary: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const data = await request.formData();
		const linkId = Number(data.get('linkId'));
		const remoteLibraryId = Number(data.get('remoteLibraryId'));
		const link = Number.isInteger(linkId) ? getLink(linkId) : null;
		if (!link || link.role !== 'consumer') return fail(400, { error: 'bad link' });
		const map = listLibraryMaps(link.id).find((m) => m.remote_library_id === remoteLibraryId);
		if (map) {
			purgeLinkRows(link.peer_prefix, map.local_library_id); // mirrored rows go now, not next sync
			deleteLibraryMap(link.id, remoteLibraryId);
		}
		return { ok: true };
	},

	syncNow: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const linkId = Number((await request.formData()).get('linkId'));
		void runFedSync(Number.isInteger(linkId) && linkId > 0 ? linkId : undefined);
		return { ok: true, syncing: true };
	},

	unlinkConsumer: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const linkId = Number((await request.formData()).get('linkId'));
		const link = Number.isInteger(linkId) ? getLink(linkId) : null;
		if (!link || link.role !== 'consumer') return fail(400, { error: 'bad link' });
		purgeLinkRows(link.peer_prefix); // all mirrored rows; watch_state kept (re-pair revives it)
		deleteLink(link.id);
		return { ok: true };
	}
};
