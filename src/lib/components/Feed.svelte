<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { fade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import type { VideoSummary } from '$lib/types';
	import { watchUpdates } from '$lib/watchStore';
	import VideoCard from './VideoCard.svelte';

	// The parent renders this only when there's at least one item and remounts it via
	// {#key}, so snapshotting the first page on mount is intentional (untrack).
	let {
		initialItems,
		q = '',
		tag = '',
		watched = false
	}: { initialItems: VideoSummary[]; q?: string; tag?: string; watched?: boolean } = $props();

	const PAGE = 60;
	let items = $state<VideoSummary[]>(untrack(() => initialItems));
	let offset = $state(untrack(() => initialItems.length));
	let done = $state(untrack(() => initialItems.length < PAGE));
	let busy = $state(false);
	let failed = $state(false);
	let sentinel!: HTMLElement;

	// "Show watched" is incremental: it ADDS watched videos to the unwatched ones (shows everything),
	// rather than swapping to a watched-only view. The default feed shows only unwatched, live-dropping
	// a card the instant it's marked watched.
	const shown = $derived(
		watched ? items : items.filter((v) => !($watchUpdates[v.id]?.watched ?? v.watched ?? false))
	);

	async function loadMore() {
		if (busy || done) return;
		busy = true;
		failed = false;
		try {
			const qs = `${q ? `&q=${encodeURIComponent(q)}` : ''}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${watched ? '&watched=1' : ''}`;
			const r = await fetch(`/api/videos?limit=${PAGE}&offset=${offset}${qs}`);
			if (!r.ok) throw new Error(String(r.status));
			const rows: VideoSummary[] = await r.json();
			if (rows.length < PAGE) done = true;
			offset += rows.length;
			items = [...items, ...rows];
		} catch {
			failed = true;
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		const io = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting) loadMore();
			},
			{ rootMargin: '600px' }
		);
		io.observe(sentinel);
		return () => io.disconnect();
	});
</script>

<div class="card-grid">
	{#each shown as v (v.id)}
		<div out:fade={{ duration: 180 }} animate:flip={{ duration: 180 }}>
			<VideoCard video={v} />
		</div>
	{/each}
</div>

<div bind:this={sentinel} class="h-px"></div>

{#if busy}
	<div class="py-2 font-mono text-xs text-faint">loading…</div>
{:else if failed}
	<div class="py-2 font-mono text-xs text-error">failed to load — scroll to retry</div>
{/if}
