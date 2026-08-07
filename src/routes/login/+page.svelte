<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Sign in · MytView</title></svelte:head>

<div class="mx-auto mt-24 max-w-xs px-4">
	<div class="mb-6 flex justify-center">
		<img src="/logo.png" alt="MytView" class="h-8 w-auto" />
	</div>
	<form method="POST" use:enhance class="flex flex-col gap-3 rounded-xl border border-line bg-base-200 p-6">
		<h1 class="text-sm font-semibold">Sign in</h1>
		<input type="hidden" name="next" value={data.next} />
		{#if data.reset}<div class="font-mono text-xs text-primary">Password updated — sign in.</div>{/if}
		{#if form?.error}<div class="font-mono text-xs text-error">{form.error}</div>{/if}
		<input
			name="username"
			placeholder="username"
			autocomplete="username"
			value={form?.username ?? ''}
			class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
		/>
		<input
			name="password"
			type="password"
			placeholder="password"
			autocomplete="current-password"
			class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
		/>
		<button class="mt-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90">
			Sign in
		</button>
		<a href="/signup" class="text-center font-mono text-xs text-muted hover:text-base-content">
			Create an account
		</a>
	</form>
</div>
