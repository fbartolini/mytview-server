/**
 * Shared setup for server unit tests: a throwaway MEDIA_ROOT + data dir wired into process.env
 * BEFORE the test dynamically imports server modules (config.ts reads env once at import time —
 * so call tempEnv() at module top, then `await import(...)` the code under test). Each test file
 * runs in its own forked process (vitest.config.ts), so the db/state singletons stay scoped to
 * that file's temp dirs.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestEnv {
	base: string;
	mediaRoot: string;
	dataDir: string;
	cleanup: () => void;
}

/** Create temp dirs and point the server's env at them. */
export function tempEnv(): TestEnv {
	const base = mkdtempSync(path.join(tmpdir(), 'mytview-test-'));
	const mediaRoot = path.join(base, 'media');
	const dataDir = path.join(base, 'data');
	mkdirSync(mediaRoot, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	process.env.MEDIA_ROOT = mediaRoot;
	process.env.DB_PATH = path.join(dataDir, 'index.db');
	process.env.HLS_DIR = 'off';
	process.env.IMAGE_CACHE_DIR = 'off'; // default-on since 2026-08-09 — keep tests ffmpeg-free
	process.env.SCAN_ON_START = '0';
	return {
		base,
		mediaRoot,
		dataDir,
		cleanup: () => rmSync(base, { recursive: true, force: true })
	};
}

/** Write a minimal ytdl-style channel video: `<channel>/<id>.info.json` + an empty `<id>.mp4`. */
export function writeChannelVideo(
	mediaRoot: string,
	channel: string,
	id: string,
	info: Record<string, unknown> = {}
): void {
	const dir = path.join(mediaRoot, channel);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, `${id}.info.json`),
		JSON.stringify({ id, title: id, duration: 100, ...info })
	);
	writeFileSync(path.join(dir, `${id}.mp4`), '');
}

/** Write a minimal Sonarr-style show: `<lib>/<show>/tvshow.nfo` (title + genres) + one S01E01 file. */
export function writeShow(mediaRoot: string, libPath: string, show: string, genres: string[] = []): void {
	const season = path.join(mediaRoot, libPath, show, 'Season 1');
	mkdirSync(season, { recursive: true });
	writeFileSync(
		path.join(mediaRoot, libPath, show, 'tvshow.nfo'),
		'<tvshow><title>' + show + '</title>' + genres.map((g) => '<genre>' + g + '</genre>').join('') + '</tvshow>'
	);
	writeFileSync(path.join(season, `${show} - S01E01 - Pilot.mkv`), 'x');
}

/** Write a Radarr-style movie folder under a movies library: `<lib>/<folder>/<folder>.mkv` +
 *  `movie.nfo` (from the given XML fields) + optional poster.jpg/fanart.jpg. */
export function writeMovie(
	mediaRoot: string,
	libPath: string,
	folder: string,
	opts: { nfo?: string | null; poster?: boolean; fanart?: boolean; ext?: string } = {}
): void {
	const dir = path.join(mediaRoot, libPath, folder);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, `${folder}${opts.ext ?? '.mkv'}`), 'x');
	if (opts.nfo !== null) {
		writeFileSync(path.join(dir, 'movie.nfo'), opts.nfo ?? '<movie><title>' + folder + '</title></movie>');
	}
	if (opts.poster) writeFileSync(path.join(dir, 'poster.jpg'), '');
	if (opts.fanart) writeFileSync(path.join(dir, 'fanart.jpg'), '');
}
