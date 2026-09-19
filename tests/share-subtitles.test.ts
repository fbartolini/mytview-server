/**
 * A share link grants the video's SUBTITLES on exactly the same terms as its stream.
 *
 * The rule (contract: a caption is part of the video): whatever lets you watch it lets you read
 * its captions, and nothing else does. That symmetry is easy to break in either direction —
 * shipping the viewer without the grant (the field bug of 2026-08-25: recipients got a player
 * with no CC option at all) or widening the grant past the one shared video. Both directions are
 * asserted here, against `shareGrantsMedia` — the single predicate the auth hook and the
 * /subs route both consult.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { createUser } = await import('../src/lib/server/auth');
const { createShare, shareGrantsMedia } = await import('../src/lib/server/share');

let shared: string; // token for vid1, uncapped
let capped: string; // token for vid1, single-use
let other: string; // token for a DIFFERENT video

beforeAll(async () => {
	const owner = (await createUser('owner', 'pw123456')).id;
	addLibrary('Main', '', 'channels', false);
	writeChannelVideo(env.mediaRoot, 'Chan', 'vid1');
	writeChannelVideo(env.mediaRoot, 'Chan', 'vid2');
	await scan();
	shared = createShare(owner, 'vid1', 'never', null);
	capped = createShare(owner, 'vid1', 'never', 1);
	other = createShare(owner, 'vid2', 'never', null);
});

afterAll(() => env.cleanup());

describe('share tokens and subtitle tracks', () => {
	it('grants the shared video (the viewer path: token, no account)', () => {
		expect(shareGrantsMedia(shared, 'vid1', false)).toBe(true);
	});

	it('does NOT reach another video — a link is one video, captions included', () => {
		expect(shareGrantsMedia(other, 'vid1', false)).toBe(false);
		expect(shareGrantsMedia(shared, 'vid2', false)).toBe(false);
	});

	it('refuses an unknown or malformed token', () => {
		expect(shareGrantsMedia('n0-such-token-but-well-formed', 'vid1', false)).toBe(false);
		expect(shareGrantsMedia('short', 'vid1', false)).toBe(false);
	});

	it('holds the view CAP on tracks too: cookieless is refused, the counted viewer is not', () => {
		// Copying the raw /subs URL out of a capped share must not defeat the cap…
		expect(shareGrantsMedia(capped, 'vid1', false)).toBe(false);
		// …while the viewer the /s page already counted (and cookied) keeps working.
		expect(shareGrantsMedia(capped, 'vid1', true)).toBe(true);
	});

	it('dies with the share: an expired link grants nothing', async () => {
		const owner2 = (await createUser('other', 'pw123456')).id;
		const expiring = createShare(owner2, 'vid1', '1h', null);
		expect(shareGrantsMedia(expiring, 'vid1', false)).toBe(true);
		const { stateDb } = await import('../src/lib/server/state');
		stateDb()
			.prepare('UPDATE shares SET expires_at = ? WHERE token = ?')
			.run(Date.now() - 1000, expiring);
		expect(shareGrantsMedia(expiring, 'vid1', false)).toBe(false);
	});
});
