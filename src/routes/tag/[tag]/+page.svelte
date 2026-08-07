<script lang="ts">
	import Feed from '$lib/components/Feed.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const base = $derived(`/tag/${encodeURIComponent(data.tag)}`);
	const toggleHref = $derived(data.showWatched ? base : `${base}?watched=1`);
</script>

<svelte:head><title>#{data.tag} · MytView</title></svelte:head>

<a href="/" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</a>

<div class="mb-5 flex items-baseline gap-3">
	<h1 class="text-xl font-bold tracking-tight">Tagged <span class="text-primary">{data.tag}</span></h1>
	<a href={toggleHref} class="ml-auto font-mono text-xs text-muted hover:text-base-content">
		{data.showWatched ? '× hide watched' : 'show watched'}
	</a>
</div>

{#if data.initial.length === 0}
	{#if data.hiddenByWatched}
		<div class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted">
			You’ve watched everything tagged “{data.tag}”.
			<a href={toggleHref} class="text-primary hover:underline">show watched</a>
		</div>
	{:else}
		<div class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted">
			No videos tagged “{data.tag}”.
		</div>
	{/if}
{:else}
	{#key `${data.tag}:${data.showWatched}`}
		<Feed initialItems={data.initial} tag={data.tag} watched={data.showWatched} />
	{/key}
{/if}
