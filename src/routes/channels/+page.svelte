<script lang="ts">
	import ChannelCard from '$lib/components/ChannelCard.svelte';
	import IndexingOrEmpty from '$lib/components/IndexingOrEmpty.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// When scoped to a library, the heading is its name and the count noun matches its format.
	const heading = $derived(data.library ? data.library.name : 'Channels');
	const noun = $derived(
		data.library?.format === 'series' ? 'shows' : data.library?.format === 'movies' ? 'movies' : 'channels'
	);

	// Genre chips (shows): union of the channels' genres (series carry tvshow.nfo <genre>s). Filtering
	// is CLIENT-side over the already-delivered list — no refetch (⇔ the movies wall's genre chips).
	let genre = $state<string | null>(null);
	const genres = $derived(
		[...new Set(data.channels.flatMap((c) => c.genres ?? []))].sort((a, b) => a.localeCompare(b))
	);
	const shownChannels = $derived(
		genre ? data.channels.filter((c) => c.genres?.includes(genre!)) : data.channels
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
	{#if data.library}
		<div
			class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted"
		>
			No {noun} in <span class="capitalize text-base-content">{heading}</span> yet.
		</div>
	{:else}
		<!-- Same live indexing/guidance card as Recent: spinner + progress during a scan, and the
		     owner "add your first library" call-to-action when a finished scan found nothing. -->
		<IndexingOrEmpty isOwner={data.isOwner} />
	{/if}
{:else}
	{#if genres.length > 0}
		<div class="mb-4 flex flex-wrap gap-1.5">
			<button
				onclick={() => (genre = null)}
				class="rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors {genre === null
					? 'border-primary/60 text-primary'
					: 'border-line text-muted hover:text-base-content'}">all</button
			>
			{#each genres as g (g)}
				<button
					onclick={() => (genre = genre === g ? null : g)}
					class="rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors {genre === g
						? 'border-primary/60 text-primary'
						: 'border-line text-muted hover:text-base-content'}">{g}</button
				>
			{/each}
		</div>
	{/if}
	<div class="channel-grid">
		{#each shownChannels as c (c.id)}
			<ChannelCard channel={c} />
		{/each}
	</div>
{/if}
