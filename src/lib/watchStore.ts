/**
 * Client-side overlay of in-session watch changes, so cards reflect what you just
 * watched (progress line / watched badge) the instant you return to the feed —
 * without waiting for a fresh server load. Resets on full reload, where the SSR
 * data already carries the persisted values.
 */
import { writable } from 'svelte/store';

export type WatchPatch = { position?: number; watched?: boolean };

export const watchUpdates = writable<Record<string, WatchPatch>>({});

export function noteWatch(id: string, patch: WatchPatch) {
	watchUpdates.update((m) => ({ ...m, [id]: { ...m[id], ...patch } }));
}
