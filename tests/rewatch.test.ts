/**
 * The rewatch rule (owner decision 2026-08-18, ⇔ Plex): when a position write says nothing about the
 * watched flag, the flag FOLLOWS the position across the watched threshold — in both directions.
 *
 * The bug this pins down: a watched episode played again from the middle had every throttled position
 * write zeroed by the watched-has-no-resume rule, so replay always started at 0 and the rewatch
 * progress was silently discarded. Now it flips back to in-progress and keeps the offset; and a
 * position at/past the threshold marks watched server-side (the same curve clients mark by).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { addLibrary } = await import('../src/lib/server/libraries');
const { saveWatch, getWatch, resumePosition, watchedAtSeconds } = await import(
	'../src/lib/server/watch'
);
const { db } = await import('../src/lib/server/db');
const { createUser } = await import('../src/lib/server/auth');

let USER = 0;
let vid = ''; // duration 100 → watched threshold at 90 (100 − min(10, 60))
let noDur = ''; // duration unknown → the flag never flips implicitly

describe('rewatch flips watched back to in-progress', () => {
	beforeAll(async () => {
		USER = (await createUser('owner', 'pw123456')).id; // watch_state FKs users
		writeChannelVideo(env.mediaRoot, 'Chan', 'clip1');
		writeChannelVideo(env.mediaRoot, 'Chan', 'clip2', { duration: null });
		addLibrary('Chans', '', 'channels', false);
		await scan();
		const row = (q: string) => (db().prepare(q).get() as { id: string }).id;
		vid = row("SELECT id FROM videos WHERE video_path LIKE '%clip1.mp4'");
		noDur = row("SELECT id FROM videos WHERE video_path LIKE '%clip2.mp4'");
	});
	afterAll(() => env.cleanup());

	it('a mid-video position write UN-watches and keeps the offset (the reported bug)', () => {
		saveWatch(USER, vid, { watched: true });
		expect(getWatch(USER, vid)).toEqual({ position: 0, watched: true });
		// …the viewer opens it again, skips to the middle, watches 15s, exits → throttled write:
		saveWatch(USER, vid, { position: 50 });
		expect(getWatch(USER, vid)).toEqual({ position: 50, watched: false });
		// …and the next open resumes there instead of starting over.
		expect(resumePosition(getWatch(USER, vid), 100)).toBe(50);
	});

	it('a position at/past the threshold marks watched — rewatch-to-the-end re-marks', () => {
		expect(watchedAtSeconds(100)).toBe(90);
		saveWatch(USER, vid, { position: 95 });
		expect(getWatch(USER, vid)).toEqual({ position: 0, watched: true });
	});

	it('the 5s floor still applies — an accidental tap never un-watches', () => {
		saveWatch(USER, vid, { watched: true });
		saveWatch(USER, vid, { position: 4 });
		expect(getWatch(USER, vid).watched).toBe(true);
	});

	it('an EXPLICIT watched write is untouched by the rule (position zeroed as before)', () => {
		saveWatch(USER, vid, { position: 50 }); // in-progress at 50
		saveWatch(USER, vid, { watched: true }); // client marks at the threshold
		expect(getWatch(USER, vid)).toEqual({ position: 0, watched: true });
	});

	it('unknown duration → no threshold → the flag never flips implicitly', () => {
		saveWatch(USER, noDur, { watched: true });
		saveWatch(USER, noDur, { position: 50 });
		expect(getWatch(USER, noDur)).toEqual({ position: 0, watched: true });
	});
});
