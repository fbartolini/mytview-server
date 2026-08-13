<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// While a PIN ceremony is live, poll the load every 3s — the server-side poller flips the
	// pending state to linked/expired and this page just re-reads it.
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		const waiting = data.plex.pending?.status === 'waiting' || data.plex.pending?.status === 'resolving';
		if (waiting && !pollTimer) pollTimer = setInterval(() => void invalidateAll(), 3000);
		if (!waiting && pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	});
	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});
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
		action="?/password"
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

	{#if data.plex.enabled || data.plex.admin}
		<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
			Plex
		</h2>

		{#if data.plex.admin}
			<!-- Owner: the server settings live HERE (deliberately no /admin page or menu entry). -->
			<div class="mb-3 rounded-xl border border-line bg-base-200 p-5">
				{#if form && 'plexVersion' in form}
					<p class="mb-2 font-mono text-xs text-primary">Connected — Plex Media Server {form.plexVersion}.</p>
				{/if}
				<form method="POST" action="?/plexSetUrl" use:enhance class="flex flex-wrap items-center gap-2">
					<label class="font-mono text-[11px] text-faint" for="plexurl">Plex server</label>
					<input
						id="plexurl"
						name="url"
						value={data.plex.admin.url ?? ''}
						placeholder="http://192.0.2.10:32400"
						class="w-64 rounded-lg border border-line bg-base-100 px-3 py-1.5 font-mono text-xs outline-none focus:border-primary/50"
					/>
					<button class="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-primary/60 hover:text-base-content">save</button>
					<span class="font-mono text-[11px] text-faint">blank = disable Plex sync</span>
				</form>
				{#if data.plex.admin.url}
					<div class="mt-3 flex flex-wrap items-center gap-4">
						<form method="POST" action="?/plexSetSyncMin" use:enhance class="inline-flex items-center gap-1">
							<label
								class="font-mono text-[11px] text-faint"
								title="Minutes between sync cycles (0 = manual only; 1–4 clamp to 5). Applies immediately."
							>
								sync every
								<input
									name="minutes"
									type="number"
									min="0"
									max="10080"
									value={data.plex.admin.syncMinutes}
									class="w-14 rounded-md border border-line bg-base-100 px-1.5 py-0.5 text-center font-mono text-xs outline-none focus:border-primary/50"
								/>
								min
							</label>
							<button class="font-mono text-xs text-muted hover:text-base-content">set</button>
						</form>
						<form method="POST" action="?/plexSyncNow" use:enhance class="inline-flex">
							<button class="font-mono text-xs text-muted hover:text-base-content"
								>sync now{data.plex.admin.syncing ? ' (running…)' : ''}</button
							>
						</form>
						{#if data.plex.admin.matches}
							<span
								class="font-mono text-[11px] text-faint"
								title="Plex items matched to library items (ids, else file paths); unmatched items simply don't sync"
							>
								{data.plex.admin.matches.matched} matched · {data.plex.admin.matches.unmatched} unmatched{data
									.plex.admin.matches.ambiguous
									? ` · ${data.plex.admin.matches.ambiguous} ambiguous`
									: ''}
							</span>
						{/if}
					</div>
					{#if data.plex.admin.links.length > 0}
						<div class="mt-3 border-t border-line-soft pt-2">
							{#each data.plex.admin.links as l (l.user_id)}
								<div class="flex flex-wrap items-baseline gap-2 py-1 font-mono text-xs">
									<span class="text-base-content">{l.username}</span>
									<span class="text-faint">↔ {l.plex_username ?? 'unknown'}</span>
									<span class="ml-auto {l.last_error ? 'text-error' : 'text-faint'}">
										{l.last_error ??
											(l.last_sync_at ? `synced ${new Date(l.last_sync_at).toLocaleString()}` : 'never synced')}
									</span>
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
		{/if}

		{#if data.plex.enabled}
		<div class="rounded-xl border border-line bg-base-200 p-5">
			{#if data.plex.linked}
				<p class="font-mono text-xs text-muted">
					Linked as <span class="text-base-content">{data.plex.linked.username}</span> — your watched
					state and resume points sync both ways with Plex.
					{#if data.plex.linked.lastError}
						<span class="text-error">{data.plex.linked.lastError}</span>
					{:else if data.plex.linked.lastSyncAt}
						<span class="text-faint">last sync {new Date(data.plex.linked.lastSyncAt).toLocaleString()}</span>
					{/if}
				</p>
				<form method="POST" action="?/plexUnlink" use:enhance class="mt-3">
					<button class="font-mono text-xs text-error/80 hover:text-error">unlink Plex</button>
				</form>
			{:else if data.plex.pending && (data.plex.pending.status === 'waiting' || data.plex.pending.status === 'resolving')}
				<p class="mb-2 text-sm">
					Enter this code at
					<a
						href={data.plex.pending.url}
						target="_blank"
						rel="noopener"
						class="text-primary underline">plex.tv/link</a
					>:
				</p>
				<div class="mb-3 font-mono text-3xl font-bold tracking-[0.3em] text-base-content">
					{data.plex.pending.code}
				</div>
				<p class="font-mono text-xs text-faint">
					{data.plex.pending.status === 'resolving' ? 'Linking…' : 'Waiting for you to enter the code…'}
				</p>
				<form method="POST" action="?/plexCancel" use:enhance class="mt-3">
					<button class="font-mono text-xs text-muted hover:text-base-content">cancel</button>
				</form>
			{:else}
				{#if data.plex.pending?.status === 'expired'}
					<p class="mb-2 font-mono text-xs text-warning">That code expired — start again.</p>
				{:else if data.plex.pending?.status === 'error'}
					<p class="mb-2 font-mono text-xs text-error">{data.plex.pending.error}</p>
				{/if}
				<p class="mb-3 text-sm text-muted">
					Link your Plex account to sync watched state and resume points both ways.
				</p>
				<form method="POST" action="?/plexLink" use:enhance>
					<button
						class="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-content hover:opacity-90"
						>Link Plex account</button
					>
				</form>
				<details class="mt-3">
					<summary class="cursor-pointer font-mono text-xs text-faint">paste a token instead</summary>
					<form method="POST" action="?/plexToken" use:enhance class="mt-2 flex gap-2">
						<input
							name="token"
							placeholder="X-Plex-Token"
							class="flex-1 rounded-lg border border-line bg-base-100 px-3 py-2 font-mono text-xs outline-none focus:border-primary/50"
						/>
						<button class="rounded-lg border border-line px-3 text-xs text-muted hover:border-primary/60">link</button>
					</form>
				</details>
			{/if}
		</div>
		{/if}
	{/if}

	<p class="mt-4 font-mono text-xs text-muted">
		Manage your signed-in devices on
		<a href="/sessions" class="text-base-content underline hover:text-primary">Devices</a>.
	</p>
</div>
