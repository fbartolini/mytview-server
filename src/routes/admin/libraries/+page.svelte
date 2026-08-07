<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Format = 'channels' | 'series';
	type Lib = PageData['libraries'][number];

	// Add/edit form model. editId === null → "Add"; a number → editing that library.
	let editId = $state<number | null>(null);
	let name = $state('');
	let path = $state('');
	let format = $state<Format>('channels');
	let newPrivate = $state(false);

	function reset() {
		editId = null;
		name = '';
		path = '';
		format = 'channels';
		newPrivate = false;
		browsing = false;
	}
	function startEdit(l: Lib) {
		editId = l.id;
		name = l.name;
		path = l.path;
		format = l.format;
		newPrivate = l.newPrivate;
		browsing = false;
	}

	// --- folder browser -----------------------------------------------------------------------------
	let browsing = $state(false);
	let browsePath = $state('');
	let browseDirs = $state<string[]>([]);
	let browseErr = $state('');

	async function browse(to: string) {
		browseErr = '';
		try {
			const res = await fetch('/admin/libraries/browse?path=' + encodeURIComponent(to));
			if (!res.ok) throw new Error();
			const j = (await res.json()) as { path: string; dirs: string[] };
			browsePath = j.path;
			browseDirs = j.dirs;
		} catch {
			browseErr = 'Could not read that folder.';
		}
	}
	function openBrowser() {
		browsing = true;
		browse(path);
	}
	function up() {
		const parts = browsePath.split('/').filter(Boolean);
		parts.pop();
		browse(parts.join('/'));
	}
	const crumbs = $derived(browsePath ? browsePath.split('/').filter(Boolean) : []);

	// On a successful add/edit/delete: clear the form model + refresh the list. update() still runs so
	// a validation FAIL populates `form` (and its error message) as usual.
	const afterSubmit: SubmitFunction = () => async ({ result, update }) => {
		if (result.type === 'success') {
			reset();
			await invalidateAll();
		}
		await update();
	};

	const errorMsg = $derived(form && 'error' in form ? (form.error as string) : null);
	const scanStarted = $derived(!!(form && 'scanned' in form));

	const input =
		'w-full rounded border border-line bg-base-200 px-2.5 py-1.5 text-sm text-base-content focus:border-primary/70 focus:outline-none';
	const fmtBadge = (f: Format) => (f === 'series' ? 'bg-primary/15 text-primary' : 'bg-base-300 text-muted');
</script>

<svelte:head><title>Libraries · MytView</title></svelte:head>

<a href="/channels" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← channels</a>

<div class="mb-5 flex items-start justify-between gap-4">
	<div>
		<h1 class="mb-1 text-xl font-bold">Libraries</h1>
		<p class="max-w-[70ch] text-[13px] leading-relaxed text-muted">
			Point MytView at folders inside your media mount. Each library has a <b class="text-base-content"
				>format</b
			>
			— <span class="text-base-content">channels</span> (videos + <code>.info.json</code>) or
			<span class="text-base-content">series</span> (TV shows with <code>.nfo</code> + seasons) — and its
			own default visibility for newly-found items. With none defined, the whole media folder is one public
			channels library.
		</p>
	</div>
	<form method="POST" action="?/scan" use:enhance>
		<button
			class="whitespace-nowrap rounded border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-primary/60 hover:text-base-content"
			>Scan now</button
		>
	</form>
</div>

