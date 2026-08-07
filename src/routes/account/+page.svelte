<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Account · MytView</title></svelte:head>

<a href="/" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</a>

<div class="max-w-xl">
	<h1 class="text-xl font-bold tracking-tight">Account</h1>
	<p class="mt-1 font-mono text-xs text-muted">
		Signed in as <span class="text-base-content">{data.username}</span>{#if data.isOwner}
			<span class="text-primary">· owner</span>{/if}
	</p>

	<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
		Change password
	</h2>
	<form
		method="POST"
		use:enhance
		class="flex flex-col gap-3 rounded-xl border border-line bg-base-200 p-5"
	>
		{#if form?.error}<div class="font-mono text-xs text-error">{form.error}</div>{/if}
		{#if form?.ok}
			<div class="font-mono text-xs text-primary">
				Password changed.{#if form.killed} Signed out {form.killed} other device{form.killed === 1
						? ''
						: 's'}.{/if}
			</div>
		{/if}
		<input
			name="current"
			type="password"
			placeholder="current password"
			autocomplete="current-password"
			class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
		/>
		<input
			name="next"
			type="password"
			placeholder="new password"
			autocomplete="new-password"
			class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
		/>
		<input
			name="confirm"
			type="password"
			placeholder="confirm new password"
			autocomplete="new-password"
			class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
		/>
		<button
			class="mt-1 self-start rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90"
		>
			Change password
		</button>
	</form>

	<p class="mt-4 font-mono text-xs text-muted">
		Manage your signed-in devices on
		<a href="/sessions" class="text-base-content underline hover:text-primary">Devices</a>.
	</p>
</div>
