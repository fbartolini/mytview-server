<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { fmtDuration } from '$lib/format';
	import { noteWatch } from '$lib/watchStore';
	import type Hls from 'hls.js'; // type-only; the library itself is lazy-imported when a video needs HLS
	import type { VideoSummary } from '$lib/types';

	let {
		id,
		title,
		channel,
		thumbPath,
		watch,
		watchedAt = null,
		resumePosition = null,
		autoplayNext = true,
		stillWatchingAfter = 3,
		preferCompat = false,
		hlsEnabled = false,
		srcUrl = null,
		hlsUrl = null,
		remote = false,
		width = null,
		height = null
	}: {
		id: string;
		title: string;
		channel: string;
		thumbPath: string | null;
		watch: { position: number; watched: boolean };
		// Server-owned watch decisions (see watch.ts): when to auto-mark-watched, and where to resume
		// to (null = start from the beginning). Clients no longer decide these locally.
		watchedAt?: number | null;
		resumePosition?: number | null;
		// Server-owned playback prefs (/api/v1/me): whether to auto-advance, and after how many
		// unattended auto-advances to ask "Are you still watching?" (0 = never).
		autoplayNext?: boolean;
		stillWatchingAfter?: number;
		// The source can't be reliably web-direct-played (a .mkv / Chrome-silent audio: video plays but
		// audio silently drops with no error) → start on live HLS instead of fail-open. Server-computed
		// and already gated on HLS being enabled. See webPrefersCompat / the video load.
		preferCompat?: boolean;
		// On-the-fly HLS is available on this server → on a decode failure the player switches to a
		// seconds-to-start live transcode (hls.js / native). The ONLY fallback tier.
		hlsEnabled?: boolean;
		// FEDERATED playback (contract §Federation): the load supplies ABSOLUTE peer-signed URLs and
		// the player uses them verbatim (the web mirror of the natives' absolute passthrough). Null =
		// local video → the same-origin literals below. `remote` arms a one-shot URL refresh on error
		// (peer-signed URLs expire; a page-data refresh re-mints them).
		srcUrl?: string | null;
		hlsUrl?: string | null;
		remote?: boolean;
		width?: number | null;
		height?: number | null;
	} = $props();

	// Local defaults preserve the pre-federation same-origin behavior byte-for-byte.
	const mediaSrc = $derived(srcUrl ?? `/media/${encodeURIComponent(id)}`);
	const hlsSrc = $derived(hlsUrl ?? `/hls/v/${encodeURIComponent(id)}/index.m3u8`);
	let refreshTried = false; // one-shot remote URL refresh per mount

	let videoEl: HTMLVideoElement;
	let watched = $state(untrack(() => watch.watched));
	let resumedAt = $state(0);
	let lastSaved = 0;
	// Canonical resume-write throttle shared by every client (WS-E in docs/native-clients-plan.md);
	// mirrored by MytViewKit.WatchReporter. Keep these two in sync — flush-on-pause/exit is separate.
	const SAVE_THROTTLE_MS = 15000;

	// Portrait (Shorts) videos are taller than they are wide; sized full-width they overflow the
	// viewport, so we cap height and let them center (no pillarbox). Falls back to landscape sizing
	// when dimensions are unknown.
	const portrait = $derived(!!width && !!height && height > width);

	// "Theater" — expand the player to fit the browser window (width for landscape, height for
	// portrait) without entering OS fullscreen. It's a fixed overlay, not the Fullscreen API, so the
	// same <video> element keeps playing (toggling classes, not re-rendering, preserves playback).
	let expanded = $state(false);
	function toggleExpand() {
		expanded = !expanded;
	}
	$effect(() => {
		if (!expanded) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') expanded = false;
		};
		window.addEventListener('keydown', onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden'; // lock background scroll while expanded
		return () => {
			window.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
		};
	});
	const frameClass = $derived(
		expanded
			? 'fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-2 sm:p-4'
			: 'relative'
	);
	const videoClass = $derived(
		expanded
			? 'max-h-full max-w-full rounded-lg bg-black'
			: portrait
				? 'mx-auto block max-h-[calc(100vh_-_10rem)] max-w-full rounded-lg border border-line bg-black'
				: 'w-full max-h-[calc(100vh_-_10rem)] rounded-lg border border-line bg-black object-contain'
	);

	// --- end-of-playback card + autoplay-next ---
	let ended = $state(false);
	let stillWatching = $state(false); // "Are you still watching?" gate before continuing autoplay
	let next = $state<VideoSummary | null>(null); // top related video, used as "up next"
	let countdown = $state(0);
	let timer: ReturnType<typeof setInterval> | null = null;
	const AUTONEXT_SECS = 8;
	// Count of consecutive UNATTENDED auto-advances, kept across page navigations (each advance is a
	// goto). Reset when the user interacts, so "still watching?" fires only during a hands-off run.
	const ADVANCE_KEY = 'myt-view:autoAdvances';
	const ADVANCING_KEY = 'myt-view:autoAdvancing'; // set right before an auto-advance goto
	const advanceCount = () => Number(sessionStorage.getItem(ADVANCE_KEY) || '0');
	// "Back after autoplay → last-played video's detail" (contract, all clients): the player is reached
	// by navigating to the video's detail; advancing to the next video REPLACES the current history
	// entry instead of pushing, so an autoplay run collapses to a single entry. Net effect: leaving the
	// player lands on the CURRENT (last-played) video's detail, and one more Back goes to whatever was
	// below the launched-from detail (the feed/channel) — not back through each auto-advanced video. If
	// no autoplay happened this is a no-op (nothing was advanced). Every "go to next" path routes here.
	const goNext = () => {
		if (next) goto(`/video/${encodeURIComponent(next.id)}`, { replaceState: true });
	};
	function advanceToNext() {
		sessionStorage.setItem(ADVANCE_KEY, String(advanceCount() + 1));
		sessionStorage.setItem(ADVANCING_KEY, '1');
		goNext();
	}
	function continueWatching() {
		sessionStorage.setItem(ADVANCE_KEY, '0'); // attended → reset the run, then keep going
		sessionStorage.setItem(ADVANCING_KEY, '1');
		goNext();
	}

	// --- fallback-on-failure (for sources the web <video> can't decode) ---
	// On-the-fly HLS (live transcode): onHls = playing the HLS stream; hlsNative = Safari's native
	// HLS via the src attribute vs hls.js over MSE (Chrome/Firefox — the <video> gets no src, hls.js drives it).
	let onHls = $state(false);
	let hlsNative = $state(false);
	let hlsInst: Hls | null = null; // the hls.js instance (MSE path) — destroyed on teardown
	let codecFail = $state(false); // original couldn't decode and this server has no HLS → honest error
	let hlsFailed = $state(false); // the live HLS path exhausted recovery → a simple, honest error
	let hlsRecoveries = 0; // bounded hls.js self-heals (recoverMediaError / startLoad) before giving up
	const MAX_HLS_RECOVERIES = 3;

	// Mid-playback recovery: a DECODE error AFTER the video has been playing is a bad spot in the FILE — most
	// often a splice (a promo cut out by yt-dlp leaves a broken GOP + brief a/v desync at the join). Retrying
	// AT the same spot re-hits it, so SKIP FORWARD past it and resume — exactly what you'd do by hand in Plex,
	// and it re-syncs audio too. Gated on `hasPlayed`: a true codec incompatibility errors before any frame
	// decodes (pos 0) → straight to the HLS fallback. Progressive + bounded; only unclearable breakage falls back.
	const SKIP_SECONDS = 2; // how far to jump past the bad spot on each attempt
	const MAX_DECODE_SKIPS = 6; // stop after ~12s of unclearable breakage → fall back to HLS
	let lastPos = 0; // last playback position (ontimeupdate)
	let hasPlayed = false; // true once a frame actually decoded (onplaying) — a pos-0 decode failure never sets it
	let decodeRetries = 0; // skips taken at the current bad spot
	let retryFromPos = -1; // >=0 while recovering: onLoaded seeks here (the skip target) instead of the resume point

	function clearTimer() {
		if (timer) clearInterval(timer);
		timer = null;
		countdown = 0;
	}
	function startCountdown() {
		clearTimer();
		countdown = AUTONEXT_SECS;
		timer = setInterval(() => {
			countdown -= 1;
			if (countdown <= 0) {
				clearTimer();
				advanceToNext();
			}
		}, 1000);
	}
	function cancelNext() {
		clearTimer(); // keeps the card up so it can still be picked manually
		sessionStorage.setItem(ADVANCE_KEY, '0'); // user is present → reset the unattended run
	}
	function replay() {
		clearTimer();
		ended = false;
		startOver();
	}
	function back() {
		clearTimer();
		if (typeof history !== 'undefined' && history.length > 1) history.back();
		else goto('/');
	}

	// /media is behind the login guard, so an ended session (revoked, or the server lost it) makes the
	// <video>'s next Range request return 401 — the browser can't decode the 401 body and reports a DECODE
	// error. That's the usual cause of a "can't play" appearing mid-playback on a video that was playing
	// fine — NOT a codec problem. Probe /api/status to tell the two apart before failing over.
	async function sessionEnded(): Promise<boolean> {
		try {
			return (await fetch('/api/status', { cache: 'no-store' })).status === 401;
		} catch {
			return false; // network error → not an auth verdict; treat it as a real playback error
		}
	}
	function toLogin() {
		goto(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
	}

	async function onError() {
		const err = videoEl?.error;
		// Diagnostic: one line per media error so a single reproduction shows the exact code + reason.
		console.warn(
			`[mytview build=skip] media error code=${err?.code ?? '?'} pos=${Math.round(lastPos)}s hls=${onHls} retries=${decodeRetries} — ${err?.message ?? ''}`
		);
		if (hlsFailed) return; // already gave up on HLS (the element has no source) — ignore stray errors
		// Remote (federated) source: the peer-signed URLs expire (12–24h media / 2–4h HLS), and an
		// expired signature surfaces as a fake decode/network error. Before any fallback ladder,
		// refresh the page data ONCE — the load re-mints absolute URLs from the peer. A real failure
		// recurs immediately and proceeds down the normal ladder. sessionEnded() below stays pinned to
		// the HOME origin, so a peer-side 401 can never bounce the user to login.
		if (remote && !refreshTried) {
			refreshTried = true;
			await invalidateAll();
			videoEl?.load();
			videoEl?.play?.().catch(() => {});
			return;
		}
		if (onHls) {
			// We're on the live HLS path — never fall back to the (undecodable) original; that just loops.
			if (await sessionEnded()) return toLogin();
			if (hlsInst) return; // hls.js owns recovery via its ERROR handler → ignore the element's echo
			giveUpHls(); // native (Safari) HLS has no recovery hook → a simple, honest error
			return;
		}
		const code = err?.code;
		if (code !== 3 && code !== 4) return; // 3=DECODE, 4=SRC_NOT_SUPPORTED; ignore network/abort
		if (await sessionEnded()) return toLogin(); // an expired session masquerading as a decode error
		// Played, then a DECODE error → a bad spot in the file (usually a yt-dlp promo splice). Skip FORWARD
		// past it and resume, reloading to reset the decoder. Each attempt jumps a bit further (from the last
		// skip target, so it advances even if currentTime is stale), until it clears the broken region or the
		// budget runs out. A codec the browser can't decode at all never set `hasPlayed` (fails at pos 0).
		if (code === 3 && hasPlayed && decodeRetries < MAX_DECODE_SKIPS) {
			const from = retryFromPos >= 0 ? retryFromPos : videoEl?.currentTime || lastPos;
			decodeRetries++;
			retryFromPos = from + SKIP_SECONDS; // seek PAST the bad spot, not into it
			videoEl?.load(); // onLoaded seeks to retryFromPos + resumes
			return;
		}
		if (hlsEnabled) return void switchToHls(); // live transcode → starts in seconds, no prompt
		codecFail = true; // no fallback on this server (HLS disabled) → honest error
	}
	// Live HLS fallback: starts in SECONDS. Safari plays the playlist natively via the src attribute;
	// everywhere else hls.js drives it over MSE. The ONLY fallback tier (the whole-file compat copy was
	// removed) — if HLS itself can't run, the honest error card is the end of the line.
	async function switchToHls() {
		if (onHls) return;
		codecFail = false;
		hlsFailed = false;
		hlsRecoveries = 0;
		if (videoEl?.canPlayType('application/vnd.apple.mpegurl')) {
			hlsNative = true; // Safari / iOS: native HLS via the src attribute (required on iOS, and lighter)
			onHls = true;
			await tick(); // let the src flip to the .m3u8 playlist
			videoEl?.load();
			videoEl?.play?.().catch(() => {});
			return;
		}
		try {
			const { default: HlsCtor } = await import('hls.js'); // lazy: kept out of the initial bundle
			if (!HlsCtor.isSupported()) return void (codecFail = true); // no MSE → nothing left to try
			onHls = true;
			await tick(); // remove the <video> src attribute before hls.js attaches (avoid a double load)
			// Match the server's on-the-fly segment wait (45s): a slow NAS's first segment / cold far-seek can
			// take that long, and hls.js's default fragLoadingTimeOut (20s) would abort into a false failover.
			const inst = new HlsCtor({ fragLoadingTimeOut: 60_000, manifestLoadingTimeOut: 20_000 });
			hlsInst = inst;
			inst.on(HlsCtor.Events.ERROR, (_e, data) => {
				if (!data.fatal) return; // non-fatal → hls.js self-heals
				if (hlsRecoveries >= MAX_HLS_RECOVERIES) return void giveUpHls(); // recovery exhausted
				hlsRecoveries++;
				// A segment 503 while the on-the-fly transcode catches up → resume loading; anything else
				// (a malformed / out-of-DTS-sequence fragment at a splice) → flush + re-append past it.
				if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) inst.startLoad();
				else inst.recoverMediaError();
			});
			inst.loadSource(hlsSrc);
			inst.attachMedia(videoEl);
			videoEl?.play?.().catch(() => {});
		} catch {
			codecFail = true; // hls.js failed to load → nothing left to try
		}
	}
	function teardownHls() {
		hlsInst?.destroy();
		hlsInst = null;
		onHls = false;
		hlsNative = false;
	}
	function giveUpHls() {
		teardownHls();
		hlsFailed = true; // a simple, honest error (with Try again)
	}
	function retryHls() {
		teardownHls();
		hlsFailed = false;
		hlsRecoveries = 0;
		void switchToHls();
	}
	// Real playback started → any failure overlay is stale (HLS recovered, or the compat copy kicked in) and a
	// fresh recovery budget is due for a later, unrelated glitch. Also records that a frame actually decoded.
	function onPlaying() {
		hasPlayed = true;
		codecFail = false;
		hlsFailed = false;
		hlsRecoveries = 0;
	}

	// A known web-unplayable source (a .mkv / Chrome-silent audio — see preferCompat) plays video with
	// SILENT audio and no MediaError to trigger fail-open, so don't attempt the original at all — start
	// straight on the live HLS stream. preferCompat is server-computed and already gated on HLS being
	// enabled. Fires once per mount so an HLS failure can't re-trigger it; a no-op on the normal
	// fail-open path (preferCompat=false).
	let autoHlsTried = $state(false);
	$effect(() => {
		if (preferCompat && !onHls && !autoHlsTried) {
			autoHlsTried = true;
			void switchToHls();
		}
	});

	function post(patch: { position?: number; watched?: boolean }) {
		noteWatch(id, patch); // optimistic: update feed cards live on return
		fetch(`/api/watch/${encodeURIComponent(id)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch),
			keepalive: true
		}).catch(() => {});
	}

	function onLoaded() {
		// Recovering from a mid-playback decode error: seek back to where it failed and resume — not the
		// resume point, and no "resumed at" chrome (the user never left).
		if (retryFromPos >= 0 && videoEl) {
			videoEl.currentTime = retryFromPos;
			videoEl.play?.().catch(() => {});
			return;
		}
		// Resume to the server-decided point (already gated for watched / too-near-start / too-near-end).
		if (resumePosition != null && videoEl) {
			videoEl.currentTime = resumePosition;
			resumedAt = resumePosition;
		}
	}

	function onTime() {
		const t = videoEl.currentTime;
		lastPos = t;
		// Recovered well past a retried failure → clear the retry budget so a later, unrelated glitch gets its own.
		if (retryFromPos >= 0 && t > retryFromPos + 5) {
			decodeRetries = 0;
			retryFromPos = -1;
		}
		// Auto mark-watched at the server-computed threshold (null = unknown duration → only at end).
		if (!watched && watchedAt != null && t >= watchedAt) {
			watched = true;
			post({ position: t, watched: true });
			return;
		}
		const now = Date.now();
		if (!watched && now - lastSaved > SAVE_THROTTLE_MS) {
			lastSaved = now;
			post({ position: t });
		}
		updatePositionState(); // keep the lock-screen scrubber in sync
	}

	function saveNow() {
		if (videoEl && !watched && !videoEl.ended) post({ position: videoEl.currentTime });
	}

	function onEnded() {
		watched = true;
		post({ watched: true }); // server clears the resume point (position → 0)
		ended = true;
		setPlaybackState('paused');
		releaseWakeLock(); // playback stopped — let the display sleep during the end-card / gate
		if (!next || !autoplayNext) return;
		// After N unattended auto-advances, ask before continuing instead of auto-advancing.
		if (stillWatchingAfter > 0 && advanceCount() >= stillWatchingAfter) stillWatching = true;
		else startCountdown();
	}

	function toggleWatched() {
		watched = !watched;
		// Marking watched clears resume server-side; un-marking keeps the current spot to resume from.
		post(watched ? { watched: true } : { watched: false, position: videoEl?.currentTime ?? 0 });
	}

	function startOver() {
		if (videoEl) {
			videoEl.currentTime = 0;
			resumedAt = 0;
			videoEl.play?.();
		}
	}

	// --- Media Session: lock-screen / Control Center now-playing + working transport controls.
	// On iOS this is also what makes the WKWebView shell KEEP audio playing when backgrounded:
	// without a page-claimed media session, WebKit pauses the <video> on page-hide and the
	// lock-screen buttons are inert (banner shows, but Play does nothing). Pure web API — it also
	// lights up media keys / the macOS now-playing widget on desktop. No-op where unsupported.
	function mediaSession(): MediaSession | null {
		return typeof navigator !== 'undefined' && 'mediaSession' in navigator
			? navigator.mediaSession
			: null;
	}
	function setMediaMetadata() {
		const s = mediaSession();
		if (!s) return;
		try {
			s.metadata = new MediaMetadata({
				title: title || 'MytView',
				artist: channel || '',
				album: 'MytView',
				artwork: thumbPath
					? [96, 192, 512].map((n) => ({
							src: `/thumb/${encodeURIComponent(id)}`,
							sizes: `${n}x${n}`,
							type: 'image/jpeg'
						}))
					: []
			});
		} catch {
			/* MediaMetadata unsupported — ignore */
		}
	}
	function setMediaHandlers() {
		const s = mediaSession();
		if (!s) return;
		const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
			try {
				s.setActionHandler(action, handler);
			} catch {
				/* action unsupported on this platform — ignore */
			}
		};
		set('play', () => void videoEl?.play());
		set('pause', () => videoEl?.pause());
		set('seekbackward', (d) => {
			if (videoEl) videoEl.currentTime = Math.max(0, videoEl.currentTime - (d.seekOffset ?? 10));
		});
		set('seekforward', (d) => {
			if (videoEl)
				videoEl.currentTime = Math.min(
					videoEl.duration || Infinity,
					videoEl.currentTime + (d.seekOffset ?? 10)
				);
		});
		set('seekto', (d) => {
			if (videoEl && d.seekTime != null) videoEl.currentTime = d.seekTime;
		});
		// `next` resolves async (top related); read it live so the button works once it's known.
		// Routes through goNext so the media-key advance replaces history like every other advance.
		set('nexttrack', () => goNext());
		set('previoustrack', () => startOver());
	}
	function setPlaybackState(state: MediaSessionPlaybackState) {
		const s = mediaSession();
		if (s) s.playbackState = state;
	}
	function updatePositionState() {
		const s = mediaSession();
		if (!s || typeof s.setPositionState !== 'function' || !videoEl) return;
		const d = videoEl.duration;
		if (!d || !isFinite(d)) return;
		try {
			s.setPositionState({
				duration: d,
				playbackRate: videoEl.playbackRate || 1,
				position: Math.min(videoEl.currentTime, d)
			});
		} catch {
			/* transient invalid state (e.g. mid-seek) — ignore */
		}
	}
	// Screen Wake Lock — hold the display awake WHILE PLAYING so the OS screensaver can't interrupt a
	// video (⇔ Android keepScreenOn, iOS/tvOS isIdleTimerDisabled). Desktop Chrome usually inhibits the
	// screensaver during active <video> already, but that isn't guaranteed (other browsers, inline
	// playback), and the lock is the explicit, standard mechanism. `navigator as any` keeps this off the
	// TS lib version so `npm run check` stays clean. Gated on play/pause, so a paused video sleeps normally.
	let wakeLock: { release: () => Promise<void>; addEventListener?: (t: string, cb: () => void) => void } | null =
		null;
	async function acquireWakeLock() {
		try {
			const nav = navigator as any;
			if (nav.wakeLock && !wakeLock) {
				wakeLock = await nav.wakeLock.request('screen');
				// The lock auto-releases when the tab hides; null it so visibilitychange can re-acquire.
				wakeLock?.addEventListener?.('release', () => (wakeLock = null));
			}
		} catch {
			/* not permitted / tab not visible — the browser's own video-playback inhibition still applies */
		}
	}
	function releaseWakeLock() {
		wakeLock?.release?.().catch(() => {});
		wakeLock = null;
	}

	function onPlay() {
		setMediaMetadata(); // (re)assert now-playing info; iOS shows it only while actually playing
		setPlaybackState('playing');
		acquireWakeLock();
	}
	function onPause() {
		saveNow();
		setPlaybackState('paused');
		releaseWakeLock();
	}

	onMount(() => {
		// If we arrived by auto-advance keep the counter; a manual arrival resets the unattended run.
		if (sessionStorage.getItem(ADVANCING_KEY)) sessionStorage.removeItem(ADVANCING_KEY);
		else sessionStorage.setItem(ADVANCE_KEY, '0');
		setMediaMetadata();
		setMediaHandlers();
		const onHide = () => saveNow();
		window.addEventListener('pagehide', onHide);
		// The wake lock auto-releases when the tab hides; re-acquire it if we return while still playing.
		const onVis = () => {
			if (document.visibilityState === 'visible' && videoEl && !videoEl.paused && !videoEl.ended)
				acquireWakeLock();
		};
		document.addEventListener('visibilitychange', onVis);
		// Prefetch the "up next" candidate (top related). Fire-and-forget so it never
		// delays playback; if there's nothing related, the end-card just shows Replay/Back.
		fetch(`/api/related/${encodeURIComponent(id)}`)
			.then((r) => (r.ok ? r.json() : []))
			.then((items: VideoSummary[]) => (next = items[0] ?? null))
			.catch(() => {});
		return () => {
			window.removeEventListener('pagehide', onHide);
			document.removeEventListener('visibilitychange', onVis);
		};
	});
	onDestroy(() => {
		clearTimer();
		teardownHls(); // stop + free the hls.js instance (MSE path) if we were on the live HLS stream
		saveNow();
		releaseWakeLock(); // don't leave the screen pinned awake after leaving the player
		setPlaybackState('none'); // clear the now-playing state when leaving; a remount re-asserts it
	});
</script>

<div class={frameClass}>
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={videoEl}
		controls
		autoplay
		playsinline
		onloadedmetadata={onLoaded}
		ontimeupdate={onTime}
		onplay={onPlay}
		onplaying={onPlaying}
		onpause={onPause}
		onended={onEnded}
		onerror={onError}
		class={videoClass}
		poster={thumbPath ? `/thumb/${encodeURIComponent(id)}` : undefined}
		src={onHls ? (hlsNative ? hlsSrc : undefined) : hlsFailed ? undefined : mediaSrc}
	></video>

	{#if expanded}
		<button
			onclick={toggleExpand}
			aria-label="Exit theater view"
			title="Exit (Esc)"
			class="absolute top-3 right-3 z-10 rounded-lg bg-black/60 p-2 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/80"
		>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M18 6 6 18M6 6l12 12" />
			</svg>
		</button>
	{/if}

	{#if hlsFailed}
		<div
			class="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-lg bg-black/85 p-6 text-center backdrop-blur-sm"
		>
			<div class="max-w-xs">
				<div class="text-sm font-semibold">Couldn't play this video</div>
				<p class="mt-1 font-mono text-[11px] text-faint">The compatible stream didn't load.</p>
			</div>
			<button
				onclick={retryHls}
				class="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-content hover:opacity-90"
				>Try again</button
			>
		</div>
	{:else if codecFail}
		<div
			class="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-lg bg-black/85 p-6 text-center backdrop-blur-sm"
		>
			<div class="max-w-xs">
				<div class="text-sm font-semibold">Can't play on this device</div>
				<p class="mt-1 font-mono text-[11px] text-faint">
					This video's format isn't supported by this browser, and live transcoding is disabled on
					this server.
				</p>
			</div>
			<button
				onclick={() => (codecFail = false)}
				class="font-mono text-xs text-muted hover:text-base-content">dismiss</button
			>
		</div>
	{:else if ended}
		<div
			class="absolute inset-0 flex flex-col items-center justify-center gap-5 rounded-lg bg-black/85 p-6 text-center backdrop-blur-sm"
		>
			<button
				onclick={replay}
				class="rounded-lg border border-line px-4 py-2 font-mono text-sm hover:border-primary/60"
				>↻ Replay</button
			>

			{#if next}
				<div class="w-full max-w-xs">
					<div class="mb-1.5 font-mono text-[11px] tracking-widest text-faint uppercase">
						{stillWatching
							? 'Are you still watching?'
							: countdown > 0
								? `Up next in ${countdown}s`
								: 'Up next'}
					</div>
					<a
						href="/video/{encodeURIComponent(next.id)}"
						onclick={(e) => {
							// Manual "up next" pick advances the player like autoplay does: replace history via
							// goNext so leaving lands on this next video with one Back to the feed. Keep the href
							// for open-in-new-tab (modifier / non-primary clicks fall through to the browser).
							if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
							e.preventDefault();
							goNext();
						}}
						class="flex gap-2.5 rounded-lg border border-line bg-base-200 p-2 text-left hover:border-primary/60"
					>
						<div class="relative aspect-video w-28 shrink-0 overflow-hidden rounded bg-base-300">
							{#if next.thumb_path}
								<img
									src="/thumb/{encodeURIComponent(next.id)}"
									alt=""
									class="h-full w-full object-cover"
								/>
							{/if}
						</div>
						<div class="min-w-0 flex-1 py-0.5">
							<div class="line-clamp-2 text-xs leading-snug font-medium">{next.title}</div>
							<div class="mt-1 truncate font-mono text-[10px] text-muted">{next.channel_name}</div>
						</div>
					</a>
					{#if stillWatching}
						<button
							onclick={continueWatching}
							class="mt-2 rounded-md bg-primary px-3 py-1 font-mono text-[11px] font-medium text-primary-content hover:opacity-90"
							>Continue watching</button
						>
					{:else if countdown > 0}
						<button
							onclick={cancelNext}
							class="mt-2 font-mono text-[11px] text-muted hover:text-base-content"
							>cancel autoplay</button
						>
					{/if}
				</div>
			{/if}

			<button onclick={back} class="font-mono text-xs text-muted hover:text-base-content"
				>← back</button
			>
		</div>
	{/if}
</div>

<div class="mt-2.5 flex flex-wrap items-center gap-3 font-mono text-xs">
	{#if resumedAt > 0}
		<span class="text-muted"
			>resumed at {fmtDuration(resumedAt)} ·
			<button onclick={startOver} class="text-primary hover:underline">start over</button></span
		>
	{/if}
	<div class="ml-auto flex items-center gap-3">
		{#if !portrait}
			<!-- Theater = expand to the window WIDTH; only meaningful for landscape. Portrait videos
			     are already height-capped + centered, so no theater button there. -->
			<button
				onclick={toggleExpand}
				title="Theater — fit the player to the window (Esc to exit)"
				class="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-muted transition-colors hover:text-base-content"
			>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M8 21H5a2 2 0 0 1-2-2v-3m18 0v3a2 2 0 0 1-2 2h-3" />
				</svg>
				theater
			</button>
		{/if}
		<button
			onclick={toggleWatched}
			class="rounded-md border px-2.5 py-1 transition-colors {watched
				? 'border-primary/50 text-primary'
				: 'border-line text-muted hover:text-base-content'}"
		>
			{watched ? '✓ watched' : 'mark watched'}
		</button>
	</div>
</div>
