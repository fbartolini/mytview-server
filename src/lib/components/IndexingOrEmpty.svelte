<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	let { q = '', isOwner = false }: { q?: string; isOwner?: boolean } = $props();

	type Status = {
		scanning: boolean;
		everScanned: boolean;
		error: string | null;
		videos: number;
		/** Live scan progress (server-owned; null unless a scan is running). */
		progress: { library: string | null; videos: number } | null;
		/** Owner has defined libraries — drives "add a library" vs "check your libraries" guidance. */
		librariesConfigured?: boolean;
	};
	let status = $state<Status | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	async function poll() {
		try {
			const r = await fetch('/api/status');
			if (!r.ok) return;
			const s: Status = await r.json();
			status = s;
			if (s.videos > 0) {
				clearInterval(timer); // the scan populated the library
				await invalidateAll();
			}
		} catch {
			/* ignore; try again next tick */
		}
	}

	onMount(() => {
		if (q) return; // a search that matched nothing — not an indexing state
		poll();
		timer = setInterval(poll, 2000);
		return () => clearInterval(timer);
	});
</script>

<div
	class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted"
>
	{#if q}
		No titles match “{q}”.
	{:else if status?.error}
		Scan error: {status.error}<br />Check <code class="text-primary">MEDIA_ROOT</code>.
	{:else if status && status.everScanned && status.videos === 0}
		{#if isOwner && !status.librariesConfigured}
			<!-- Fresh install, implicit scan of /media found nothing — the media is almost certainly
			     movies/shows (no .info.json), so the fix is a library with the right FORMAT, not the mount. -->
			Nothing indexed yet — point MytView at your media.
			<div class="mt-4">
				<a
					href="/admin/libraries"
					class="inline-block rounded bg-primary/90 px-4 py-1.5 font-sans text-sm font-medium text-base-100 transition-colors hover:bg-primary"
					>Add your first library</a
				>
			</div>
			<div class="mt-3 text-xs text-faint">
				pick a folder and its format — channels, series or movies;<br />
				if the folder browser shows nothing, check the media mount
			</div>
		{:else if isOwner}
			Nothing indexed. Check your
			<a href="/admin/libraries" class="text-primary hover:underline">libraries</a>’ folders and
			formats, then hit Rescan.
		{:else}
			Nothing here yet — ask the server owner for access.
		{/if}
	{:else}
		<span class="inline-block animate-spin">⟳</span>
		{#if status?.progress?.library}
			Indexing <span class="text-base-content">{status.progress.library}</span>
			— {status.progress.videos} videos so far…
		{:else if status?.progress}
			Finishing up…
		{:else}
			Indexing your library…
		{/if}
		<div class="mt-2 text-xs text-faint">this can take a moment on first run</div>
	{/if}
</div>
