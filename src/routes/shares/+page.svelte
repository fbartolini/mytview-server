<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let copied = $state<string | null>(null);

	function linkFor(token: string): string {
		const origin = typeof location !== 'undefined' ? location.origin : '';
		return `${origin}/s/${token}`;
	}
	async function copy(token: string) {
		const url = linkFor(token);
		try {
			if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
			else throw new Error('no clipboard');
		} catch {
			// insecure-context fallback (plain-HTTP LAN)
			const ta = document.createElement('textarea');
			ta.value = url;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
		}
		copied = token;
		setTimeout(() => (copied = copied === token ? null : copied), 1500);
	}
</script>

<svelte:head><title>Public links · MytView</title></svelte:head>

<div class="mb-5 flex items-baseline gap-3">
	<h1 class="text-xl font-bold tracking-tight">Public links</h1>
	<span class="font-mono text-xs text-faint">{data.shares.length} active</span>
</div>

{#if data.shares.length === 0}
	<div
		class="rounded-xl border border-dashed border-line p-10 text-center font-mono text-sm text-muted"
	>
		No share links yet. Open a video and use <span class="text-primary">Share</span> to create one.
	</div>
{:else}
	<div class="flex flex-col gap-2.5">
		{#each data.shares as s (s.token)}
			<div class="flex items-center gap-3 rounded-xl border border-line bg-base-200 p-3">
				<div class="min-w-0 flex-1">
					<a
						href="/video/{encodeURIComponent(s.video_id)}"
						class="line-clamp-1 text-sm font-medium hover:text-primary">{s.video_title}</a
					>
					<div class="mt-1 font-mono text-[11px] text-muted">
						{s.usesLabel} · {s.expiresLabel}
					</div>
				</div>
				<button
					onclick={() => copy(s.token)}
					class="shrink-0 rounded-lg border border-line px-2.5 py-1.5 font-mono text-[11px] text-muted transition-colors hover:border-primary/60 hover:text-base-content"
				>
					{copied === s.token ? 'copied' : 'copy link'}
				</button>
				<form method="POST" action="?/revoke" class="shrink-0">
					<input type="hidden" name="token" value={s.token} />
					<button
						class="rounded-lg border border-line px-2.5 py-1.5 font-mono text-[11px] text-muted transition-colors hover:border-error/60 hover:text-error"
						>revoke</button
					>
				</form>
			</div>
		{/each}
	</div>
{/if}
