<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';

	let {
		channel,
		users,
		links = [],
		hidden = false,
		focusUserId = null,
		onPrivateChange
	}: {
		channel: {
			id: string;
			name: string;
			library_id?: number | null;
			private: boolean;
			grantedUserIds: number[];
		};
		users: { id: number; username: string }[];
		/** Federated servers as additional share principals (allow-list, independent of `private`).
		 *  A whole-library grant renders the box checked+locked — the library header controls it. */
		links?: { id: number; name: string; grantedChannelIds: string[]; grantedLibraryIds: number[] }[];
		hidden?: boolean;
		focusUserId?: number | null;
		onPrivateChange?: (isPrivate: boolean) => void;
	} = $props();

	// Seed from props, then own it locally (untrack silences the "captures initial value" note — the row
	// owns its state; the page bumps a key to remount + re-seed after a bulk action).
	let priv = $state(untrack(() => channel.private));
	let grantedIds = $state<number[]>(untrack(() => [...channel.grantedUserIds]));
	let fedIds = $state<number[]>(
		untrack(() => links.filter((l) => l.grantedChannelIds.includes(channel.id)).map((l) => l.id))
	);
	let status = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');

	let form: HTMLFormElement;
	let saveTimer: ReturnType<typeof setTimeout>;
	// Auto-save: debounce so rapid grant toggles batch into one POST. The row's form always carries the
	// FULL grant set (checkboxes for every user, even ones hidden by the focus filter), so a save never
	// silently drops another user's grant.
	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => form?.requestSubmit(), 300);
	}
	function togglePrivate(e: Event) {
		priv = (e.currentTarget as HTMLInputElement).checked;
		if (!priv) grantedIds = []; // public → no grants (matches the server, which clears them)
		onPrivateChange?.(priv);
		scheduleSave();
	}
</script>

<form
	bind:this={form}
	method="POST"
	action="?/setVisibility"
	class:hidden
	class="flex items-center gap-2 border-b border-line-soft py-2 last:border-b-0"
	use:enhance={() => {
		status = 'saving';
		// No update() — the row owns its state; re-running the page load on every change would be wasteful.
		return async ({ result }) => {
			if (result.type === 'success') {
				status = 'saved';
				setTimeout(() => {
					if (status === 'saved') status = 'idle';
				}, 1400);
			} else {
				status = 'error';
			}
		};
	}}
>
	<input type="hidden" name="channelId" value={channel.id} />
	<span class="min-w-[9rem] flex-1 truncate text-sm font-medium" title={channel.name}
		>{channel.name}</span
	>

	<span
		class="w-4 shrink-0 text-center text-[11px] {status === 'error'
			? 'text-error'
			: status === 'saved'
				? 'text-primary'
				: status === 'saving'
					? 'text-faint'
					: 'text-transparent'}"
		aria-live="polite"
	>
		{status === 'saving' ? '⟳' : status === 'saved' ? '✓' : status === 'error' ? '!' : '·'}
	</span>

	<div class="flex w-16 shrink-0 justify-center">
		<input
			type="checkbox"
			name="private"
			checked={priv}
			onchange={togglePrivate}
			class="accent-primary"
			aria-label="private"
		/>
	</div>

	{#each users as u (u.id)}
		<div
			class="flex w-20 shrink-0 justify-center"
			class:hidden={focusUserId !== null && focusUserId !== u.id}
		>
			<input
				type="checkbox"
				name="grant"
				value={u.id}
				bind:group={grantedIds}
				disabled={!priv}
				onchange={scheduleSave}
				class="accent-primary disabled:opacity-25"
				aria-label={u.username}
				title={priv ? u.username : `${u.username} — only applies to private channels`}
			/>
		</div>
	{/each}

	{#each links as l (l.id)}
		{@const covered = channel.library_id != null && l.grantedLibraryIds.includes(channel.library_id)}
		<div class="flex w-20 shrink-0 justify-center">
			{#if covered}
				<!-- Whole-library grant covers it: locked on (no name → never submitted; the library
				     header's "whole" toggle is the control). -->
				<input
					type="checkbox"
					checked
					disabled
					class="accent-sky-400 opacity-60"
					aria-label="{l.name} (whole library shared)"
					title="Shared via the whole-library grant — use the library row to change"
				/>
			{:else}
				<input
					type="checkbox"
					name="fedgrant"
					value={l.id}
					bind:group={fedIds}
					onchange={scheduleSave}
					class="accent-sky-400"
					aria-label={l.name}
					title="Share “{channel.name}” with {l.name}'s server"
				/>
			{/if}
		</div>
	{/each}
</form>
