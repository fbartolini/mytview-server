<script lang="ts">
	import VideoCard from '$lib/components/VideoCard.svelte';
	import { enhance } from '$app/forms';
	import { fade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { watchUpdates } from '$lib/watchStore';
	import { fmtViews } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const c = $derived(data.channel);
	const base = $derived(`/channel/${encodeURIComponent(c.id)}`);
	const toggleHref = $derived(data.showWatched ? base : `${base}?watched=1`);
	// "Show watched" is incremental: it ADDS watched videos to the unwatched ones (shows everything).
	// The default view shows only unwatched, live-dropping a card the instant it's marked watched.
	const shown = $derived(
		data.showWatched
			? data.videos
			: data.videos.filter((v) => !($watchUpdates[v.id]?.watched ?? v.watched ?? false))
	);
	// "Everything watched" in the default (unwatched-only) view — keyed off `shown` so it's right for
	// both channels (load returns only unwatched) and series (load returns ALL episodes → filtered here).
	const allWatched = $derived(!data.showWatched && c.video_count > 0 && shown.length === 0);
</script>

<svelte:head><title>{c.name} · MytView</title></svelte:head>

<a
	href={data.library ? `/channels?library=${data.library.id}` : '/channels'}
	class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content"
	>← {data.library ? data.library.name : 'channels'}</a
>

<div class="relative mb-6 overflow-hidden rounded-2xl border border-line bg-base-200">
	{#if c.fanart_path}
		<div
			class="h-[180px] bg-cover bg-center"
			style="background-image:url('/fanart/{encodeURIComponent(c.id)}')"
		></div>
	{:else}
		<div class="h-24 bg-gradient-to-br from-base-300 to-base-200"></div>
	{/if}
	<div class="absolute inset-0 bg-gradient-to-t from-base-100/95 to-base-100/20"></div>
	<div class="relative flex items-end gap-4 p-5">
		{#if c.poster_path}
			<img
				src="/poster/{encodeURIComponent(c.id)}"
				alt=""
				class="h-[76px] w-[76px] flex-none rounded-2xl border border-line object-cover"
			/>
		{/if}
		<div>
			<h1 class="mb-1.5 text-[22px] font-bold">{c.name}</h1>
			<div class="flex flex-wrap items-center gap-2 font-mono text-xs text-muted">
				{#if c.follower_count != null}
					<span>{fmtViews(c.follower_count)} subscribers</span>
					<span class="text-faint">·</span>
				{/if}
				<span>{c.video_count} videos</span>
				{#if c.url}
					<span class="text-faint">·</span>
					<a href={c.url} target="_blank" rel="noopener" class="text-primary">source ↗</a>
				{/if}
			</div>
		</div>
	</div>
</div>

<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
	<form method="POST" action="?/toggleHide" use:enhance>
		<button class="font-mono text-xs text-muted hover:text-base-content" title="Hide/show this channel in your own Recent feed">
			{data.hidden ? '+ show in my feed' : '− hide from my feed'}
		</button>
	</form>
	<form method="POST" action="?/setAllWatched" use:enhance>
		<input type="hidden" name="watched" value="1" />
		<button class="font-mono text-xs text-muted hover:text-base-content" title="Mark every video here as watched">
			✓ mark all watched
		</button>
	</form>
	<form method="POST" action="?/setAllWatched" use:enhance>
		<input type="hidden" name="watched" value="0" />
		<button class="font-mono text-xs text-muted hover:text-base-content" title="Mark every video here as unwatched">
			mark all unwatched
		</button>
	</form>
	<a href={toggleHref} class="ml-auto font-mono text-xs text-muted hover:text-base-content">
		{data.showWatched ? '× hide watched' : 'show watched'}
	</a>
</div>

{#if allWatched}
	<div class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted">
		You’ve watched everything from this channel.
		<a href={toggleHref} class="text-primary hover:underline">show watched</a>
	</div>
{:else}
	<div class="card-grid">
		{#each shown as v (v.id)}
			<div out:fade={{ duration: 180 }} animate:flip={{ duration: 180 }}>
					<VideoCard video={v} showChannel={false} />
				</div>
		{/each}
	</div>
{/if}
