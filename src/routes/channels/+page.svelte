<script lang="ts">
	import ChannelCard from '$lib/components/ChannelCard.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// When scoped to a library, the heading is its name and the count noun matches its format.
	const heading = $derived(data.library ? data.library.name : 'Channels');
	const noun = $derived(
		data.library?.format === 'series' ? 'shows' : data.library?.format === 'movies' ? 'movies' : 'channels'
	);

	// Re-sort in place, preserving ?library. 'name' is the default → drop the param to keep URLs clean.
	function setSort(e: Event) {
		const value = (e.currentTarget as HTMLSelectElement).value;
		const url = new URL(page.url);
		if (value === 'name') url.searchParams.delete('sort');
		else url.searchParams.set('sort', value);
		goto(url, { keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>{heading} · MytView</title></svelte:head>

<div class="mb-5 flex items-baseline gap-3">
	<h1 class="text-xl font-bold capitalize tracking-tight">{heading}</h1>
	<span class="font-mono text-xs text-faint">{data.channels.length} {data.library ? noun : 'total'}</span>
	<select
		aria-label="Sort"
		value={data.sort}
		onchange={setSort}
		class="ml-auto rounded-md border border-line bg-base-200 px-2 py-1 text-xs text-muted focus:border-primary/70 focus:outline-none"
	>
		<option value="name">Name</option>
		<option value="updated">Recently updated</option>
		<option value="unwatched">Most unwatched</option>
	</select>
</div>

{#if data.channels.length === 0}
	<div
		class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted"
	>
		{#if data.library}
			No {noun} in <span class="capitalize text-base-content">{heading}</span> yet.
		{:else}
			No channels indexed. Check <code class="text-primary">MEDIA_ROOT</code> and hit Rescan.
		{/if}
	</div>
{:else}
	<div class="channel-grid">
		{#each data.channels as c (c.id)}
			<ChannelCard channel={c} />
		{/each}
	</div>
{/if}
