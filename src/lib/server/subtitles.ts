/**
 * Subtitle sidecars — discovery + WebVTT conversion.
 *
 * SCOPE, deliberately narrow: surface subtitle files that already sit **next to the media file**.
 * We never fetch, generate, or transcribe anything, and we don't (yet) extract tracks embedded in a
 * Matroska container — that needs ffmpeg per track and is tracked separately. If the file is there,
 * it plays; if it isn't, nothing changes.
 *
 * WHY THIS EXISTS AT ALL: without captions the product is unusable for deaf and hard-of-hearing
 * viewers, which is both unjust and — for EU distribution — a compliance problem (EAA / EN 301 549
 * clause 7.1.1 requires an ICT that plays video to be able to play the captions that come with it).
 * Sidecars are the cheapest honest answer: Bazarr/Sonarr/Radarr libraries are full of them, and
 * yt-dlp writes them with --write-subs.
 *
 * Everything here is a SERVER decision (which tracks exist, what they're called, captions vs
 * subtitles) so all five clients render the same answer — clients only display what we publish.
 */
import path from 'node:path';

export const SUBTITLE_EXTS = ['.vtt', '.srt'];

export interface SubtitleTrack {
	/** BCP-47-ish tag for the <track srclang> attribute; null when the filename says nothing. */
	lang: string | null;
	/** What a human picks from a menu: "English", "English (SDH)", "Spanish (forced)". */
	label: string;
	/** 'captions' = includes non-speech info (SDH/CC) — what accessibility law is about;
	 *  'subtitles' = dialogue translation for people who can hear. `<track kind>` takes these verbatim. */
	kind: 'captions' | 'subtitles';
	forced: boolean;
	/** MEDIA_ROOT-relative path, like every other stored path. */
	path: string;
}

// 3-letter → 2-letter for the codes that actually turn up in libraries. An unmapped token is passed
// through as-is rather than dropped: a player showing "cat" is better than a track that vanishes.
export const LANG3_PUBLIC: Record<string, string> = {
	eng: 'en', spa: 'es', por: 'pt', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
	ita: 'it', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
	pol: 'pl', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', ara: 'ar',
	heb: 'he', tur: 'tr', ces: 'cs', cze: 'cs', ell: 'el', gre: 'el', hun: 'hu',
	cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl',
	ron: 'ro', rum: 'ro', ukr: 'uk', vie: 'vi', tha: 'th', hin: 'hi', ind: 'id'
};

export const LANG_NAMES_PUBLIC: Record<string, string> = {
	en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
	it: 'Italian', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
	fi: 'Finnish', pl: 'Polish', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
	zh: 'Chinese', ar: 'Arabic', he: 'Hebrew', tr: 'Turkish', cs: 'Czech',
	el: 'Greek', hu: 'Hungarian', ro: 'Romanian', uk: 'Ukrainian', vi: 'Vietnamese',
	th: 'Thai', hi: 'Hindi', id: 'Indonesian', ca: 'Catalan', eu: 'Basque', gl: 'Galician'
};

// Markers meaning "this track carries non-speech information" — i.e. real captions, not a
// translation. Naming is not standardised, so we accept every spelling libraries use in the wild.
const CAPTION_MARKERS = new Set(['sdh', 'cc', 'hi', 'hoh', 'forced-sdh']);
const FORCED_MARKERS = new Set(['forced', 'foreign']);

/**
 * Parse the descriptors between a media file's base name and the subtitle extension:
 *   Movie (2019).en.srt          → en, subtitles
 *   Movie (2019).en.sdh.srt      → en, captions
 *   Movie (2019).eng.forced.srt  → en, subtitles, forced
 *   Movie (2019).srt             → unknown language
 *   Show - S01E01.pt-BR.vtt      → pt-BR
 */
export function parseSubtitleName(mediaBase: string, fileName: string): SubtitleTrack | null {
	const ext = path.extname(fileName).toLowerCase();
	if (!SUBTITLE_EXTS.includes(ext)) return null;
	const stem = fileName.slice(0, -ext.length);
	if (stem.toLowerCase() !== mediaBase.toLowerCase() && !stem.toLowerCase().startsWith(mediaBase.toLowerCase() + '.')) {
		return null;
	}
	const rest = stem.slice(mediaBase.length).replace(/^\./, '');
	const parts = rest ? rest.split('.').filter(Boolean) : [];

	let lang: string | null = null;
	let forced = false;
	let captions = false;
	for (const raw of parts) {
		const t = raw.toLowerCase();
		if (FORCED_MARKERS.has(t)) { forced = true; continue; }
		if (CAPTION_MARKERS.has(t)) { captions = true; continue; }
		// First language-shaped token wins: 2-letter, 3-letter, or a tag like pt-BR.
		if (lang === null && /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(raw)) {
			const [base, region] = raw.split('-');
			const two = LANG3_PUBLIC[base.toLowerCase()] ?? base.toLowerCase();
			lang = region ? `${two}-${region.toUpperCase()}` : two;
		}
	}

	const name = lang ? (LANG_NAMES_PUBLIC[lang.split('-')[0]] ?? lang.toUpperCase()) : 'Unknown';
	const suffix = [captions ? 'SDH' : null, forced ? 'forced' : null].filter(Boolean).join(', ');
	return {
		lang,
		label: suffix ? `${name} (${suffix})` : name,
		kind: captions ? 'captions' : 'subtitles',
		forced,
		path: '' // filled by the caller, which knows the MEDIA_ROOT-relative directory
	};
}

