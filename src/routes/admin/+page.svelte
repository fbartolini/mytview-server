<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const card =
		'block rounded-xl border border-line bg-base-200 p-4 transition-colors hover:border-primary/50';
</script>

<svelte:head><title>Server · MytView</title></svelte:head>

<a href="/" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</a>

<h1 class="mb-1 text-xl font-bold tracking-tight">Server</h1>
<p class="mb-5 max-w-[70ch] text-[13px] leading-relaxed text-muted">
	Everything only you (the owner) can change. Your own password, Plex link, and devices live on
	<a href="/account" class="text-base-content underline hover:text-primary">Account</a>.
</p>

<div class="grid gap-3 sm:grid-cols-2">
	<a href="/admin/libraries" class={card}>
		<h2 class="font-semibold">Libraries</h2>
		<p class="mt-0.5 text-[13px] text-muted">What gets indexed, and as which format.</p>
		<p class="mt-2 font-mono text-[11px] text-faint">
			{data.libraries.count} librar{data.libraries.count === 1 ? 'y' : 'ies'}{data.libraries.phantom
				? ` · ${data.libraries.phantom} federated`
				: ''} · {data.media.videos} videos · {data.media.channels} channels
		</p>
	</a>

	<a href="/admin/visibility" class={card}>
		<h2 class="font-semibold">Sharing</h2>
		<p class="mt-0.5 text-[13px] text-muted">
			Who sees which channels — your users and any federated servers.
		</p>
		<p class="mt-2 font-mono text-[11px] text-faint">
			{data.users.total} user{data.users.total === 1 ? '' : 's'}{data.federation.sharing
				? ` · ${data.federation.sharing} peer server${data.federation.sharing === 1 ? '' : 's'}`
				: ''}
		</p>
	</a>

	<a href="/admin/users" class={card}>
		<h2 class="font-semibold">Users</h2>
		<p class="mt-0.5 text-[13px] text-muted">Accounts, password resets, deactivation.</p>
		<p class="mt-2 font-mono text-[11px] text-faint">
			{data.users.total} account{data.users.total === 1 ? '' : 's'}{data.users.deactivated
				? ` · ${data.users.deactivated} deactivated`
				: ''}
		</p>
	</a>

	<a href="/admin/federation" class={card}>
		<h2 class="font-semibold">Federation</h2>
		<p class="mt-0.5 text-[13px] text-muted">
			Peer with other MytView servers — invites, library mappings, stream caps.
		</p>
		<p class="mt-2 font-mono text-[11px] text-faint">
			{data.federation.sharing} sharing to · {data.federation.consuming} consuming from
		</p>
	</a>
</div>

<!-- Maintenance: the heavy rescan lives HERE, not one click from every page in the avatar menu. -->
<section class="mt-6 rounded-xl border border-line p-4">
	<h2 class="font-semibold">Maintenance</h2>
	<p class="mt-0.5 max-w-[70ch] text-[13px] text-muted">
		The library rescans itself automatically, and <span class="text-base-content">Rescan library</span>
		in the menu picks up new files in seconds. A <span class="text-base-content">full rescan</span>
		re-reads every file from scratch — use it after changing metadata or when artwork looks stale.
		It's slower and safe to run any time.
	</p>
	<div class="mt-3 flex flex-wrap items-center gap-3">
		<form method="POST" action="?/fullRescan" use:enhance>
			<button
				disabled={data.scan.scanning}
				class="rounded-lg border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-primary/60 hover:text-base-content disabled:opacity-50"
				>{data.scan.scanning ? 'Scanning…' : 'Full rescan'}</button
			>
		</form>
		{#if form?.ok}
			<span class="font-mono text-[11px] text-primary">Full rescan started — it runs in the background.</span>
		{:else if data.scan.last}
			<span class="font-mono text-[11px] text-faint">
				last scan: {data.scan.last.videos} videos in {data.scan.last.elapsed_s}s
			</span>
		{/if}
	</div>
	{#if data.plex.configured || data.plex.linked > 0}
		<p class="mt-3 border-t border-line-soft pt-3 font-mono text-[11px] text-faint">
			Plex sync: {data.plex.linked} account{data.plex.linked === 1 ? '' : 's'} linked — settings on
			<a href="/account" class="text-muted underline hover:text-base-content">Account</a>.
		</p>
	{/if}
</section>
