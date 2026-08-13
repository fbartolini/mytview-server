import { fail, error } from '@sveltejs/kit';
import {
	findUser,
	verifyPassword,
	setPassword,
	revokeOtherSessions,
	MIN_PASSWORD_LEN
} from '$lib/server/auth';
import { isOwner } from '$lib/server/visibility';
import {
	plexUrl,
	setPlexUrl,
	getPlexLink,
	pendingLink,
	startPlexLink,
	cancelPlexLink,
	deletePlexLink,
	finalizeLink
} from '$lib/server/plexlink';
import {
	runPlexSync,
	plexSyncMinutes,
	setPlexSyncMinutes,
	plexSyncStatus,
	matchStats
} from '$lib/server/plexsync';
import { pmsIdentity, PlexError } from '$lib/server/plexclient';
import { stateDb } from '$lib/server/state';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) throw error(401);
	const link = getPlexLink(locals.user.id);
	const owner = isOwner(locals.user);
	return {
		username: locals.user.username,
		isOwner: owner,
		// Plex section: users see it once the owner configures the server; the OWNER always sees it
		// (server settings live HERE — no separate admin page/menu entry by design).
		plex: {
			enabled: plexUrl() != null,
			linked: link
				? { username: link.plex_username, linkedAt: link.linked_at, lastSyncAt: link.last_sync_at, lastError: link.last_error }
				: null,
			// A pending PIN ceremony (the page polls via invalidate while one is live).
			pending: pendingLink(locals.user.id),
			// Owner-only server settings + sync health (null for everyone else).
			admin: owner
				? {
						url: plexUrl(),
						syncMinutes: plexSyncMinutes(),
						syncing: plexSyncStatus().syncing,
						matches: matchStats(),
						links: stateDb()
							.prepare(
								`SELECT p.user_id, u.username, p.plex_username, p.last_sync_at, p.last_error
								 FROM plex_links p JOIN users u ON u.id = p.user_id ORDER BY u.username COLLATE NOCASE`
							)
							.all() as {
							user_id: number;
							username: string;
							plex_username: string | null;
							last_sync_at: number | null;
							last_error: string | null;
						}[]
					}
				: null
		}
	};
};

export const actions: Actions = {
	// (Was the default action — named when the Plex section landed; the form posts ?/password.)
	password: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const form = await request.formData();
		const current = String(form.get('current') ?? '');
		const next = String(form.get('next') ?? '');
		const confirm = String(form.get('confirm') ?? '');

		// locals.user carries no hash — re-read it to check the CURRENT password before changing it.
		const u = findUser(locals.user.username);
		if (!u || !(await verifyPassword(current, u.password_hash))) {
			return fail(400, { error: 'Your current password is wrong.' });
		}
		if (next.length < MIN_PASSWORD_LEN) {
			return fail(400, { error: `New password must be at least ${MIN_PASSWORD_LEN} characters.` });
		}
		if (next !== confirm) {
			return fail(400, { error: "The new passwords don't match." });
		}
		if (next === current) {
			return fail(400, { error: 'The new password must be different from the current one.' });
		}

		await setPassword(u.id, next);
		// A password change should lock out whatever had the old one: sign out every OTHER device but
		// keep THIS session so the user isn't bounced. (Only if we know the current token — we always do
		// for a logged-in web request.)
		const killed = locals.sessionToken ? revokeOtherSessions(u.id, locals.sessionToken) : 0;
		return { ok: true, killed };
	},

	// --- Plex server settings (owner-only; live here on Account by design — no admin menu entry) --
	plexSetUrl: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const raw = String((await request.formData()).get('url') ?? '').trim();
		if (!raw) {
			setPlexUrl(null);
			return { ok: true };
		}
		if (!/^https?:\/\/[^\s/]+/i.test(raw)) {
			return fail(400, { error: 'The Plex address must start with http:// or https://' });
		}
		try {
			const ident = await pmsIdentity(raw.replace(/\/+$/, ''));
			setPlexUrl(raw);
			return { ok: true, plexVersion: ident.version ?? '' };
		} catch (e) {
			return fail(400, {
				error:
					e instanceof PlexError && e.kind === 'network'
						? 'No Plex server answered at that address.'
						: 'That address did not respond like a Plex server.'
			});
		}
	},

	plexSetSyncMin: async ({ request, locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		const n = Number((await request.formData()).get('minutes'));
		if (!Number.isFinite(n) || n < 0 || n > 10080) return fail(400, { error: 'bad sync cadence' });
		setPlexSyncMinutes(n);
		return { ok: true };
	},

	plexSyncNow: async ({ locals }) => {
		if (!isOwner(locals.user)) throw error(403);
		void runPlexSync();
		return { ok: true };
	},

	// --- Plex linking (per-user; docs/plex-sync.md) ---------------------------------------------
	plexLink: async ({ locals }) => {
		if (!locals.user) throw error(401);
		try {
			await startPlexLink(locals.user.id);
			return { ok: true };
		} catch {
			return fail(400, { error: 'Could not reach plex.tv to start linking — try again.' });
		}
	},

	plexCancel: async ({ locals }) => {
		if (!locals.user) throw error(401);
		cancelPlexLink(locals.user.id);
		return { ok: true };
	},

	plexUnlink: async ({ locals }) => {
		if (!locals.user) throw error(401);
		deletePlexLink(locals.user.id);
		return { ok: true };
	},

	// Manual token paste — the power-user escape hatch (same finalize path as the PIN ceremony).
	plexToken: async ({ request, locals }) => {
		if (!locals.user) throw error(401);
		const token = String((await request.formData()).get('token') ?? '').trim();
		if (!token) return fail(400, { error: 'Paste a Plex token first.' });
		try {
			await finalizeLink(locals.user.id, token);
			void runPlexSync(locals.user.id); // converge right away
			return { ok: true };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Linking failed.' });
		}
	}
};
