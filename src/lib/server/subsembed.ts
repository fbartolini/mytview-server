/**
 * Embedded subtitle tracks — ask the container what it has, and extract one as WebVTT.
 *
 * ASKED AT PLAYBACK TIME, NEVER PERSISTED. An earlier version stored the probe result in the
 * database against the file's mtime. That was the wrong instinct twice over: ffprobe is a header
 * read (tens of ms — the *extraction* is what costs, and that is keyed by content and cached on
 * disk), and persisting it created a cache that could go stale, a second writer for a table the
 * scan already owned, and a poisoned state where a file marked "probed" whose rows had been wiped
 * would never be looked at again. All of that vanishes if the answer is simply recomputed: it is
 * always current, there is one writer, and there is nothing to invalidate.
 *
 * A bounded in-memory memo keyed by (path, mtime) keeps repeat views free without any of that.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { EMBEDDED_SUBS, MEDIA_ROOT, PREFER_HLS_TEXT_STREAMS, SUBS_CACHE_DIR } from './config';
import { db } from './db';
import { subtitlesFor } from './queries';
import { parseProbedStreams, LANG3_PUBLIC, LANG_NAMES_PUBLIC, type SubtitleTrack } from './subtitles';

const execFileP = promisify(execFile);

/** Containers worth looking inside. mp4 can carry mov_text; webm/mkv carry the rest. */
const PROBE_EXTS = new Set(['.mkv', '.mp4', '.m4v', '.webm']);

export type EmbeddedTrack = SubtitleTrack & { streamIndex: number };

export interface AudioTrack {
	/** Absolute stream index — what `-map 0:<index>` takes. */
	index: number;
	lang: string | null;
	/** Menu text: "English · 5.1", "Italian · stereo", "Track 3" when the file says nothing. */
	label: string;
	/** The container's own default flag: what plays when nobody chooses. */
	default: boolean;
}

const audioMemo = new Map<string, AudioTrack[]>();

/** Codec names as a viewer would recognise them — often the only thing separating two tracks. */
const CODEC_NAMES: Record<string, string> = {
	aac: 'AAC', ac3: 'AC3', eac3: 'E-AC3', dts: 'DTS', truehd: 'TrueHD', flac: 'FLAC',
	opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', pcm_s16le: 'PCM', pcm_s24le: 'PCM'
};

/**
 * The audio tracks inside this file. Asked live and memoised per (path, mtime), same as subtitles —
 * a cached answer that could go stale is what made the subtitle feature fail twice.
 *
 * Labels are built server-side so every client shows the same words. Two tracks in one language are
 * common (a stereo mix and a 5.1), so the channel layout is part of the label — without it a menu
 * reads "Italian, Italian" and the viewer has to guess which is which.
 */
export async function audioTracks(relPath: string, mtime: number): Promise<AudioTrack[]> {
	if (!PROBE_EXTS.has(path.extname(relPath).toLowerCase())) return [];
	const key = `${relPath}|${Math.trunc(mtime)}`;
	const memo = audioMemo.get(key);
	if (memo) return memo;

	let tracks: AudioTrack[] = [];
	try {
		const { stdout } = await execFileP(
			'ffprobe',
			[
				'-v', 'error', '-probesize', '5M', '-analyzeduration', '0',
				'-select_streams', 'a',
				'-show_entries', 'stream=index,channels,codec_name:stream_tags=language,title:stream_disposition=default',
				'-of', 'json',
				path.join(MEDIA_ROOT, relPath)
			],
			{ timeout: 8_000, maxBuffer: 1 << 20 }
		);
		const streams = (JSON.parse(stdout) as {
			streams?: {
				index: number;
				channels?: number;
				codec_name?: string;
				tags?: { language?: string; title?: string };
				disposition?: Record<string, number>;
			}[];
		}).streams ?? [];
		tracks = streams.map((st, i) => {
			const raw = st.tags?.language?.toLowerCase();
			const lang = raw && raw !== 'und' ? (LANG3_PUBLIC[raw] ?? raw) : null;
			const name = lang ? (LANG_NAMES_PUBLIC[lang.split('-')[0]] ?? lang.toUpperCase()) : null;
			const layout =
				st.channels === 1 ? 'mono' : st.channels === 2 ? 'stereo' : st.channels === 6 ? '5.1'
					: st.channels === 8 ? '7.1' : st.channels ? `${st.channels}ch` : null;
			// LANGUAGE FIRST, always. An earlier version led with the stream's `title` on the
			// assumption it would say something a language code cannot ("Commentary", "Original").
			// Real releases put CODEC blurb there — "AC3 5.1 @ DOLBY" — so the menu showed three
			// tracks and no language at all. Codec follows the layout because it is often the only
			// thing separating two tracks of the same language.
			const parts = [name ?? `Track ${i + 1}`, layout, CODEC_NAMES[st.codec_name ?? ''] ?? null];
			return {
				index: st.index,
				lang,
				label: parts.filter(Boolean).join(' · '),
				default: !!st.disposition?.default
			};
		});
		// Two tracks can be genuinely different — a standard mix and a narrated/audio-described one —
		// while the container records nothing that says so (Plex shows them identically for the same
		// reason). Number the duplicates rather than inventing a distinction we cannot know:
		// "Italian · 5.1 · E-AC3" and "… (2)" at least let someone pick the other one.
		const seen = new Map<string, number>();
		tracks = tracks.map((t) => {
			const n = (seen.get(t.label) ?? 0) + 1;
			seen.set(t.label, n);
			return n === 1 ? t : { ...t, label: `${t.label} (${n})` };
		});
	} catch {
		tracks = [];
	}
	if (audioMemo.size >= PROBE_MEMO_MAX) audioMemo.delete(audioMemo.keys().next().value as string);
	audioMemo.set(key, tracks);
	return tracks;
}

