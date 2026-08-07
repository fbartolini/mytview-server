<script lang="ts">
	import type { ChannelSummary } from '$lib/types';

	let { channel }: { channel: ChannelSummary } = $props();
	const initial = $derived((channel.name || '?').trim().charAt(0).toUpperCase());
</script>

<a
	href="/channel/{encodeURIComponent(channel.id)}"
	class="group block rounded-2xl text-left outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary/70"
>
	<div
		class="relative {channel.kind === 'series'
			? 'aspect-[2/3]'
			: 'aspect-square'} overflow-hidden rounded-2xl border border-line-soft bg-base-300"
	>
		{#if channel.poster_path}
			<img
				loading="lazy"
				src="/poster/{encodeURIComponent(channel.id)}"
				alt=""
				class="h-full w-full object-cover transition-[transform,filter] duration-300 group-hover:scale-[1.02] group-hover:brightness-[1.06]"
			/>
			<!-- Inset vignette ring: source avatars with WHITE backgrounds glare against the ink theme;
			     this tames them without touching the art (invisible on dark posters). -->
			<div class="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-black/15 ring-inset"></div>
		{:else}
			<div class="grid h-full place-items-center text-4xl font-bold text-faint">{initial}</div>
		{/if}
		{#if channel.unwatched > 0}
			<!-- Unread-style badge: count of items this user hasn't watched. -->
			<span
				class="absolute top-1.5 right-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1.5 font-mono text-[11px] leading-none font-bold text-white shadow ring-2 ring-black/25"
				title="{channel.unwatched} unwatched"
			>
				{channel.unwatched > 999 ? '999+' : channel.unwatched}
			</span>
		{/if}
	</div>
	<div class="mt-2.5 line-clamp-2 text-sm leading-tight font-semibold">{channel.name}</div>
	<div class="mt-1 font-mono text-[11.5px] text-muted">
		{channel.video_count}
		{channel.video_count === 1 ? 'video' : 'videos'}
	</div>
</a>
