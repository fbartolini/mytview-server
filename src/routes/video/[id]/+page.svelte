<script lang="ts">
	import { goto } from '$app/navigation';
	import Player from '$lib/components/Player.svelte';
	import RelatedVideos from '$lib/components/RelatedVideos.svelte';
	import ShareDialog from '$lib/components/ShareDialog.svelte';
	import { fmtDuration, fmtViews, fmtDate, relDate } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const v = $derived(data.video);
	const res = $derived(v.width && v.height ? `${v.width}×${v.height}` : '');
	const published = $derived(
		fmtDate(v.timestamp, v.upload_date) +
			(relDate(v.timestamp, v.upload_date) ? ` (${relDate(v.timestamp, v.upload_date)})` : '')
	);

	let copied = $state(false);
	let descOpen = $state(false);
	function flashCopied() {
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	// execCommand('copy') is deprecated, but it's the only clipboard path that
	// works in an *insecure* context — which is how this app is usually reached
	// (plain HTTP over the LAN by IP). Chromium hides both navigator.share and
	// navigator.clipboard on http://<ip>, so without this fallback the button
	// silently did nothing in Brave/Chrome. Safari is laxer, hence its share sheet.
	function legacyCopy(text: string): boolean {
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.setAttribute('readonly', '');
			ta.style.position = 'fixed';
			ta.style.top = '-1000px';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand('copy');
			document.body.removeChild(ta);
			return ok;
		} catch {
			return false;
		}
	}

	async function shareSource() {
		const url = v.webpage_url;
		if (!url) return;
		// 1) Native share sheet where offered (mobile, Safari).
		if (typeof navigator !== 'undefined' && navigator.share) {
			try {
				await navigator.share({ url, title: v.title });
				return;
			} catch {
				/* user dismissed → fall through to copy */
			}
		}
		// 2) Async Clipboard API — present only in secure contexts (HTTPS/localhost).
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
				flashCopied();
				return;
			}
		} catch {
			/* fall through to the legacy path */
		}
		// 3) Legacy execCommand — works over plain-HTTP LAN.
		if (legacyCopy(url)) flashCopied();
		// 4) Last resort: at least surface the URL to copy by hand.
		else window.prompt('Copy this link:', url);
	}

	function back() {
		if (history.length > 1) history.back();
		else goto('/');
	}
</script>

<svelte:head><title>{v.title} · MytView</title></svelte:head>

<button
	onclick={back}
	class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</button
>

<div class="grid items-start gap-6 min-[900px]:grid-cols-[minmax(0,1fr)_340px]">
	<div>
		{#key v.id}
			<Player
				id={v.id}
				title={v.title}
				channel={v.channel_name}
				thumbPath={v.thumb_path}
				watch={data.watch}
				watchedAt={data.watchedAt}
				resumePosition={data.resumePosition}
				autoplayNext={data.prefs.autoplayNext}
				stillWatchingAfter={data.prefs.stillWatchingAfter}
				preferCompat={data.preferCompat}
				hlsEnabled={data.hlsEnabled}
				width={v.width}
				height={v.height}
			/>
		{/key}

		<h1 class="mt-4 text-xl leading-tight font-bold">{v.title}</h1>
		<div class="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-[12.5px] text-muted">
			<a
				href="/channel/{encodeURIComponent(v.channel_id)}"
				class="text-base-content hover:text-primary">{v.channel_name}</a
			>
			<span class="text-faint">·</span><span>{fmtDate(v.timestamp, v.upload_date)}</span>
			<span class="text-faint">·</span><span>{fmtViews(v.view_count)} views</span>
			{#if v.like_count != null}
				<span class="text-faint">·</span><span>{fmtViews(v.like_count)} likes</span>
			{/if}
		</div>

		{#if v.tags?.length}
			<div class="mt-4 flex flex-wrap gap-1.5">
				{#each v.tags.slice(0, 24) as t}
					<a
						href="/tag/{encodeURIComponent(t)}"
						class="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-muted transition-colors hover:border-primary/60 hover:text-base-content"
						>{t}</a
					>
				{/each}
			</div>
		{/if}

		<div class="mt-4 flex flex-wrap items-center gap-2">
			<ShareDialog videoId={v.id} />
			{#if v.webpage_url}
				<button
					onclick={shareSource}
					title="Copy / share the original source URL"
					class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-mono text-xs text-muted transition-colors hover:border-primary/60 hover:text-base-content"
				>
					{#if copied}
						<span class="text-primary">copied</span>
					{:else}
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
							<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
						</svg>
						Share source
					{/if}
				</button>
			{/if}
		</div>

		<!-- Related: on mobile it sits right under the video (before the description); on
		     desktop it lives in the sidebar instead, so this copy is hidden there. -->
		{#if data.related.length}
			<div class="mt-5 min-[900px]:hidden">
				<RelatedVideos items={data.related} variant="grid" />
			</div>
		{/if}

		{#if v.description}
			<div class="mt-5 max-w-[78ch]">
				<div
					class="leading-relaxed whitespace-pre-wrap text-[14px] text-neutral-300 {descOpen
						? ''
						: 'line-clamp-6'}"
				>
					{v.description}
				</div>
				{#if v.description.length > 280}
					<button
						onclick={() => (descOpen = !descOpen)}
						class="mt-1.5 font-mono text-xs text-primary hover:underline"
					>
						{descOpen ? 'Show less' : 'Show more'}
					</button>
				{/if}
			</div>
		{/if}
	</div>

	<div class="flex flex-col gap-4">
		<!-- Related first — it's more useful than raw file metadata. On mobile the grid copy above the
		     description is shown instead, so this desktop list is hidden there. -->
		<div class="hidden min-[900px]:block">
			<RelatedVideos items={data.related} variant="list" />
		</div>
		<aside class="overflow-hidden rounded-xl border border-line bg-base-200">
			<h2
				class="border-b border-line px-3.5 py-3 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase"
			>
				Metadata
			</h2>
			{#snippet spec(k: string, val: string)}
				{#if val}
					<div
						class="grid grid-cols-[96px_1fr] gap-2.5 border-b border-line-soft px-3.5 py-2 font-mono text-xs last:border-b-0"
					>
						<span class="text-faint">{k}</span>
						<span class="break-words">{val}</span>
					</div>
				{/if}
			{/snippet}
			{@render spec('Channel', v.channel_name)}
			{@render spec('Published', published)}
			{@render spec('Duration', fmtDuration(v.duration))}
			{@render spec('Views', v.view_count != null ? v.view_count.toLocaleString() : '')}
			{@render spec('Likes', v.like_count != null ? v.like_count.toLocaleString() : '')}
			{@render spec('Resolution', res)}
			{@render spec('FPS', v.fps ? String(Math.round(v.fps)) : '')}
			{@render spec('Video', v.vcodec ?? '')}
			{@render spec('Audio', v.acodec ?? '')}
			{@render spec('Video id', v.id)}
			{#if v.webpage_url}
				<div
					class="grid grid-cols-[96px_1fr] gap-2.5 border-b border-line-soft px-3.5 py-2 font-mono text-xs last:border-b-0"
				>
					<span class="text-faint">Source</span>
					<a href={v.webpage_url} target="_blank" rel="noopener" class="text-primary break-words"
						>open ↗</a
					>
				</div>
			{/if}
		</aside>
	</div>
</div>
