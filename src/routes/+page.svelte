<script lang="ts">
	import Feed from '$lib/components/Feed.svelte';
	import IndexingOrEmpty from '$lib/components/IndexingOrEmpty.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const toggleHref = $derived(
		data.showWatched
			? data.q
				? `/?q=${encodeURIComponent(data.q)}`
				: '/'
			: data.q
				? `/?q=${encodeURIComponent(data.q)}&watched=1`
				: '/?watched=1'
	);
</script>

<svelte:head><title>{data.q ? `“${data.q}” · MytView` : 'MytView'}</title></svelte:head>

<div class="mb-5 flex items-baseline gap-3">
	<h1 class="text-xl font-bold tracking-tight">{data.q ? 'Search' : 'Recent'}</h1>
	{#if data.q}<span class="font-mono text-xs text-faint">“{data.q}”</span>{/if}
	<!-- Pill toggle (was a bare text link that read as stray copy) — same button language as the
	     rest of the chrome; amber border+text = active. -->
	<a
		href={toggleHref}
		class="ml-auto rounded-full border px-3 py-1 font-mono text-xs transition-colors {data.showWatched
			? 'border-primary/50 text-primary hover:border-primary'
			: 'border-line text-muted hover:border-primary/50 hover:text-base-content'}"
	>
		{data.showWatched ? '× hide watched' : 'show watched'}
	</a>
</div>

{#if data.initial.length === 0}
	{#if data.hiddenByWatched}
		<div class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted">
			You’re all caught up — everything here is watched.
			<a href={toggleHref} class="text-primary hover:underline">show watched</a>
		</div>
	{:else}
		<IndexingOrEmpty q={data.q} isOwner={data.isOwner} />
	{/if}
{:else}
	{#key `${data.q}:${data.showWatched}`}
		<Feed initialItems={data.initial} q={data.q} watched={data.showWatched} />
	{/key}
{/if}
