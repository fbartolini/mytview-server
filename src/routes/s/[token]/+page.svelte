<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { fmtDuration, fmtViews, fmtDate, relDate } from '$lib/format';
	import type Hls from 'hls.js'; // type-only; lazy-imported when a video actually needs HLS
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let videoEl = $state<HTMLVideoElement>();
	let onHls = $state(false); // playing the live-HLS fallback stream
	let hlsNative = $state(false); // Safari/iOS: native HLS via the src attribute (vs hls.js over MSE)
	let hlsInst: Hls | null = null;
	let hlsRecoveries = 0;
	const MAX_HLS_RECOVERIES = 3;
	let failed = $state(false); // no fallback left → fail-soft card
	let descOpen = $state(false);

	// Live-HLS fallback for a share recipient (no account): the page load ships a short-TTL signed
	// `hlsUrl` (the same capability URL native players use), so a source this browser can't decode —
	// or would play with SILENT audio and no MediaError (.mkv / Dolby-family, see preferHls) — still
	// plays. A slimmed-down twin of Player.svelte's switchToHls.
	async function switchToHls() {
		if (data.state !== 'ok' || !data.hlsUrl || onHls) return;
		if (videoEl?.canPlayType('application/vnd.apple.mpegurl')) {
			hlsNative = true;
			onHls = true;
			await tick(); // let the src flip to the playlist
			videoEl?.load();
			videoEl?.play?.().catch(() => {});
			return;
		}
		try {
			const { default: HlsCtor } = await import('hls.js');
			if (!HlsCtor.isSupported()) return void (failed = true);
			onHls = true;
			await tick(); // drop the <video> src before hls.js attaches
			const inst = new HlsCtor({ fragLoadingTimeOut: 60_000, manifestLoadingTimeOut: 20_000 });
			hlsInst = inst;
			inst.on(HlsCtor.Events.ERROR, (_e, d) => {
				if (!d.fatal) return;
				if (hlsRecoveries >= MAX_HLS_RECOVERIES) {
					inst.destroy();
					hlsInst = null;
					failed = true;
					return;
				}
				hlsRecoveries++;
				// Segment 503 while the live transcode catches up → resume loading; else flush past it.
				if (d.type === HlsCtor.ErrorTypes.NETWORK_ERROR) inst.startLoad();
				else inst.recoverMediaError();
			});
			inst.loadSource(data.hlsUrl);
			if (videoEl) inst.attachMedia(videoEl);
			videoEl?.play?.().catch(() => {});
		} catch {
			failed = true;
		}
	}

	function onError() {
		if (data.state !== 'ok') return;
		if (onHls) {
			if (hlsInst) return; // hls.js owns recovery via its ERROR handler
			failed = true; // native (Safari) HLS has no recovery hook
			return;
		}
		const code = videoEl?.error?.code;
		if (code !== 3 && code !== 4) return; // 3=DECODE, 4=SRC_NOT_SUPPORTED
		if (data.hlsUrl) void switchToHls();
		else failed = true;
	}

	function onPlaying() {
		failed = false;
		hlsRecoveries = 0;
	}

	// Known silent-audio sources go straight to HLS — attempting the original would play video with
	// no sound and nothing to trigger the fallback. Fires once so an HLS failure can't loop it.
	let autoTried = false;
	$effect(() => {
		if (data.state === 'ok' && data.preferHls && !onHls && !autoTried) {
			autoTried = true;
			void switchToHls();
		}
	});

	onDestroy(() => {
		hlsInst?.destroy();
		hlsInst = null;
	});

	const src = $derived(
		data.state === 'ok'
			? onHls
				? hlsNative
					? data.hlsUrl!
					: undefined
				: `/media/${encodeURIComponent(data.video.id)}?s=${encodeURIComponent(data.token)}`
			: ''
	);

	const v = $derived(data.state === 'ok' ? data.video : null);
	const res = $derived(v?.width && v?.height ? `${v.width}×${v.height}` : '');
	// Cap height so tall portrait (Shorts) videos don't overflow the viewport; center them.
	const portrait = $derived(!!v?.width && !!v?.height && v.height > v.width);
	const published = $derived(
		v
			? fmtDate(v.timestamp, v.upload_date) +
					(relDate(v.timestamp, v.upload_date) ? ` (${relDate(v.timestamp, v.upload_date)})` : '')
			: ''
	);
</script>