{#if errorMsg}
	<p class="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-300">{errorMsg}</p>
{/if}
{#if scanStarted}
	<p class="mb-3 text-sm text-muted">Re-indexing in the background — progress shows in the header.</p>
{/if}

<!-- existing libraries -->
<div class="mb-6 divide-y divide-line rounded border border-line">
	{#if data.libraries.length === 0}
		<p class="px-3 py-4 text-sm text-muted">
			No libraries yet — the whole media folder is treated as one public channels library. Add one below
			to split or reclassify it.
		</p>
	{/if}
	{#each data.libraries as l (l.id)}
		<div class="flex items-center gap-3 px-3 py-2.5">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="truncate font-medium text-base-content">{l.name}</span>
					<span class="rounded px-1.5 py-0.5 font-mono text-[10px] {fmtBadge(l.format)}">{l.format}</span>
					{#if !l.exists}
						<span
							class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300"
							title="This folder wasn't found under the media root">missing</span
						>
					{/if}
				</div>
				<div class="mt-0.5 font-mono text-xs text-muted">
					/media/{l.path} · new items {l.newPrivate ? 'private' : 'public'}
				</div>
			</div>
			<button
				class="rounded border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-primary/60 hover:text-base-content"
				onclick={() => startEdit(l)}>Edit</button
			>
			<form method="POST" action="?/delete" use:enhance={afterSubmit}>
				<input type="hidden" name="id" value={l.id} />
				<button
					class="rounded border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-red-500/60 hover:text-red-300"
					>Delete</button
				>
			</form>
		</div>
	{/each}
</div>

<!-- add / edit -->
<form
	method="POST"
	action={editId == null ? '?/add' : '?/update'}
	use:enhance={afterSubmit}
	class="rounded border border-line p-4"
>
	<h2 class="mb-3 text-sm font-semibold text-base-content">
		{editId == null ? 'Add a library' : 'Edit library'}
	</h2>
	{#if editId != null}<input type="hidden" name="id" value={editId} />{/if}

	<div class="grid gap-3 sm:grid-cols-2">
		<label class="block">
			<span class="mb-1 block text-xs text-muted">Name</span>
			<input class={input} name="name" bind:value={name} placeholder="e.g. TV Shows" />
		</label>
		<label class="block">
			<span class="mb-1 block text-xs text-muted">Format</span>
			<select class={input} name="format" bind:value={format}>
				<option value="channels">channels — videos + .info.json</option>
				<option value="series">series — TV shows (.nfo + seasons)</option>
			</select>
		</label>
	</div>

	<div class="mt-3">
		<span class="mb-1 block text-xs text-muted">Folder</span>
		<div class="flex gap-2">
			<input class={input} name="path" bind:value={path} placeholder="(media root)" />
			<button
				type="button"
				class="whitespace-nowrap rounded border border-line px-3 text-sm text-muted transition-colors hover:border-primary/60 hover:text-base-content"
				onclick={openBrowser}>Browse…</button
			>
		</div>
		<p class="mt-1 font-mono text-[11px] text-muted">/media/{path}</p>
	</div>

	{#if browsing}
		<div class="mt-2 rounded border border-line bg-base-200 p-2">
			<div class="mb-1.5 flex flex-wrap items-center gap-1 font-mono text-[11px] text-muted">
				<button type="button" class="hover:text-base-content" onclick={() => browse('')}>media</button>
				{#each crumbs as c, i}
					<span>/</span>
					<button
						type="button"
						class="hover:text-base-content"
						onclick={() => browse(crumbs.slice(0, i + 1).join('/'))}>{c}</button
					>
				{/each}
			</div>
			{#if browseErr}<p class="text-xs text-red-300">{browseErr}</p>{/if}
			<div class="max-h-48 overflow-y-auto">
				{#if browsePath}
					<button
						type="button"
						class="block w-full px-1 py-1 text-left text-sm text-muted hover:text-base-content"
						onclick={up}>../</button
					>
				{/if}
				{#each browseDirs as d}
					<button
						type="button"
						class="block w-full px-1 py-1 text-left text-sm text-base-content hover:text-primary"
						onclick={() => browse(browsePath ? browsePath + '/' + d : d)}>{d}/</button
					>
				{:else}
					<p class="px-1 py-1 text-xs text-muted">No subfolders here.</p>
				{/each}
			</div>
			<div class="mt-2 flex justify-end gap-2">
				<button
					type="button"
					class="rounded border border-line px-2.5 py-1 text-xs text-muted hover:text-base-content"
					onclick={() => (browsing = false)}>Cancel</button
				>
				<button
					type="button"
					class="rounded bg-primary/90 px-2.5 py-1 text-xs font-medium text-base-100 hover:bg-primary"
					onclick={() => {
						path = browsePath;
						browsing = false;
					}}>Use this folder</button
				>
			</div>
		</div>
	{/if}

	<label class="mt-3 flex items-center gap-2 text-sm text-base-content">
		<input type="checkbox" name="newPrivate" bind:checked={newPrivate} class="accent-primary" />
		New {format === 'series' ? 'shows' : 'channels'} in this library are private by default
	</label>

	<div class="mt-4 flex gap-2">
		<button class="rounded bg-primary/90 px-4 py-1.5 text-sm font-medium text-base-100 hover:bg-primary"
			>{editId == null ? 'Add library' : 'Save'}</button
		>
		{#if editId != null}
			<button
				type="button"
				class="rounded border border-line px-4 py-1.5 text-sm text-muted hover:text-base-content"
				onclick={reset}>Cancel</button
			>
		{/if}
	</div>
</form>
