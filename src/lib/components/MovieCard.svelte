<script lang="ts">
	import type { VideoSummary } from '$lib/types';
	import { watchUpdates, noteWatch } from '$lib/watchStore';

	// The poster-wall cell for a movies library (2:3, ⇔ every movie UI's convention) — the poster
	// sibling of VideoCard's 16:9 thumb cell. Title + year below; same watched overlay/progress/toggle
	// affordances as VideoCard so watch state reads identically across grid shapes.
	let { video }: { video: VideoSummary } = $props();

	let imgError = $state(false);

	// Overlay any in-session change from the player over the SSR values (⇔ VideoCard).
	const patch = $derived($watchUpdates[video.id]);
	const watched = $derived(patch?.watched ?? video.watched ?? false);
	const position = $derived(patch?.position ?? video.position ?? 0);
	const progress = $derived(
		position && video.duration ? Math.min(100, (position / video.duration) * 100) : 0
	);

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
	<div class="relative aspect-[2/3] overflow-hidden rounded-lg border border-line-soft bg-base-300">
		{#if video.poster_path && !imgError}
			<img
				loading="lazy"
				src="/poster/{encodeURIComponent(video.id)}"
				alt=""
				onerror={() => (imgError = true)}
				class="h-full w-full object-cover transition-[transform,opacity,filter] duration-300 group-hover:scale-[1.03] group-hover:brightness-[1.06] {watched
					? 'opacity-55 group-hover:opacity-100'
					: ''}"
			/>
		{:else}
			<!-- No poster: the title becomes the tile (⇔ ChannelCard's initial-letter fallback). -->
			<div class="grid h-full place-items-center p-3 text-center font-mono text-xs text-faint">
				{video.title}
			</div>
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
	<div class="pt-2">
		<div class="line-clamp-1 text-[13px] leading-snug font-medium">{video.title}</div>
		{#if video.year}
			<div class="mt-0.5 font-mono text-[11px] text-muted">{video.year}</div>
		{/if}
	</div>
</a>
