<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { form, data }: { form: ActionData; data: PageData } = $props();
	const codeVal = $derived(form && 'code' in form ? form.code : data.code);
	const approved = $derived(!!form && 'success' in form && form.success);
	const errMsg = $derived(form && 'error' in form ? form.error : null);
</script>

<svelte:head><title>Link a TV · MytView</title></svelte:head>

<div class="mx-auto mt-24 max-w-xs px-4">
	<div class="mb-6 text-center font-mono text-lg font-semibold tracking-wide">
		myt<span class="text-primary">view</span>
	</div>

	{#if approved}
		<div class="rounded-xl border border-line bg-base-200 p-6 text-center">
			<div class="text-2xl text-primary">✓</div>
			<p class="mt-2 text-sm font-semibold">Device linked</p>
			<p class="mt-1 font-mono text-[11px] text-faint">
				Your TV should sign in within a few seconds.
			</p>
			<a href="/" class="mt-4 block font-mono text-xs text-primary hover:underline">Done</a>
		</div>
	{:else}
		<form
			method="POST"
			use:enhance
			class="flex flex-col gap-3 rounded-xl border border-line bg-base-200 p-6"
		>
			<h1 class="text-sm font-semibold">Link a TV</h1>
			<p class="font-mono text-[11px] text-faint">
				Enter the code shown on your TV to sign it in as
				<span class="text-base-content">{data.username}</span>.
			</p>
			{#if errMsg}<div class="font-mono text-xs text-error">{errMsg}</div>{/if}
			<input
				name="code"
				placeholder="XXXX-XXXX"
				autocomplete="off"
				autocapitalize="characters"
				spellcheck="false"
				value={codeVal}
				class="w-full rounded-lg border border-line bg-base-100 px-3 py-2 text-center font-mono text-lg tracking-[0.3em] uppercase outline-none focus:border-primary/50"
			/>
			<button
				class="mt-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90"
			>
				Approve
			</button>
		</form>
	{/if}
</div>
