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

	// Sections start COLLAPSED — the library row (with its whole-library share) is the overview;
	// expand a section for per-channel detail. An active search/filter/focus force-expands so a
	// match can never hide inside a collapsed section.
	let open = $state<Record<string, boolean>>({});
	const forceOpen = $derived(query !== '' || filter !== 'all' || focusUser !== null);
	const isOpen = (id: number | null): boolean => forceOpen || !!open[String(id)];

	// Rows grouped by LIBRARY (owner-defined order, unassigned last) — the library header row
	// carries the whole-library federation share (current + future content).
	const groups = $derived.by(() => {
		const byLib = new Map<number | null, typeof data.channels>();
		for (const c of data.channels) {
			const k = c.library_id ?? null;
			if (!byLib.has(k)) byLib.set(k, []);
			byLib.get(k)!.push(c);
		}
		const out: { id: number | null; name: string; channels: typeof data.channels }[] = [];
		for (const l of data.libraries) {
			if (byLib.has(l.id)) out.push({ id: l.id, name: l.name, channels: byLib.get(l.id)! });
		}
		if (byLib.has(null)) out.push({ id: null, name: 'Unassigned', channels: byLib.get(null)! });
		return out;
	});
</script>

<svelte:head><title>Sharing · MytView</title></svelte:head>

<a
	href="/channels"
	class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← channels</a
>

<h1 class="mb-1 text-xl font-bold">Sharing</h1>
<p class="mb-5 max-w-[70ch] text-[13px] leading-relaxed text-muted">
	Who sees what — your <span class="text-base-content">users</span> and any
	<span class="text-sky-300">⇄ federated servers</span>. Public channels are visible to every user;
	mark one <span class="text-base-content">private</span> and tick who it's shared with. Federated
	servers get nothing until ticked — use a library row's
	<span class="text-base-content">whole</span> toggle to share everything in it, current and future,
	or expand the library for per-channel control.
	<span class="text-faint">Changes save automatically.</span>
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
					Library
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
				{#each data.links as link (link.id)}
					<!-- Federated servers: one more principal you share with. Per-channel checkboxes in
					     the rows; the whole-library toggle lives on each library's section header. -->
					<div class="flex w-20 shrink-0 flex-col items-center gap-1">
						<span
							class="max-w-full truncate font-mono text-[11px] text-sky-300"
							title="Federated server “{link.name}” — sharing is allow-list: nothing is shared until ticked"
							>⇄ {link.name}</span
						>
						<span class="font-mono text-[9px] tracking-wider text-faint uppercase">server</span>
					</div>
				{/each}
			</div>

			{#each groups as g (g.id ?? 'none')}
				<div class="flex items-center gap-2 border-b border-line-soft bg-base-300/40 py-1.5">
					<button
						onclick={() => (open[String(g.id)] = !isOpen(g.id))}
						class="flex min-w-[9rem] flex-1 items-center gap-1.5 text-left font-mono text-[10px] font-semibold tracking-widest text-faint uppercase transition-colors hover:text-base-content"
						title={isOpen(g.id) ? 'Collapse this library' : 'Expand for per-channel control'}
					>
						<span class="w-3 text-center">{isOpen(g.id) ? '▾' : '▸'}</span>
						{g.name}
						<span class="font-normal tracking-normal text-faint normal-case">· {g.channels.length}</span>
					</button>
					<div class="w-4 shrink-0"></div>
					<div class="w-16 shrink-0"></div>
					{#each data.users as u (u.id)}
						<div class="w-20 shrink-0" class:hidden={focusUser !== null && focusUser !== u.id}></div>
					{/each}
					{#each data.links as link (link.id)}
						<div class="flex w-20 shrink-0 justify-center">
							{#if g.id != null}
								{@const whole = link.grantedLibraryIds.includes(g.id)}
								<form
									method="POST"
									action="?/setFedLibraryGrant"
									use:enhance={afterBulk(
										whole
											? `Stopped sharing the whole ${g.name} library with ${link.name}.`
											: `Sharing the whole ${g.name} library (current + future) with ${link.name}.`
									)}
								>
									<input type="hidden" name="linkId" value={link.id} />
									<input type="hidden" name="libraryId" value={g.id} />
									<input type="hidden" name="on" value={whole ? '0' : '1'} />
									<button
										class="{miniBtn} {whole ? 'border-sky-400/60 text-sky-300' : ''}"
										title="Share the WHOLE {g.name} library with {link.name} — everything in it now and in the future"
										>{whole ? 'whole ✓' : 'whole'}</button
									>
								</form>
							{/if}
						</div>
					{/each}
				</div>
				{#each g.channels as ch (ch.id)}
					{#key version}
						<ChannelVisibilityRow
							channel={ch}
							users={data.users}
							links={data.links}
							hidden={!passes(ch) || !isOpen(g.id)}
							focusUserId={focusUser}
							onPrivateChange={(p) => (privateById[ch.id] = p)}
						/>
					{/key}
				{/each}
			{/each}
			{#if !anyShown}
				<p class="py-6 font-mono text-sm text-muted">No channels match.</p>
			{/if}
		</div>
	</div>
{/if}
