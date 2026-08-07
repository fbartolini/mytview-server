/** Traversal-guarded resolution + Range-aware file serving for media/images. */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { error } from '@sveltejs/kit';
import { MEDIA_ROOT } from './config';

const MIME: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/x-m4v',
	'.mkv': 'video/x-matroska',
	'.webm': 'video/webm',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.gif': 'image/gif'
};

/**
 * Resolve a stored MEDIA_ROOT-relative path safely (guards traversal) and stat it.
 *
 * The stat is ASYNC on purpose. Media lives on an NFS-mounted spinning array; a cold
 * file can block for several seconds on disk spin-up. Doing this with `fs.statSync`
 * froze the whole Node event loop — one cold video stalled every other request (a
 * concurrent /api/status jumped to ~2s). Async keeps the loop responsive; the cold
 * file itself is still gated by the disk (fix that at the storage layer).
 */
export async function resolveInMediaRoot(
	relPath: string | null | undefined
): Promise<{ absPath: string; stat: fs.Stats }> {
	if (!relPath) throw error(404);
	const absPath = path.resolve(MEDIA_ROOT, relPath);
	if (absPath !== MEDIA_ROOT && !absPath.startsWith(MEDIA_ROOT + path.sep)) {
		throw error(403, 'path outside media root');
	}
	let st: fs.Stats;
	try {
		st = await stat(absPath);
	} catch {
		throw error(404);
	}
	if (!st.isFile()) throw error(404);
	return { absPath, stat: st };
}

/**
 * Serve a file, honoring Range (206), HEAD probes (headers only), and If-None-Match
 * (304). Takes the already-resolved path + stat from resolveInMediaRoot so it never
 * stats twice. Native players (AVPlayer/ExoPlayer/AVPlay) HEAD-probe then Range-GET.
 */
export function serveFile(request: Request, absPath: string, st: fs.Stats): Response {
	const size = st.size;
	const type = MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
	const etag = `"${size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
	const headers: Record<string, string> = {
		'content-type': type,
		'accept-ranges': 'bytes',
		'last-modified': st.mtime.toUTCString(),
		etag,
		// `private` keeps shared caches out (these URLs are cookie- or signature-authorized; a proxy
		// serving one user's bytes to another is the failure mode). `max-age` finally gives BROWSER
		// caches explicit permission to reuse images without a revalidation round-trip — the whole
		// point of the window-aligned signed URLs (mediaToken.ts) is that the URL is a stable cache
		// key; 1h stays comfortably inside the shortest signature window we mint (2h share HLS).
		'cache-control': 'private, max-age=3600'
	};

	// Revalidation: let repeat loads (thumbnails, artwork) skip a re-fetch.
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers });
	}

	// HEAD probe: return metadata (length/accept-ranges/etag) with no body — and don't
	// open a read stream. Players do this to learn the size before Range-requesting.
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers: { ...headers, 'content-length': String(size) } });
	}

	const range = request.headers.get('range');
	const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
	if (m) {
		let start = m[1] === '' ? NaN : parseInt(m[1], 10);
		let end = m[2] === '' ? NaN : parseInt(m[2], 10);
		if (Number.isNaN(start) && !Number.isNaN(end)) {
			start = Math.max(0, size - end); // suffix range: bytes=-N
			end = size - 1;
		} else if (!Number.isNaN(start) && Number.isNaN(end)) {
			end = size - 1;
		}
		if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
			return new Response(null, {
				status: 416,
				headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' }
			});
		}
		end = Math.min(end, size - 1);
		const stream = Readable.toWeb(fs.createReadStream(absPath, { start, end }));
		return new Response(stream as unknown as ReadableStream, {
			status: 206,
			headers: {
				...headers,
				'content-range': `bytes ${start}-${end}/${size}`,
				'content-length': String(end - start + 1)
			}
		});
	}

	const stream = Readable.toWeb(fs.createReadStream(absPath));
	return new Response(stream as unknown as ReadableStream, {
		status: 200,
		headers: { ...headers, 'content-length': String(size) }
	});
}
