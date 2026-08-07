/**
 * "Is this channel new?" must be answered from durable state.channels_seen, not the disposable
 * index — deleting index.db (a documented-safe op) must not re-apply the library's visibility
 * default over choices the owner already made.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { tempEnv, writeChannelVideo } from './helpers';

const env = tempEnv();
const { scan } = await import('../src/lib/server/indexer');
const { db } = await import('../src/lib/server/db');
const { stateDb } = await import('../src/lib/server/state');
const { addLibrary } = await import('../src/lib/server/libraries');
const { setChannelPrivate } = await import('../src/lib/server/visibility');

afterAll(() => env.cleanup());

const visRow = (id: string) =>
	stateDb().prepare('SELECT private FROM channel_visibility WHERE channel_id = ?').get(id) as
		| { private: number }
		| undefined;

describe('owner visibility survives an index.db rebuild', () => {
	it('applies the private default to a genuinely new channel', async () => {
		addLibrary('Main', '', 'channels', true); // newPrivate=true library at the media root
		writeChannelVideo(env.mediaRoot, 'ChanB', 'v1');
		await scan();
		expect(visRow('ChanB')?.private).toBe(1);
	});

	it('does NOT re-apply the default after the index is wiped, when the owner opened the channel', async () => {
		setChannelPrivate('ChanB', false); // owner makes it public → visibility row deleted
		expect(visRow('ChanB')).toBeUndefined();
		// Simulate the documented-safe "delete index.db and restart": wipe the index tables and rescan.
		db().exec('DELETE FROM videos; DELETE FROM channels;');
		await scan();
		expect(visRow('ChanB')).toBeUndefined(); // still public — NOT treated as "new" again
	});

	it('still applies the default to channels first seen after the rebuild', async () => {
		writeChannelVideo(env.mediaRoot, 'ChanC', 'v2');
		await scan();
		expect(visRow('ChanC')?.private).toBe(1); // genuinely new → default applies
		expect(visRow('ChanB')).toBeUndefined(); // the opened channel stays public
	});
});
