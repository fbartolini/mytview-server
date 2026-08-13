<script lang="ts">
	import VideoCard from '$lib/components/VideoCard.svelte';
	import MovieCard from '$lib/components/MovieCard.svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { watchUpdates } from '$lib/watchStore';
	import { fmtViews } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const c = $derived(data.channel);
	const isMovies = $derived(c.kind === 'movies');
	// Show/hide watched, preserving the other params (?sort on the movies wall) — same toggle as the
	// /channels grid.
	const toggleHref = $derived.by(() => {
		const url = new URL(page.url);
		if (data.showWatched) url.searchParams.delete('watched');
		else url.searchParams.set('watched', '1');
		return url.pathname + url.search;
	});
	// Movies wall genre filter — CLIENT-side over the delivered list (each movie carries its
	// `genres`); the chip options come from the channel's aggregate. No refetch, no query param.
	let genre = $state<string | null>(null);
	// "Show watched" is incremental: it ADDS watched videos to the unwatched ones (shows everything).
	// The default view shows only unwatched, live-dropping a card the instant it's marked watched.
	// Movies included since 2026-08-12 (the wall-is-the-collection exemption was reversed — the server
	// already delivers only unwatched movies by default; the filter here is just the live drop).
	const unwatchedLive = $derived(
		data.showWatched
			? data.videos
			: data.videos.filter((v) => !($watchUpdates[v.id]?.watched ?? v.watched ?? false))
	);
	const shown = $derived(
		isMovies && genre ? unwatchedLive.filter((v) => v.genres?.includes(genre!)) : unwatchedLive
	);
	// "Everything watched" in the default (unwatched-only) view — keyed off `shown` so it's right for
	// channels (load returns only unwatched), series (load returns ALL episodes → filtered here), and
	// the movies wall (load returns only unwatched; suppressed while a genre chip narrows the list).
	const allWatched = $derived(
		!data.showWatched && !(isMovies && genre) && c.video_count > 0 && shown.length === 0
	);
	// Movies wall: how many the default view is hiding (video_count is the full collection size).
	const hiddenWatched = $derived(
		isMovies && !data.showWatched ? c.video_count - data.videos.length : 0
	);

	// Movies sort — a <select> mirroring the /channels listing pages (⇔ their setSort), so the movies
	// wall reads as a sibling LIBRARY page, not a channel detail. 'title' is the default → drop the param.
	function setMovieSort(e: Event) {
		const value = (e.currentTarget as HTMLSelectElement).value;
		const url = new URL(page.url);
		if (value === 'title') url.searchParams.delete('sort');
		else url.searchParams.set('sort', value);
		goto(url, { keepFocus: true, noScroll: true });
	}
</script>

<svelte:head><title>{c.name} · MytView</title></svelte:head>

{#if isMovies}
	<!-- The movies wall IS a top-level library page (the nav tab lands here directly), so it presents
	     like the /channels listing pages — heading + count + a sort select — not like a channel detail:
	     no back-link (nowhere sensible to go "back" to) and no hero (a synthetic library channel has no
	     art, which rendered as a large blank slab). -->
	<div class="mb-5 flex items-baseline gap-3">
		<h1 class="text-xl font-bold capitalize tracking-tight">{c.name}</h1>
		<span class="font-mono text-xs text-faint"
			>{data.videos.length} movies{hiddenWatched > 0
				? ` · ${hiddenWatched} watched hidden`
				: ''}</span
		>
		<select
			aria-label="Sort"
			value={data.sort}
			onchange={setMovieSort}
			class="ml-auto rounded-md border border-line bg-base-200 px-2 py-1 text-xs text-muted focus:border-primary/70 focus:outline-none"
		>
			<option value="title">Title</option>
			<option value="year">Year</option>
			<option value="added">Recently added</option>
		</select>
		<a href={toggleHref} class="font-mono text-xs text-muted hover:text-base-content">
			{data.showWatched ? '× hide watched' : 'show watched'}
		</a>
	</div>
{:else}
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
				<span>{c.video_count} {isMovies ? 'movies' : 'videos'}</span>
				{#if c.url}
					<span class="text-faint">·</span>
					<a href={c.url} target="_blank" rel="noopener" class="text-primary">source ↗</a>
				{/if}
			</div>
		</div>
	</div>
</div>
{/if}

{#if !isMovies}
<!-- No action row on the movies wall: per-user feed-hide is served by the library-level "show in
     Recent" setting (and one mis-click of "mark all watched" over ~2,000 movies is unrecoverable
     enough to not offer). Channels/series keep the row. -->
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
{/if}

{#if isMovies && (c.genres?.length ?? 0) > 0}
	<div class="mb-4 flex flex-wrap gap-1.5">
		<button
			onclick={() => (genre = null)}
			class="rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors {genre === null
				? 'border-primary/60 text-primary'
				: 'border-line text-muted hover:text-base-content'}">all</button
		>
		{#each c.genres ?? [] as g (g)}
			<button
				onclick={() => (genre = genre === g ? null : g)}
				class="rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors {genre === g
					? 'border-primary/60 text-primary'
					: 'border-line text-muted hover:text-base-content'}">{g}</button
			>
		{/each}
	</div>
{/if}

{#if allWatched}
	<div class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted">
		You’ve watched {isMovies ? 'every movie here' : 'everything from this channel'}.
		<a href={toggleHref} class="text-primary hover:underline">show watched</a>
	</div>
{:else if isMovies}
	<div class="movie-grid">
		{#each shown as v (v.id)}
			<MovieCard video={v} />
		{/each}
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
