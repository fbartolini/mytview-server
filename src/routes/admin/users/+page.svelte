<script lang="ts">
	import { enhance } from '$app/forms';
	import { copyText } from '$lib/copy';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let copied = $state(false);
	async function copy(text: string) {
		// copyText handles the plain-HTTP LAN case (no navigator.clipboard there — $lib/copy).
		if (await copyText(text)) {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} else {
			window.prompt('Copy this link:', text);
		}
	}

	function fmt(ts: number | null): string {
		if (!ts) return '—';
		return new Date(ts).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<svelte:head><title>Users · MytView</title></svelte:head>

<a href="/" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</a>

<div class="max-w-2xl">
	<h1 class="text-xl font-bold tracking-tight">Users</h1>
	<p class="mt-1 font-mono text-xs text-muted">
		Generate a reset link for a forgotten password, or suspend / remove an account. We track no
		email, so a reset link is copied and sent to the user out-of-band.
	</p>

	{#if form?.error}
		<div class="mt-4 rounded-lg border border-error/40 bg-error/10 p-3 font-mono text-xs text-error">
			{form.error}
		</div>
	{/if}

	{#if form?.resetLink}
		<div class="mt-4 rounded-xl border border-primary/40 bg-base-200 p-3.5">
			<div class="font-mono text-[11px] text-muted">
				Reset link for <span class="text-base-content">{form.resetUser}</span> — send it to them; it's
				single-use and expires in 3 days.
			</div>
			<div class="mt-2 flex items-center gap-2 rounded-lg border border-line bg-base-100 p-2">
				<input
					readonly
					value={form.resetLink}
					class="w-full bg-transparent font-mono text-xs outline-none"
					onfocus={(e) => e.currentTarget.select()}
				/>
				<button
					onclick={() => copy(form!.resetLink!)}
					class="shrink-0 rounded-md border border-line px-2 py-1 font-mono text-xs text-muted hover:text-base-content"
				>
					{copied ? 'copied' : 'copy'}
				</button>
			</div>
		</div>
	{/if}

	<div class="mt-6 rounded-xl border border-line bg-base-200">
		{#each data.users as u (u.id)}
			<div
				class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-soft px-3.5 py-3 last:border-b-0"
			>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span class="truncate text-sm font-semibold">{u.username}</span>
						{#if u.isOwner}<span class="font-mono text-[10px] text-primary">owner</span>{/if}
						{#if u.deactivated_at}<span class="font-mono text-[10px] text-error">suspended</span
							>{/if}
					</div>
					<div class="mt-0.5 font-mono text-[11px] text-faint">
						joined {fmt(u.created_at)} · last seen {fmt(u.last_seen)}
					</div>
				</div>

				{#if !u.isOwner}
					<div class="ml-auto flex items-center gap-1.5">
						<form method="POST" action="?/reset" use:enhance>
							<input type="hidden" name="userId" value={u.id} />
							<button
								class="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted hover:border-primary/60 hover:text-base-content"
							>
								reset link
							</button>
						</form>

						{#if u.deactivated_at}
							<form method="POST" action="?/reactivate" use:enhance>
								<input type="hidden" name="userId" value={u.id} />
								<button
									class="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted hover:border-primary/60 hover:text-base-content"
								>
									reactivate
								</button>
							</form>
						{:else}
							<form method="POST" action="?/deactivate" use:enhance>
								<input type="hidden" name="userId" value={u.id} />
								<button
									class="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted hover:border-primary/60 hover:text-base-content"
								>
									deactivate
								</button>
							</form>
						{/if}

						<form
							method="POST"
							action="?/delete"
							use:enhance={({ cancel }) => {
								if (
									!confirm(
										`Delete ${u.username}? This permanently removes their account and watch history.`
									)
								)
									cancel();
							}}
						>
							<input type="hidden" name="userId" value={u.id} />
							<button
								class="rounded-md border border-error/40 px-2 py-1 font-mono text-[11px] text-error/80 hover:border-error hover:text-error"
							>
								delete
							</button>
						</form>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
