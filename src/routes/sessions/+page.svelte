<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Devices · MytView</title></svelte:head>

<div class="mb-2 flex items-baseline gap-3">
	<h1 class="text-xl font-bold tracking-tight">Devices</h1>
	<span class="font-mono text-xs text-faint">{data.sessions.length} signed in</span>
</div>
<p class="mb-5 text-sm text-muted">
	Every device and browser signed in to your account. Revoke any you don’t recognise — that session
	is signed out immediately.
</p>

<div class="flex flex-col gap-2.5">
	{#each data.sessions as s (s.id)}
		<div
			class="flex items-center gap-3 rounded-xl border bg-base-200 p-3 {s.current
				? 'border-primary/60'
				: 'border-line'}"
		>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="line-clamp-1 text-sm font-medium">{s.label}</span>
					{#if s.current}
						<span class="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary"
							>THIS DEVICE</span
						>
					{/if}
				</div>
				<div class="mt-1 font-mono text-[11px] text-muted">
					{s.lastSeenLabel} · {s.createdLabel}
				</div>
			</div>
			{#if !s.current}
				<form method="POST" action="?/revoke">
					<input type="hidden" name="id" value={s.id} />
					<button
						class="shrink-0 rounded-lg border border-line px-2.5 py-1.5 font-mono text-[11px] text-muted transition-colors hover:border-red-400/60 hover:text-red-400"
					>
						Revoke
					</button>
				</form>
			{/if}
		</div>
	{/each}
</div>

{#if data.sessions.length > 1}
	<form method="POST" action="?/revokeOthers" class="mt-5">
		<button
			class="rounded-lg border border-line px-3 py-2 text-sm text-muted transition-colors hover:border-red-400/60 hover:text-red-400"
		>
			Sign out all other devices
		</button>
	</form>
{/if}
