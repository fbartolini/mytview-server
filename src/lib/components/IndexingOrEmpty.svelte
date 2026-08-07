<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	let { q = '' }: { q?: string } = $props();

	type Status = { scanning: boolean; everScanned: boolean; error: string | null; videos: number };
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
		Nothing indexed. Check <code class="text-primary">MEDIA_ROOT</code> and hit Rescan.
	{:else}
		<span class="inline-block animate-spin">⟳</span> Indexing your library…
		<div class="mt-2 text-xs text-faint">this can take a moment on first run</div>
	{/if}
</div>
