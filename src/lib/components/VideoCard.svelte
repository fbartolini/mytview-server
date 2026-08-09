<script lang="ts">
	import type { VideoSummary } from '$lib/types';
	import { fmtDuration, fmtViews, fmtDate, fmtEpisode } from '$lib/format';
	import { watchUpdates, noteWatch } from '$lib/watchStore';

	let { video, showChannel = true }: { video: VideoSummary; showChannel?: boolean } = $props();

	// Fall back to the placeholder if the thumb file 404s (e.g. a just-pulled video whose image
	// hasn't landed yet, or one being re-processed) instead of the browser's broken-image icon.
	let imgError = $state(false);

	// Overlay any in-session change from the player over the SSR values.
	const patch = $derived($watchUpdates[video.id]);
	const watched = $derived(patch?.watched ?? video.watched ?? false);
	const position = $derived(patch?.position ?? video.position ?? 0);
	const progress = $derived(
		position && video.duration ? Math.min(100, (position / video.duration) * 100) : 0
	);

	// Series episodes carry no view count (the .nfo has none) — that stat slot renders "— views".
	// When we have a season/episode, show the episode label there instead; else keep views.
	const epLabel = $derived(fmtEpisode(video.season_number, video.episode_number));

	// Mark watched/unwatched straight from the card — no need to open the video. Optimistic via the
	// shared store, persisted to the same endpoint the detail page uses.
	function toggleWatched(e: MouseEvent) {
		e.preventDefault(); // this button lives inside the card's <a> — don't navigate
		e.stopPropagation();
		const next = !watched;
		const update = { watched: next, position: next ? 0 : position };
		noteWatch(video.id, update);
		fetch(`/api/watch/${encodeURIComponent(video.id)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(update),
			keepalive: true
		}).catch(() => {});
	}
</script>

<a
	href="/video/{encodeURIComponent(video.id)}"
	class="group block rounded-lg outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary/70"
>
	<div class="relative aspect-video overflow-hidden rounded-lg border border-line-soft bg-base-300">
		{#if video.thumb_path && !imgError}
			<!-- Watched thumbs dim so unwatched pops when "show watched" is on (full again on hover). -->
			<img
				loading="lazy"
				src="/thumb/{encodeURIComponent(video.id)}?w=480"
				alt=""
				onerror={() => (imgError = true)}
				class="h-full w-full object-cover transition-[transform,opacity,filter] duration-300 group-hover:scale-[1.03] group-hover:brightness-[1.06] {watched
					? 'opacity-55 group-hover:opacity-100'
					: ''}"
			/>
		{:else}
			<div class="grid h-full place-items-center font-mono text-xs text-faint">no thumbnail</div>
		{/if}
		{#if video.duration}
			<span
				class="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] leading-none text-neutral-100"
			>
				{fmtDuration(video.duration)}
			</span>
		{/if}
		{#if watched}
			<span
				class="absolute top-1.5 left-1.5 rounded bg-primary/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary-content"
				>watched</span
			>
		{:else if progress > 1}
			<div class="absolute inset-x-0 bottom-0 h-[3px] bg-black/50">
				<div class="h-full bg-primary" style="width:{progress}%"></div>
			</div>
		{/if}
		<button
			type="button"
			onclick={toggleWatched}
			aria-label={watched ? 'Mark as unwatched' : 'Mark as watched'}
			title={watched ? 'Mark as unwatched' : 'Mark as watched'}
			class="absolute top-1 right-1 p-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)] transition-transform hover:scale-110 {watched
				? 'text-primary'
				: 'text-white/85 hover:text-primary'}"
		>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M20 6 9 17l-5-5" />
			</svg>
		</button>
	</div>
	<div class="pt-2.5">
		<div class="line-clamp-2 text-[13.5px] leading-snug font-medium">{video.title}</div>
		<div class="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] text-muted">
			{#if showChannel && video.channel_name}
				<span class="text-base-content">{video.channel_name}</span>
				<span class="text-faint">·</span>
			{/if}
			<span>{fmtDate(video.timestamp, video.upload_date)}</span>
			<span class="text-faint">·</span>
			{#if epLabel}
				<span class="text-base-content">{epLabel}</span>
			{:else if video.year}
				<!-- Movies: the release year is the meaningful stat (they carry no view count). -->
				<span class="text-base-content">{video.year}</span>
			{:else}
				<span>{fmtViews(video.view_count)} views</span>
			{/if}
		</div>
	</div>
</a>
