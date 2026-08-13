/**
 * Sharer-side federation metering: WHO is streaming how much, and the per-peer concurrent-stream
 * cap. Attribution comes from the MAC-covered `t=l<linkId>` tag the /api/fed/urls endpoint folds
 * into the signed playback URLs (mediaToken.ts) — unforgeable and unstrippable, so a peer cannot
 * dodge its cap or miscredit another link.
 *
 * - ACTIVE streams are in-memory: a (link, video, client-ip) key counts as live while it received
 *   a media/segment request in the last STREAM_WINDOW_MS. Stateless Range traffic needs no
 *   session teardown — a stopped player just ages out.
 * - CONSUMPTION rolls up durably into state.fed_serve_stats (one row per link per UTC day),
 *   buffered in memory and flushed periodically — never one sqlite write per Range request.
 */
import { stateDb } from './state';

const STREAM_WINDOW_MS = 60_000;
const FLUSH_MS = 15_000;

/** Parse the MAC-covered link tag off a VERIFIED signed URL (`t=l<linkId>`). Call only after
 *  verifyMedia() passed — the tag is trusted precisely because it is inside the MAC. */
export function linkIdFromTag(url: URL): number | null {
	const t = url.searchParams.get('t');
	const m = t?.match(/^l(\d+)$/);
	return m ? Number(m[1]) : null;
}

export const linkTag = (linkId: number): string => `l${linkId}`;

/** The per-link concurrent-stream cap (0 = unlimited) — an owner SETTING on /admin/federation
 *  (fed_links.max_streams), not an env var. PK lookup per request: microseconds. */
export function linkCap(linkId: number): number {
	const row = stateDb().prepare('SELECT max_streams FROM fed_links WHERE id = ?').get(linkId) as
		| { max_streams: number | null }
		| undefined;
	return row?.max_streams ?? 0;
}

// linkId → streamKey → last-seen ms
const active = new Map<number, Map<string, number>>();

function liveStreams(linkId: number): Map<string, number> {
	const now = Date.now();
	let m = active.get(linkId);
	if (!m) active.set(linkId, (m = new Map()));
	for (const [k, seen] of m) if (now - seen > STREAM_WINDOW_MS) m.delete(k);
	return m;
}

export function activeStreamCount(linkId: number): number {
	return liveStreams(linkId).size;
}

/** May this stream proceed under a cap of `cap` concurrent streams? (cap <= 0 = unlimited.)
 *  An already-active key always proceeds — a cap change or a neighbor's new stream never kills
 *  playback mid-flight; only NEW streams are refused. */
export function streamAllowed(linkId: number, streamKey: string, cap: number): boolean {
	if (cap <= 0) return true;
	const m = liveStreams(linkId);
	return m.has(streamKey) || m.size < cap;
}

/** Mark a stream's activity (call on every attributed media/segment request). */
export function noteStream(linkId: number, streamKey: string): void {
	liveStreams(linkId).set(streamKey, Date.now());
}

// --- Durable consumption rollups ----------------------------------------------------------------

interface Pending {
	media_requests: number;
	hls_requests: number;
	url_mints: number;
	bytes_served: number;
}
const pending = new Map<string, Pending>(); // `${linkId}|${day}` → counters
let flushTimer: ReturnType<typeof setInterval> | null = null;

const dayKey = (): string => new Date().toISOString().slice(0, 10);

export function noteServe(linkId: number, kind: 'media' | 'hls' | 'mint', bytes = 0): void {
	const key = `${linkId}|${dayKey()}`;
	let p = pending.get(key);
	if (!p) pending.set(key, (p = { media_requests: 0, hls_requests: 0, url_mints: 0, bytes_served: 0 }));
	if (kind === 'media') p.media_requests++;
	else if (kind === 'hls') p.hls_requests++;
	else p.url_mints++;
	p.bytes_served += Math.max(0, Math.trunc(bytes));
	if (!flushTimer) {
		flushTimer = setInterval(flushServeStats, FLUSH_MS);
		flushTimer.unref?.(); // never keep the process (or a test run) alive for metering
	}
}

/** Flush the buffered counters into state.fed_serve_stats (upsert per link×day). Safe to call any
 *  time; reads call it first so the numbers shown are current. A row whose link was unlinked
 *  meanwhile is dropped (FK) — acceptable loss for a dead link's last seconds. */
export function flushServeStats(): void {
	if (pending.size === 0) return;
	const d = stateDb();
	const upsert = d.prepare(
		`INSERT INTO fed_serve_stats (link_id, day, media_requests, hls_requests, url_mints, bytes_served)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(link_id, day) DO UPDATE SET
		   media_requests = media_requests + excluded.media_requests,
		   hls_requests   = hls_requests + excluded.hls_requests,
		   url_mints      = url_mints + excluded.url_mints,
		   bytes_served   = bytes_served + excluded.bytes_served`
	);
	const entries = [...pending.entries()];
	pending.clear();
	d.transaction(() => {
		for (const [key, p] of entries) {
			const [linkId, day] = key.split('|');
			try {
				upsert.run(Number(linkId), day, p.media_requests, p.hls_requests, p.url_mints, p.bytes_served);
			} catch {
				/* link deleted (FK) — drop its tail counters */
			}
		}
	})();
}

export interface FedServeStats {
	todayMints: number;
	todayBytes: number;
	d30Mints: number;
	d30Requests: number;
	d30Bytes: number;
}

/** Consumption summary for the admin page (today + trailing 30 days, UTC). */
export function serveStats(linkId: number): FedServeStats {
	flushServeStats();
	const d = stateDb();
	const today = d
		.prepare('SELECT url_mints AS m, bytes_served AS b FROM fed_serve_stats WHERE link_id = ? AND day = ?')
		.get(linkId, dayKey()) as { m: number; b: number } | undefined;
	const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
	const d30 = d
		.prepare(
			`SELECT COALESCE(SUM(url_mints),0) AS m, COALESCE(SUM(media_requests+hls_requests),0) AS r,
			        COALESCE(SUM(bytes_served),0) AS b FROM fed_serve_stats WHERE link_id = ? AND day >= ?`
		)
		.get(linkId, cutoff) as { m: number; r: number; b: number };
	return {
		todayMints: today?.m ?? 0,
		todayBytes: today?.b ?? 0,
		d30Mints: d30.m,
		d30Requests: d30.r,
		d30Bytes: d30.b
	};
}