/** Audio tracks for a video id — the path/mtime lookup every caller would otherwise repeat. */
export async function audioTracksFor(videoId: string): Promise<AudioTrack[]> {
	const v = db()
		.prepare('SELECT video_path, mtime, peer_id FROM videos WHERE id = ?')
		.get(videoId) as { video_path: string; mtime: number; peer_id: string | null } | undefined;
	if (!v || v.peer_id != null) return []; // a peer describes its own file
	return audioTracks(v.video_path, v.mtime);
}

/** SERVER DECISION (contract §playback descriptor `preferHls`): should clients START on HLS because
 *  the container carries too many embedded text streams? Field-pinned 2026-09-18 on a 2018 Samsung
 *  panel: 44 interleaved SRT streams choke the demuxer in BOTH the HTML5 and native engines while
 *  every health metric reads perfect — nothing fires the error the fail-open ladder waits for, so
 *  the decision can only live here, where the stream count is known. The HLS rung drops the text
 *  tracks (they are served separately as WebVTT). 0 disables. */
export function prefersHlsForTextStreams(embeddedTextStreams: number): boolean {
	return PREFER_HLS_TEXT_STREAMS > 0 && embeddedTextStreams > PREFER_HLS_TEXT_STREAMS;
}

/** One track as every caller sees it: sidecar (path) or embedded (streamIndex), never both. */
export interface ResolvedTrack {
	lang: string | null;
	label: string;
	kind: 'captions' | 'subtitles';
	path: string | null;
	streamIndex: number | null;
}

/**
 * THE list of subtitle tracks for a video: sidecars found by the scan, then whatever is inside the
 * container right now. One function so the descriptor, the web page and /subs/[id]/[n] all agree on
 * what index N means — they used to derive it separately, which is how an index can silently point
 * at a different track than the one the viewer picked.
 */
export async function resolveTracks(videoId: string): Promise<ResolvedTrack[]> {
	const v = db()
		.prepare('SELECT video_path, mtime, peer_id FROM videos WHERE id = ?')
		.get(videoId) as { video_path: string; mtime: number; peer_id: string | null } | undefined;
	if (!v) return [];
	const sidecars: ResolvedTrack[] = subtitlesFor(videoId).map((t) => ({
		lang: t.lang,
		label: t.label,
		kind: t.kind,
		path: t.path,
		streamIndex: null
	}));
	// Federated rows describe a peer's file; its subtitles come from the peer's own descriptor.
	if (v.peer_id != null) return sidecars;
	const embedded = (await embeddedTracks(v.video_path, v.mtime)).map((t) => ({
		lang: t.lang,
		label: t.label,
		kind: t.kind,
		path: null,
		streamIndex: t.streamIndex
	}));
	return [...sidecars, ...embedded];
}

// (path|mtime) → tracks. Memory only: a restart re-asks, which costs one header read and can never
// be wrong. Bounded because a big library would otherwise accumulate an entry per file viewed.
const probeMemo = new Map<string, EmbeddedTrack[]>();
const PROBE_MEMO_MAX = 500;

/**
 * The subtitle tracks inside this file, right now. Returns [] for anything we can't or shouldn't
 * look at — no ffprobe, an unreadable file, a container with only bitmap subtitles, or the owner
 * having set EMBEDDED_SUBS=off. Never throws: subtitles are an enhancement, never a reason a video
 * page fails to load.
 */
