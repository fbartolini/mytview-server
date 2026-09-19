/**
 * The server's "start on HLS" decision for containers with many embedded text streams (contract
 * §playback descriptor `preferHls`). A 2018 Samsung panel stutters silently on 44 interleaved SRT
 * streams in every engine; only the server sees the count, so only the server can decide. Default
 * threshold 8 (config PREFER_HLS_TEXT_STREAMS): at-or-below stays on the fail-open ladder, above
 * starts on HLS.
 */
import { describe, it, expect } from 'vitest';
import { tempEnv } from './helpers';

tempEnv();
const { prefersHlsForTextStreams } = await import('../src/lib/server/subsembed');
const { PREFER_HLS_TEXT_STREAMS } = await import('../src/lib/server/config');

describe('preferHls for text-stream-heavy containers', () => {
	it('defaults the threshold to 8', () => {
		expect(PREFER_HLS_TEXT_STREAMS).toBe(8);
	});
	it('stays on the fail-open ladder at or below the threshold', () => {
		expect(prefersHlsForTextStreams(0)).toBe(false);
		expect(prefersHlsForTextStreams(3)).toBe(false);
		expect(prefersHlsForTextStreams(8)).toBe(false);
	});
	it('starts on HLS above the threshold (the field case had 44)', () => {
		expect(prefersHlsForTextStreams(9)).toBe(true);
		expect(prefersHlsForTextStreams(44)).toBe(true);
	});
});