<svelte:head>
	<title>{data.state === 'ok' ? `${data.video.title} · MytView` : 'MytView'}</title>
	<meta name="robots" content="noindex" />
	{#if data.state === 'ok'}
		<!-- Link-unfurl preview card (WhatsApp/iMessage/Slack/…): show the video thumbnail, not the
		     favicon. SSR'd so crawlers (which don't run JS) see it. -->
		<meta property="og:type" content="video.other" />
		<meta property="og:site_name" content="MytView" />
		<meta property="og:title" content={data.video.title} />
		{#if data.ogDescription}
			<meta property="og:description" content={data.ogDescription} />
			<meta name="twitter:description" content={data.ogDescription} />
		{/if}
		{#if data.ogImage}
			<meta property="og:image" content={data.ogImage} />
			<meta property="og:image:alt" content={data.video.title} />
			<meta name="twitter:card" content="summary_large_image" />
			<meta name="twitter:image" content={data.ogImage} />
		{/if}
		<meta name="twitter:title" content={data.video.title} />
	{/if}
</svelte:head>

<div class="min-h-screen bg-base-100 px-4 pb-6 pt-[calc(1.5rem_+_env(safe-area-inset-top))] text-base-content">
	<div class="mx-auto max-w-5xl">
		<div class="mb-5">
			<img src="/logo.png" alt="MytView" class="h-7 w-auto" />
		</div>

		{#if data.state === 'ok'}
			<div class="grid items-start gap-6 min-[900px]:grid-cols-[minmax(0,1fr)_340px]">
				<div>
					<div class="relative">
						<!-- svelte-ignore a11y_media_has_caption -->
						<video
							bind:this={videoEl}
							controls
							autoplay
							playsinline
							onerror={onError}
							onplaying={onPlaying}
							class={portrait
								? 'mx-auto block max-h-[calc(100vh_-_10rem)] max-w-full rounded-lg border border-line bg-black'
								: 'w-full max-h-[calc(100vh_-_10rem)] rounded-lg border border-line bg-black object-contain'}
							poster={data.video.thumb_path
								? `/thumb/${encodeURIComponent(data.video.id)}?s=${encodeURIComponent(data.token)}`
								: undefined}
							{src}
						></video>

						{#if failed}
							<div
								class="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-black/85 p-6 text-center backdrop-blur-sm"
							>
								<div class="text-sm font-semibold">Can't play on this device</div>
								<p class="max-w-xs font-mono text-[11px] text-faint">
									This video's format isn't supported by this browser, and the compatible stream
									didn't load. Try opening it in Chrome.
								</p>
							</div>
						{/if}
					</div>

					<h1 class="mt-4 text-xl leading-tight font-bold">{data.video.title}</h1>
					<div class="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-[12.5px] text-muted">
						<span class="text-base-content">{data.video.channel_name}</span>
						<span class="text-faint">·</span><span
							>{fmtDate(data.video.timestamp, data.video.upload_date)}</span
						>
						<span class="text-faint">·</span><span>{fmtViews(data.video.view_count)} views</span>
						{#if data.video.like_count != null}
							<span class="text-faint">·</span><span
								>{fmtViews(data.video.like_count)} likes</span
							>
						{/if}
					</div>

					{#if data.video.tags?.length}
						<div class="mt-4 flex flex-wrap gap-1.5">
							{#each data.video.tags.slice(0, 24) as t (t)}
								<span
									class="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-muted"
									>{t}</span
								>
							{/each}
						</div>
					{/if}

					{#if data.video.description}
						<div class="mt-5 max-w-[78ch]">
							<div
								class="leading-relaxed whitespace-pre-wrap text-[14px] text-neutral-300 {descOpen
									? ''
									: 'line-clamp-6'}"
							>
								{data.video.description}
							</div>
							{#if data.video.description.length > 280}
								<button
									onclick={() => (descOpen = !descOpen)}
									class="mt-1.5 font-mono text-xs text-primary hover:underline"
								>
									{descOpen ? 'Show less' : 'Show more'}
								</button>
							{/if}
						</div>
					{/if}
				</div>

				<aside class="overflow-hidden rounded-xl border border-line bg-base-200">
					<h2
						class="border-b border-line px-3.5 py-3 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase"
					>
						Metadata
					</h2>
					{#snippet spec(k: string, val: string)}
						{#if val}
							<div
								class="grid grid-cols-[96px_1fr] gap-2.5 border-b border-line-soft px-3.5 py-2 font-mono text-xs last:border-b-0"
							>
								<span class="text-faint">{k}</span>
								<span class="break-words">{val}</span>
							</div>
						{/if}
					{/snippet}
					{@render spec('Channel', data.video.channel_name)}
					{@render spec('Published', published)}
					{@render spec('Duration', fmtDuration(data.video.duration))}
					{@render spec('Views', data.video.view_count != null ? data.video.view_count.toLocaleString() : '')}
					{@render spec('Likes', data.video.like_count != null ? data.video.like_count.toLocaleString() : '')}
					{@render spec('Resolution', res)}
					{@render spec('FPS', data.video.fps ? String(Math.round(data.video.fps)) : '')}
					{@render spec('Video', data.video.vcodec ?? '')}
					{@render spec('Audio', data.video.acodec ?? '')}
					{#if data.video.webpage_url}
						<div
							class="grid grid-cols-[96px_1fr] gap-2.5 border-b border-line-soft px-3.5 py-2 font-mono text-xs last:border-b-0"
						>
							<span class="text-faint">Source</span>
							<a href={data.video.webpage_url} target="_blank" rel="noopener" class="text-primary"
								>open ↗</a
							>
						</div>
					{/if}
				</aside>
			</div>

			<div class="mt-6 font-mono text-[11px] text-faint">Shared via MytView</div>
		{:else}
			<div
				class="mt-16 rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted"
			>
				{#if data.state === 'limit'}
					This link has reached its view limit.
				{:else}
					This link has expired or is no longer available.
				{/if}
			</div>
		{/if}
	</div>
</div>
