/** Presentation helpers (ported from the original vanilla frontend). */

export function fmtDuration(sec?: number | null): string {
	if (sec == null) return '';
	sec = Math.round(sec);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Compact SxE label for a series episode, e.g. "S1·E2" (or "E2"/"S1" when only one is known).
 *  Null when neither number is present — i.e. this isn't a series episode. */
export function fmtEpisode(season?: number | null, episode?: number | null): string | null {
	if (season == null && episode == null) return null;
	const s = season != null ? `S${season}` : '';
	const e = episode != null ? `E${episode}` : '';
	return s && e ? `${s}·${e}` : s || e;
}

export function fmtViews(n?: number | null): string {
	if (n == null) return '—';
	if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
	return String(n);
}

function dateFrom(ts?: number | null, uploadDate?: string | null): Date | null {
	if (ts) return new Date(ts * 1000);
	if (uploadDate && uploadDate.length === 8) {
		return new Date(
			`${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
		);
	}
	return null;
}

export function fmtDate(ts?: number | null, uploadDate?: string | null): string {
	const d = dateFrom(ts, uploadDate);
	if (!d || isNaN(+d)) return '—';
	return d.toISOString().slice(0, 10);
}

export function relDate(ts?: number | null, uploadDate?: string | null): string {
	const d = dateFrom(ts, uploadDate);
	if (!d || isNaN(+d)) return '';
	const days = Math.floor((Date.now() - +d) / 86400000);
	if (days < 1) return 'today';
	if (days < 30) return `${days}d ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}
