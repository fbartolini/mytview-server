<script lang="ts">
	let { videoId }: { videoId: string } = $props();

	let open = $state(false);
	let ttl = $state<'1h' | '24h' | '7d' | '30d' | 'never'>('7d');
	let cap = $state<0 | 1 | 5>(0); // 0 = unlimited
	let link = $state<string | null>(null);
	let creating = $state(false);
	let copied = $state(false);
	let err = $state(false);

	const TTLS: { v: typeof ttl; label: string }[] = [
		{ v: '1h', label: '1 hour' },
		{ v: '24h', label: '24 hours' },
		{ v: '7d', label: '7 days' },
		{ v: '30d', label: '30 days' },
		{ v: 'never', label: 'never' }
	];
	const CAPS: { v: typeof cap; label: string }[] = [
		{ v: 1, label: '1 view' },
		{ v: 5, label: '5 views' },
		{ v: 0, label: 'unlimited' }
	];

	async function create() {
		creating = true;
		err = false;
		link = null;
		try {
			const r = await fetch('/api/share', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ videoId, ttl, maxUses: cap === 0 ? null : cap })
			});
			if (!r.ok) throw new Error();
			link = (await r.json()).url;
		} catch {
			err = true;
		}
		creating = false;
	}

	async function copyLink() {
		if (!link) return;
		try {
			if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
			else throw new Error();
		} catch {
			const ta = document.createElement('textarea');
			ta.value = link;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
		}
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="relative inline-block">
	<button
		onclick={() => (open = !open)}
		class="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 font-mono text-xs text-muted transition-colors hover:border-primary/60 hover:text-base-content"
	>
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
			<line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
		</svg>
		Share
	</button>

	{#if open}
		<div
			class="absolute left-0 z-30 mt-2 w-72 rounded-xl border border-line bg-base-200 p-3.5 shadow-2xl"
		>
			{#if link}
				<div class="font-mono text-[11px] tracking-widest text-faint uppercase">Share link</div>
				<div
					class="mt-2 rounded-lg border border-line bg-base-300 px-2.5 py-2 font-mono text-[11px] break-all"
				>
					{link}
				</div>
				<div class="mt-2.5 flex items-center gap-2">
					<button
						onclick={copyLink}
						class="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-content hover:opacity-90"
						>{copied ? 'Copied' : 'Copy link'}</button
					>
					<button
						onclick={() => (link = null)}
						class="font-mono text-[11px] text-muted hover:text-base-content">new link</button
					>
				</div>
			{:else}
				<div class="font-mono text-[11px] tracking-widest text-faint uppercase">Expires</div>
				<div class="mt-1.5 flex flex-wrap gap-1.5">
					{#each TTLS as o (o.v)}
						<button
							onclick={() => (ttl = o.v)}
							class="rounded-md border px-2 py-1 font-mono text-[11px] transition-colors {ttl === o.v
								? 'border-primary/60 text-primary'
								: 'border-line text-muted hover:text-base-content'}">{o.label}</button
						>
					{/each}
				</div>

				<div class="mt-3 font-mono text-[11px] tracking-widest text-faint uppercase">Views</div>
				<div class="mt-1.5 flex flex-wrap gap-1.5">
					{#each CAPS as o (o.v)}
						<button
							onclick={() => (cap = o.v)}
							class="rounded-md border px-2 py-1 font-mono text-[11px] transition-colors {cap === o.v
								? 'border-primary/60 text-primary'
								: 'border-line text-muted hover:text-base-content'}">{o.label}</button
						>
					{/each}
				</div>

				{#if err}
					<div class="mt-2 font-mono text-[11px] text-error">Couldn't create the link.</div>
				{/if}
				<button
					onclick={create}
					disabled={creating}
					class="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90 disabled:opacity-50"
					>{creating ? 'Creating…' : 'Create link'}</button
				>
			{/if}
		</div>
	{/if}
</div>
