<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Reset password · MytView</title></svelte:head>

<div class="mx-auto mt-24 max-w-xs px-4">
	<div class="mb-6 flex justify-center">
		<img src="/logo.png" alt="MytView" class="h-8 w-auto" />
	</div>

	{#if !data.valid}
		<div class="rounded-xl border border-line bg-base-200 p-6 text-center">
			<h1 class="text-sm font-semibold">Reset link invalid</h1>
			<p class="mt-2 font-mono text-xs text-muted">
				This link has expired or was already used. Ask the owner to generate a new one.
			</p>
			<a
				href="/login"
				class="mt-4 inline-block font-mono text-xs text-muted hover:text-base-content">Back to sign in</a
			>
		</div>
	{:else}
		<form
			method="POST"
			use:enhance
			class="flex flex-col gap-3 rounded-xl border border-line bg-base-200 p-6"
		>
			<h1 class="text-sm font-semibold">Set a new password</h1>
			<p class="font-mono text-xs text-muted">
				for <span class="text-base-content">{data.username}</span>
			</p>
			{#if form?.error}<div class="font-mono text-xs text-error">{form.error}</div>{/if}
			<input type="hidden" name="token" value={data.token} />
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
				class="mt-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90"
			>
				Set password &amp; sign in
			</button>
		</form>
	{/if}
</div>
