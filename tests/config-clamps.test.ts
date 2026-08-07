/**
 * Config guardrails: HLS_SEGMENT_SEC=0 used to reach the playlist builder as a division by zero
 * (ceil(duration/0) = Infinity segments → an unbounded loop that OOMs the server on first HLS
 * play), and HLS_MAX_SESSIONS=0 produced a half-broken mode (sessions mint, every segment 503s).
 */
import { describe, it, expect, vi } from 'vitest';
import { tempEnv } from './helpers';

tempEnv(); // config resolves MEDIA_ROOT/DB_PATH at import — point them at throwaway dirs

const freshConfig = async () => {
	vi.resetModules();
	return import('../src/lib/server/config');
};

describe('HLS config clamps', () => {
	it('floors HLS_SEGMENT_SEC at 1', async () => {
		process.env.HLS_SEGMENT_SEC = '0';
		expect((await freshConfig()).HLS_SEGMENT_SEC).toBe(1);
	});

	it('floors HLS_MAX_SESSIONS at 1 (HLS_DIR=off is the off switch)', async () => {
		process.env.HLS_MAX_SESSIONS = '0';
		expect((await freshConfig()).HLS_MAX_SESSIONS).toBe(1);
	});

	it('keeps defaults and explicit valid values', async () => {
		delete process.env.HLS_SEGMENT_SEC;
		delete process.env.HLS_MAX_SESSIONS;
		let cfg = await freshConfig();
		expect(cfg.HLS_SEGMENT_SEC).toBe(4);
		expect(cfg.HLS_MAX_SESSIONS).toBe(3);

		process.env.HLS_SEGMENT_SEC = '6';
		process.env.HLS_MAX_SESSIONS = '5';
		cfg = await freshConfig();
		expect(cfg.HLS_SEGMENT_SEC).toBe(6);
		expect(cfg.HLS_MAX_SESSIONS).toBe(5);
	});
});
