<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import ChannelVisibilityRow from '$lib/components/ChannelVisibilityRow.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const filters = ['all', 'private', 'public'] as const;
	type Filter = (typeof filters)[number];

	let query = $state('');
	let filter = $state<Filter>('all');
	let focusUser = $state<number | null>(null); // narrow the matrix to one user's column

	// Live private state, seeded ONCE from load (untrack) and kept current by each row's onPrivateChange,
	// so the count + private/public filter stay accurate the instant you toggle a channel (no reload).
	let privateById = $state<Record<string, boolean>>(
		untrack(() => Object.fromEntries(data.channels.map((c) => [c.id, c.private])))
	);
	const privateCount = $derived(Object.values(privateById).filter(Boolean).length);

	// Rows stay mounted (so a row keeps its edits) — we just hide the ones that don't match.
	function passes(ch: { id: string; name: string }): boolean {
		if (query && !ch.name.toLowerCase().includes(query.toLowerCase())) return false;
		if (filter === 'private') return !!privateById[ch.id];
		if (filter === 'public') return !privateById[ch.id];
		return true;
	}
	const anyShown = $derived(data.channels.some(passes));

	// A column-header bulk action changed many rows server-side. Reload the data, re-seed the live
	// private map (all-private/all-public flips the flags), and bump `version` so the locally-owned rows
	// remount and re-seed their private + grant state.
	let version = $state(0);
	let bulkMsg = $state('');
	let bulkMsgTimer: ReturnType<typeof setTimeout>;
	function afterBulk(successMsg: string): SubmitFunction {
		return () =>
			async ({ result }) => {
				if (result.type === 'success') {
					await invalidateAll();
					privateById = Object.fromEntries(data.channels.map((c) => [c.id, c.private]));
					version++;
					bulkMsg = successMsg;
				} else {
					bulkMsg = 'That didn’t work — try again.';
				}
				clearTimeout(bulkMsgTimer);
				bulkMsgTimer = setTimeout(() => (bulkMsg = ''), 2600);
			};
	}

	const miniBtn =
		'rounded border border-line px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted transition-colors hover:border-primary/60 hover:text-base-content';
</script>

<svelte:head><title>Channel visibility · MytView</title></svelte:head>

<a
	href="/channels"
	class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← channels</a
>

<h1 class="mb-1 text-xl font-bold">Channel visibility</h1>
<p class="mb-5 max-w-[70ch] text-[13px] leading-relaxed text-muted">
	Public channels are visible to everyone. Mark a channel <span class="text-base-content">private</span>
	to hide it, then tick who it's shared with. You (the owner) always see everything. Use the
	<span class="text-base-content">all / none</span> controls in each column header to change every
	channel at once. <span class="text-faint">Changes save automatically.</span>
</p>

{#if data.channels.length === 0}
	<div class="rounded-xl border border-line bg-base-200 px-4">
		<p class="py-6 font-mono text-sm text-muted">No channels indexed yet.</p>
	</div>
{:else}
	<div class="mb-3 flex flex-wrap items-center gap-2">
		<input
			bind:value={query}
			type="search"
			placeholder="filter channels"
			autocomplete="off"
			spellcheck="false"
			class="min-w-0 flex-1 rounded-lg border border-line bg-base-200 px-3 py-2 font-mono text-[12.5px] outline-none placeholder:text-faint focus:border-primary/50 sm:max-w-xs"
		/>
		<div class="flex rounded-lg border border-line bg-base-200 p-0.5 font-mono text-[11px]">
			{#each filters as f (f)}
				<button
					onclick={() => (filter = f)}
					class="rounded-md px-2.5 py-1 capitalize transition-colors {filter === f
						? 'bg-base-300 text-base-content'
						: 'text-muted hover:text-base-content'}">{f}</button
				>
			{/each}
		</div>
		{#if data.users.length > 1}
			<select
				bind:value={focusUser}
				class="rounded-lg border border-line bg-base-200 px-2.5 py-1.5 font-mono text-[11px] text-muted outline-none focus:border-primary/50"
			>
				<option value={null}>all users</option>
				{#each data.users as u (u.id)}<option value={u.id}>{u.username}</option>{/each}
			</select>
		{/if}
		<span class="font-mono text-[11px] text-faint">
			{privateCount} private · {data.channels.length} total
		</span>
		{#if bulkMsg}<span class="font-mono text-[11px] text-primary">{bulkMsg}</span>{/if}
	</div>

	<div class="rounded-xl border border-line bg-base-200">
		<div class="overflow-x-auto px-4">
			<!-- Matrix header: column labels + per-column all/none bulk actions -->
			<div class="flex items-end gap-2 border-b border-line py-2.5">
				<div
					class="min-w-[9rem] flex-1 font-mono text-[10px] font-semibold tracking-widest text-faint uppercase"
				>
					Channel
				</div>
				<div class="w-4 shrink-0"></div>
				<div class="flex w-16 shrink-0 flex-col items-center gap-1">
					<span class="font-mono text-[10px] font-semibold tracking-wider text-faint uppercase"
						>Priv</span
					>
					<div class="flex gap-0.5">
						<form
							method="POST"
							action="?/setAllVisibility"
							use:enhance={afterBulk('All channels are private.')}
						>
							<input type="hidden" name="mode" value="private" />
							<button title="Make every channel private" class={miniBtn}>all</button>
						</form>
						<form
							method="POST"
							action="?/setAllVisibility"
							use:enhance={afterBulk('All channels are public.')}
						>
							<input type="hidden" name="mode" value="public" />
							<button title="Make every channel public" class={miniBtn}>none</button>
						</form>
					</div>
				</div>
				{#each data.users as u (u.id)}
					<div
						class="flex w-20 shrink-0 flex-col items-center gap-1"
						class:hidden={focusUser !== null && focusUser !== u.id}
					>
						<span class="max-w-full truncate font-mono text-[11px] text-muted" title={u.username}
							>{u.username}</span
						>
						<div class="flex gap-0.5">
							<form
								method="POST"
								action="?/setUserGrants"
								use:enhance={afterBulk(`Shared every private channel with ${u.username}.`)}
							>
								<input type="hidden" name="userId" value={u.id} />
								<input type="hidden" name="mode" value="all" />
								<button title="Grant {u.username} every private channel" class={miniBtn}>all</button>
							</form>
							<form
								method="POST"
								action="?/setUserGrants"
								use:enhance={afterBulk(`Removed ${u.username} from all channels.`)}
							>
								<input type="hidden" name="userId" value={u.id} />
								<input type="hidden" name="mode" value="none" />
								<button title="Remove {u.username} from all channels" class={miniBtn}>none</button>
							</form>
						</div>
					</div>
				{/each}
			</div>

			{#each data.channels as ch (ch.id)}
				{#key version}
					<ChannelVisibilityRow
						channel={ch}
						users={data.users}
						hidden={!passes(ch)}
						focusUserId={focusUser}
						onPrivateChange={(p) => (privateById[ch.id] = p)}
					/>
				{/key}
			{/each}
			{#if !anyShown}
				<p class="py-6 font-mono text-sm text-muted">No channels match.</p>
			{/if}
		</div>
	</div>
{/if}
