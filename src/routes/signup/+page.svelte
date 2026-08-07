<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { form, data }: { form: ActionData; data: PageData } = $props();

	const showInvite = $derived(data.mode === 'invite' && !data.bootstrap);
	const disabled = $derived(data.mode === 'off' && !data.bootstrap);
	const inviteVal = $derived(form && 'invite' in form ? form.invite : data.invite);
	const usernameVal = $derived(form && 'username' in form ? form.username : '');
</script>

<svelte:head><title>Create account · MytView</title></svelte:head>

<div class="mx-auto mt-24 max-w-xs px-4">
	<div class="mb-6 flex justify-center">
		<img src="/logo.png" alt="MytView" class="h-8 w-auto" />
	</div>

	{#if disabled}
		<div class="rounded-xl border border-line bg-base-200 p-6 text-center font-mono text-sm text-muted">
			Signups are disabled on this server.
			<a href="/login" class="mt-3 block text-primary hover:underline">Sign in</a>
		</div>
	{:else}
		<form
			method="POST"
			use:enhance
			class="flex flex-col gap-3 rounded-xl border border-line bg-base-200 p-6"
		>
			<h1 class="text-sm font-semibold">
				{data.bootstrap ? 'Create the owner account' : 'Create an account'}
			</h1>
			{#if data.bootstrap}
				<p class="font-mono text-[11px] text-faint">This is the first account — you'll be the owner.</p>
			{/if}
			{#if form?.error}<div class="font-mono text-xs text-error">{form.error}</div>{/if}
			{#if showInvite}
				<input
					name="invite"
					placeholder="invite code"
					value={inviteVal}
					class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
				/>
			{/if}
			<input
				name="username"
				placeholder="username"
				autocomplete="username"
				value={usernameVal}
				class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
			/>
			<input
				name="password"
				type="password"
				placeholder="password (min 6)"
				autocomplete="new-password"
				class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
			/>
			<button
				class="mt-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90"
			>
				Create account
			</button>
			<a href="/login" class="text-center font-mono text-xs text-muted hover:text-base-content">
				Already have an account? Sign in
			</a>
		</form>
	{/if}
</div>
