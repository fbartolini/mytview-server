<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let origin = $state('');
	let copied = $state(false);
	onMount(() => (origin = location.origin));
	const link = $derived(form?.token ? `${origin}/signup?invite=${form.token}` : '');

	async function copy() {
		try {
			await navigator.clipboard.writeText(link);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard blocked; the field is selectable */
		}
	}
</script>

<svelte:head><title>Invite · MytView</title></svelte:head>

<a href="/" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</a>

<div class="max-w-xl">
	<h1 class="text-xl font-bold tracking-tight">Invite someone</h1>
	<p class="mt-1 font-mono text-xs text-muted">
		Generate a one-time link so someone can create an account.
	</p>

	<form method="POST" use:enhance class="mt-4">
		<button
			class="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90"
		>
			Generate invite link
		</button>
	</form>

	{#if link}
		<div class="mt-4 flex items-center gap-2 rounded-lg border border-line bg-base-200 p-3">
			<input
				readonly
				value={link}
				class="w-full bg-transparent font-mono text-xs outline-none"
				onfocus={(e) => e.currentTarget.select()}
			/>
			<button
				onclick={copy}
				class="shrink-0 rounded-md border border-line px-2 py-1 font-mono text-xs text-muted hover:text-base-content"
			>
				{copied ? 'copied' : 'copy'}
			</button>
		</div>
	{/if}

	{#if data.invites.length}
		<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
			Your invites
		</h2>
		<div class="rounded-xl border border-line bg-base-200">
			{#each data.invites as inv (inv.token)}
				<div
					class="flex items-center gap-3 border-b border-line-soft px-3.5 py-2 font-mono text-xs last:border-b-0"
				>
					<span class="truncate text-muted">{inv.token}</span>
					<span class="ml-auto {inv.used_at ? 'text-faint' : 'text-primary'}"
						>{inv.used_at ? 'used' : 'active'}</span
					>
				</div>
			{/each}
		</div>
	{/if}
</div>