/** Every sidecar belonging to `mediaName` in a directory listing, in a stable display order:
 *  captions first (the accessibility-relevant ones), then by label; forced variants last. */
export function findSubtitles(entries: string[], mediaName: string): SubtitleTrack[] {
	const base = mediaName.slice(0, mediaName.length - path.extname(mediaName).length);
	const found: SubtitleTrack[] = [];
	for (const name of entries) {
		const t = parseSubtitleName(base, name);
		if (t) found.push({ ...t, path: name });
	}
	return found.sort(
		(a, b) =>
			Number(a.forced) - Number(b.forced) ||
			(a.kind === b.kind ? 0 : a.kind === 'captions' ? -1 : 1) ||
			a.label.localeCompare(b.label)
	);
}

/**
 * SubRip → WebVTT. Every client we ship speaks VTT; almost every sidecar in the wild is SRT.
 * The conversion is genuinely this small: a header, dot decimal separators, and normalised
 * newlines. Cue numbers are legal in VTT, so they stay.
 */
export function srtToVtt(srt: string): string {
	const body = srt
		.replace(/^﻿/, '') // strip BOM — otherwise the first cue is silently dropped
		.replace(/\r\n?/g, '\n')
		// 00:00:01,200 --> 00:00:04,000   (also tolerates a missing hours field)
		.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
		.replace(/^(\d{2}:\d{2}),(\d{1,3})/gm, '00:$1.$2');
	return `WEBVTT\n\n${body.trim()}\n`;
}

// ---------------------------------------------------------------------------------------------
// Embedded tracks (inside the container). Sidecars above need no tools; these need ffmpeg.
// ---------------------------------------------------------------------------------------------

/**
 * Subtitle codecs we can turn into WebVTT. The exclusions matter more than the inclusions:
 * `hdmv_pgs_subtitle` and `dvd_subtitle` are BITMAPS — pictures of text — and no amount of ffmpeg
 * turns them into a text track without OCR. Players that appear to "support" them (Plex) are
 * burning them into the video during a transcode, which forces a re-encode of content we would
 * otherwise direct-play. That's a separate decision, so unsupported tracks are simply not listed:
 * a menu entry that fails when picked is worse than an honest "none available".
 */
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'subviewer', 'microdvd']);

interface ProbedStream {
	index: number;
	codec_name?: string;
	tags?: { language?: string; title?: string };
	disposition?: Record<string, number>;
}

/**
 * Turn `ffprobe -show_streams` JSON into the same track shape sidecars produce, so both sources
 * flow through one code path from here on. Bitmap codecs are dropped (see above).
 */
export function parseProbedStreams(json: string): {
	tracks: (SubtitleTrack & { streamIndex: number })[];
	/** Codecs we found but can't use (bitmap subtitles). Reported so the owner can be told WHY a
	 *  file with subtitles shows none, instead of being left to guess. */
	skipped: string[];
} {
	let streams: ProbedStream[];
	try {
		streams = (JSON.parse(json) as { streams?: ProbedStream[] }).streams ?? [];
	} catch {
		return { tracks: [], skipped: [] };
	}
	const out: (SubtitleTrack & { streamIndex: number })[] = [];
	const skipped: string[] = [];
	for (const s of streams) {
		const codec = (s.codec_name ?? '').toLowerCase();
		if (!TEXT_SUB_CODECS.has(codec)) {
			if (codec) skipped.push(codec);
			continue;
		}
		const rawLang = s.tags?.language?.toLowerCase();
		const lang = rawLang && rawLang !== 'und' ? (LANG3_PUBLIC[rawLang] ?? rawLang) : null;
		const title = s.tags?.title ?? '';
		const forced = !!s.disposition?.forced || /forced/i.test(title);
		// `hearing_impaired` is the container's own SDH flag; the title is the fallback, because
		// plenty of rips set neither reliably.
		const captions = !!s.disposition?.hearing_impaired || /\b(sdh|cc|hi)\b/i.test(title);
		const name = lang ? (LANG_NAMES_PUBLIC[lang.split('-')[0]] ?? lang.toUpperCase()) : (title || 'Unknown');
		const suffix = [captions ? 'SDH' : null, forced ? 'forced' : null].filter(Boolean).join(', ');
		out.push({
			lang,
			label: suffix ? `${name} (${suffix})` : name,
			kind: captions ? 'captions' : 'subtitles',
			forced,
			path: '', // embedded tracks have no path — streamIndex identifies them
			streamIndex: s.index
		});
	}
	return { tracks: out, skipped };
}