export async function embeddedTracks(relPath: string, mtime: number): Promise<EmbeddedTrack[]> {
	if (!EMBEDDED_SUBS) return [];
	if (!PROBE_EXTS.has(path.extname(relPath).toLowerCase())) return [];
	const key = `${relPath}|${Math.trunc(mtime)}`;
	const memo = probeMemo.get(key);
	if (memo) return memo;

	let tracks: EmbeddedTrack[] = [];
	try {
		const { stdout } = await execFileP(
			'ffprobe',
			[
				'-v', 'error',
				// Header-only: MKV/MP4 declare every track up front, so there is no reason to read
				// packets. This is what keeps the call cheap enough to make on a request.
				'-probesize', '5M', '-analyzeduration', '0',
				'-select_streams', 's',
				'-show_entries', 'stream=index,codec_name:stream_tags=language,title:stream_disposition=forced,hearing_impaired,default',
				'-of', 'json',
				path.join(MEDIA_ROOT, relPath)
			],
			{ timeout: 8_000, maxBuffer: 1 << 20 }
		);
		const probed = parseProbedStreams(stdout);
		tracks = probed.tracks;
		if (probed.skipped.length && !tracks.length) {
			// Prescriptive, like the .nfo requirement: text subtitles are supported, PGS/VobSub are
			// pictures of text and would need OCR or a burn-in transcode. Say which file and codec, so
			// an empty menu is explainable rather than mysterious.
			console.warn(
				`[mytview] subs: ${relPath} has only image-based subtitles (${[...new Set(probed.skipped)].join(', ')}) — not supported; add a text (.srt) version`
			);
		}
	} catch {
		tracks = [];
	}

	if (probeMemo.size >= PROBE_MEMO_MAX) probeMemo.delete(probeMemo.keys().next().value as string);
	probeMemo.set(key, tracks);
	return tracks;
}

/**
 * Extracted WebVTT, cached on DISK and in memory.
 *
 * This is the expensive half of the feature and the cost is unavoidable: pulling one stream out of
 * a Matroska file makes ffmpeg demux the entire container, so a 40-minute episode on network
 * storage is a multi-second, I/O-heavy read — competing with the very file being streamed to the
 * player. Hence three rules, learned the hard way from a server that went unplayable:
 *   1. ONCE PER FILE, EVER — a disk cache, so a restart doesn't redo it.
 *   2. ONE AT A TIME — a global queue, so picking captions on two videos can't double the load.
 *   3. Never on the playback path — the result is a small text file once it exists.
 */
const memCache = new Map<string, string>();
const MEM_CACHE_MAX = 40;
let chain: Promise<unknown> = Promise.resolve(); // global serialiser (rule 2)

/** Run `fn` after every other extraction. One reader of one disk at a time, always. */
function queue<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(fn);
	chain = run.catch(() => {});
	return run;
}

const cacheKey = (relPath: string, streamIndex: number, mtime: number) =>
	createHash('sha1').update(`${relPath}|${streamIndex}|${Math.trunc(mtime)}`).digest('hex');

/** Extract one embedded track as WebVTT. Returns null if ffmpeg isn't there or the track won't convert. */
export async function extractEmbeddedVtt(
	relPath: string,
	streamIndex: number,
	mtime: number
): Promise<string | null> {
	const key = cacheKey(relPath, streamIndex, mtime);
	const hit = memCache.get(key);
	if (hit !== undefined) return hit;

	const file = SUBS_CACHE_DIR ? path.join(SUBS_CACHE_DIR, `${key}.vtt`) : null;
	if (file) {
		try {
			const cached = await readFile(file, 'utf-8');
			remember(key, cached);
			return cached;
		} catch {
			/* not cached yet */
		}
	}

	// Queue behind any extraction already running. Serialising is deliberate: these are I/O-bound
	// reads of huge files, and running several at once is how a library on any disk stalls playback.
	const vtt = await queue(() => extractOnce(relPath, streamIndex));
	if (vtt === null) return null;

	remember(key, vtt);
	if (file) {
		try {
			await mkdir(path.dirname(file), { recursive: true });
			// Write-then-rename: a half-written cache file must never be served as a subtitle track.
			const tmp = `${file}.${process.pid}.tmp`;
			await writeFile(tmp, vtt, 'utf-8');
			await rename(tmp, file);
		} catch {
			/* cache is an optimisation — a failure here costs a re-extract, nothing more */
		}
	}
	return vtt;
}

function remember(key: string, vtt: string): void {
	if (memCache.size >= MEM_CACHE_MAX) memCache.delete(memCache.keys().next().value as string);
	memCache.set(key, vtt);
}

function extractOnce(relPath: string, streamIndex: number): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		// -map 0:<absolute index> takes exactly the stream ffprobe reported, so the numbering can't
		// drift between probe and extract the way `0:s:N` (nth subtitle stream) would. -vn -an so
		// ffmpeg never touches the video/audio streams while walking the container.
		const proc = spawn(
			'ffmpeg',
			['-v', 'error', '-nostdin', '-threads', '1', '-i', path.join(MEDIA_ROOT, relPath),
			 '-map', `0:${streamIndex}`, '-vn', '-an', '-f', 'webvtt', '-'],
			{ stdio: ['ignore', 'pipe', 'ignore'] }
		);
		let out = '';
		const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000); // a stuck read must not pin a slot
		proc.stdout.on('data', (d) => {
			out += d.toString();
			if (out.length > 8 << 20) proc.kill('SIGKILL'); // a runaway/mislabelled stream, not a subtitle
		});
		proc.on('error', () => {
			clearTimeout(timer);
			resolve(null); // ffmpeg missing → same as no track
		});
		proc.on('close', (code) => {
			clearTimeout(timer);
			resolve(code === 0 && out.trim() ? out : null);
		});
	});
}
