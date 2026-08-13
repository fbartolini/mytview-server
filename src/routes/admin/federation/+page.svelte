<script lang="ts">
	import { enhance } from '$app/forms';
	import { copyText } from '$lib/copy';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const fmtWhen = (ms: number | null): string => (ms ? new Date(ms).toLocaleString() : 'never');
	const fmtBytes = (n: number): string =>
		n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.ceil(n / 1000)} KB`;

	const libName = (id: number | null): string =>
		data.libraries.find((l) => l.id === id)?.name ?? 'Unassigned';

	// Inline rename of a peer's LOCAL alias (display-only — never sent to the peer).
	let renamingId = $state<number | null>(null);

	// Compatible local mapping targets for a remote library's format (virtuals included).
	const targetsFor = (format: string) => data.libraries.filter((l) => l.format === format);

	let copied = $state(false);
	async function copyPaste(text: string) {
		// copyText handles the plain-HTTP LAN case (no navigator.clipboard there — $lib/copy).
		if (await copyText(text)) {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} else {
			window.prompt('Copy this invite:', text); // last resort — still hand it over
		}
	}
</script>

<svelte:head><title>Federation · MytView</title></svelte:head>

<h1 class="mb-1 text-xl font-bold tracking-tight">Federation</h1>
<p class="mb-2 font-mono text-xs text-muted">
	server id <span class="text-base-content">{data.serverId.slice(0, 12)}…</span> · invites embed
	<span class="text-base-content">{data.publicBase}</span>
	{#if data.envOverride}<span class="text-faint">(locked by the EXTERNAL_URL env)</span>{/if}
</p>
{#if !data.envOverride}
	<form method="POST" action="?/setExternalUrl" use:enhance class="mb-2 flex flex-wrap items-center gap-2">
		<label class="font-mono text-[11px] text-faint" for="pubaddr">public address</label>
		<input
			id="pubaddr"
			name="url"
			value={data.publicBaseSetting ?? ''}
			placeholder={data.publicBase}
			class="w-72 rounded-md border border-line bg-base-200 px-2 py-1 font-mono text-xs focus:border-primary/70 focus:outline-none"
		/>
		<button class="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-primary/60 hover:text-base-content">save</button>
		<span class="font-mono text-[11px] text-faint">what invites embed · blank = derive from the request</span>
	</form>
	<!-- Sample IPs in UI copy use TEST-NET (192.0.2.x, RFC 5737): real-looking, reserved for docs,
	     and invisible to scripts/publish-server.sh's 192.168.* internal-leak guard. -->
	{#if data.publicBaseSource === 'derived' && !data.publicBaseTrusted}
		<p class="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 font-mono text-[11px]">
			This address was inferred from the current request — its <span class="font-semibold">https://</span>
			may be wrong for a server without TLS (a bare ip:port serves http). If a peer can't connect after
			pairing, set the public address above (e.g. http://192.0.2.10:8700) and send a fresh invite.
		</p>
	{/if}
{/if}

{#if form?.error}
	<div class="mb-4 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm">{form.error}</div>
{/if}
{#if form && 'warning' in form && form.warning}
	<div class="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{form.warning}</div>
{/if}

{#snippet peerName(link: { id: number; peerName: string })}
	{#if renamingId === link.id}
		<form
			method="POST"
			action="?/renameLink"
			use:enhance={() => {
				renamingId = null;
				return async ({ update }) => update();
			}}
			class="inline-flex items-center gap-1"
		>
			<input type="hidden" name="linkId" value={link.id} />
			<!-- svelte-ignore a11y_autofocus -->
			<input
				name="name"
				value={link.peerName}
				autofocus
				class="w-36 rounded-md border border-line bg-base-200 px-2 py-0.5 text-sm focus:border-primary/70 focus:outline-none"
			/>
			<button class="font-mono text-xs text-primary">save</button>
		</form>
	{:else}
		<span class="font-medium">{link.peerName}</span>
		<button
			onclick={() => (renamingId = link.id)}
			class="font-mono text-xs text-faint hover:text-base-content"
			title="Rename this server's alias (only shown here)">✎</button
		>
	{/if}
{/snippet}

<!-- ============================== Sharing to peers ============================== -->
<section class="mb-8 rounded-xl border border-line p-4">
	<div class="mb-3 flex items-baseline gap-3">
		<h2 class="font-bold">Sharing to peers</h2>
		<span class="font-mono text-xs text-faint">{data.sharerLinks.length} linked</span>
		<form method="POST" action="?/createInvite" use:enhance class="ml-auto">
			<button class="rounded-md border border-line px-3 py-1 text-xs hover:border-primary/60"
				>+ new invite</button
			>
		</form>
	</div>

	{#if form && 'paste' in form && form.paste}
		<div class="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
			<div class="mb-1 text-xs text-muted">
				Hand this to the other owner (valid 24h, single use — treat it like a password reset link):
			</div>
			<div class="flex items-center gap-2">
				<code class="flex-1 select-all overflow-x-auto whitespace-nowrap font-mono text-xs">{form.paste}</code>
				<button
					onclick={() => copyPaste(form.paste as string)}
					class="rounded-md border border-line px-2 py-1 text-xs hover:border-primary/60"
					>{copied ? 'copied' : 'copy'}</button
				>
			</div>
		</div>
	{/if}

	{#if data.invites.length > 0}
		<div class="mb-4">
			{#each data.invites as inv (inv.token)}
				<div class="flex items-center gap-2 py-1 font-mono text-xs text-muted">
					<span class="overflow-hidden text-ellipsis whitespace-nowrap">{inv.paste.slice(0, 40)}…</span>
					<span class="text-faint">expires {fmtWhen(inv.expires_at)}</span>
					<form method="POST" action="?/revokeInvite" use:enhance>
						<input type="hidden" name="token" value={inv.token} />
						<button class="text-error/80 hover:text-error">revoke</button>
					</form>
				</div>
			{/each}
		</div>
	{/if}

	{#if data.sharerLinks.length === 0}
		<p class="font-mono text-xs text-faint">
			No peers consume from this server yet. Create an invite and paste it into the other server's
			federation page.
		</p>
	{/if}

	{#each data.sharerLinks as link (link.id)}
		<div class="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
			{@render peerName(link)}
			<span class="font-mono text-xs text-faint">
				{link.sharedLibraries} librar{link.sharedLibraries === 1 ? 'y' : 'ies'} + {link.sharedChannels}
				channel{link.sharedChannels === 1 ? '' : 's'} shared · last seen {fmtWhen(link.lastSeenAt)}
			</span>
			<span
				class="font-mono text-xs {link.streamingNow > 0 ? 'text-sky-300' : 'text-faint'}"
				title="Concurrent streams right now · plays ≈ playback starts · volume is a served-bytes estimate"
			>
				▶ {link.streamingNow}{link.maxStreams ? `/${link.maxStreams}` : ''} now · today
				{link.stats.todayMints} plays ~{fmtBytes(link.stats.todayBytes)} · 30d {link.stats.d30Mints}
				plays ~{fmtBytes(link.stats.d30Bytes)}
			</span>
			<form method="POST" action="?/setStreamCap" use:enhance class="inline-flex items-center gap-1">
				<input type="hidden" name="linkId" value={link.id} />
				<label class="font-mono text-[11px] text-faint" title="Max simultaneous streams this peer's viewers may pull (blank or 0 = unlimited). New streams over the cap are refused; anyone already watching is never cut.">
					cap
					<input
						name="cap"
						type="number"
						min="0"
						max="999"
						value={link.maxStreams || ''}
						placeholder="∞"
						class="w-14 rounded-md border border-line bg-base-200 px-1.5 py-0.5 text-center font-mono text-xs focus:border-primary/70 focus:outline-none"
					/>
				</label>
				<button class="font-mono text-xs text-muted hover:text-base-content">set</button>
			</form>
			<a href="/admin/visibility" class="font-mono text-xs text-primary hover:underline"
				>choose what to share →</a
			>
			<form
				method="POST"
				action="?/unlinkSharer"
				use:enhance
				onsubmit={(e) => {
					if (!confirm(`Stop sharing with ${link.peerName}? Their mirrored copy stops syncing.`)) e.preventDefault();
				}}
				class="ml-auto"
			>
				<input type="hidden" name="linkId" value={link.id} />
				<button class="font-mono text-xs text-error/80 hover:text-error">unlink</button>
			</form>
		</div>
	{/each}
</section>

<!-- ============================== Consuming from peers ============================== -->
<section class="rounded-xl border border-line p-4">
	<div class="mb-3 flex items-baseline gap-3">
		<h2 class="font-bold">Consuming from peers</h2>
		<span class="font-mono text-xs text-faint">{data.consumerLinks.length} linked{data.syncing ? ' · syncing…' : ''}</span>
		<form method="POST" action="?/setSyncMin" use:enhance class="ml-auto inline-flex items-center gap-1">
			<label
				class="font-mono text-[11px] text-faint"
				title="How often mirrored catalogs refresh from the peers (minutes; 0 = only when you press sync now; 1–4 clamp to 5). Applies immediately — no restart."
			>
				auto-sync every
				<input
					name="minutes"
					type="number"
					min="0"
					max="10080"
					value={data.syncMinutes}
					class="w-16 rounded-md border border-line bg-base-200 px-1.5 py-0.5 text-center font-mono text-xs focus:border-primary/70 focus:outline-none"
				/>
				min
			</label>
			<button class="font-mono text-xs text-muted hover:text-base-content">set</button>
		</form>
	</div>

	<form method="POST" action="?/pair" use:enhance class="mb-4 rounded-lg border border-dashed border-line p-3">
		<div class="mb-2 text-xs text-muted">Paste an invite from the other owner:</div>
		<input
			name="paste"
			placeholder="mytview-fed:1:…"
			class="mb-2 w-full rounded-md border border-line bg-base-200 px-2 py-1.5 font-mono text-xs focus:border-primary/70 focus:outline-none"
		/>
		<div class="mb-2 flex flex-wrap gap-2">
			<input
				name="peerName"
				placeholder="Their name (e.g. Bob)"
				class="rounded-md border border-line bg-base-200 px-2 py-1.5 text-xs focus:border-primary/70 focus:outline-none"
			/>
			<input
				name="myName"
				placeholder="Name they see (e.g. Fabrizio)"
				class="rounded-md border border-line bg-base-200 px-2 py-1.5 text-xs focus:border-primary/70 focus:outline-none"
			/>
			<button class="rounded-md border border-primary/60 px-3 py-1 text-xs text-primary">pair</button>
		</div>
		{#if form && 'paired' in form && form.paired}
			<div class="text-xs text-success">Paired with {form.paired} — first sync is running.</div>
		{/if}
	</form>

	{#each data.consumerLinks as link (link.id)}
		<div class="mt-2 rounded-lg border border-line p-3">
			<div class="flex flex-wrap items-baseline gap-2">
				{@render peerName(link)}
				<span class="font-mono text-xs text-faint">{link.baseUrl}</span>
				<span class="ml-auto font-mono text-xs {link.lastSyncError ? 'text-error' : 'text-faint'}">
					{link.lastSyncError ?? `synced ${fmtWhen(link.lastSeenAt)}`}
				</span>
			</div>
			<table class="mt-2 w-full text-sm">
				<tbody>
					{#each link.remoteLibraries as rl (rl.id)}
						{@const mapping = link.mappings.find((m) => m.remote_library_id === rl.id)}
						<tr class="border-t border-line/60">
							<td class="py-1.5">{rl.name} <span class="font-mono text-[11px] text-faint">{rl.format}</span></td>
							<td class="py-1.5 text-right">
								{#if mapping}
									<span class="font-mono text-xs text-muted"
										>→ {libName(mapping.local_library_id)}</span
									>
									<form method="POST" action="?/unmapLibrary" use:enhance class="inline"
										onsubmit={(e) => {
											if (!confirm(`Unmap ${rl.name}? Its mirrored items are removed (your watch history is kept).`)) e.preventDefault();
										}}
									>
										<input type="hidden" name="linkId" value={link.id} />
										<input type="hidden" name="remoteLibraryId" value={rl.id} />
										<button class="ml-2 font-mono text-xs text-error/80 hover:text-error">unmap</button>
									</form>
								{:else}
									<form method="POST" action="?/mapLibrary" use:enhance class="inline-flex items-center gap-2">
										<input type="hidden" name="linkId" value={link.id} />
										<input type="hidden" name="remoteLibraryId" value={rl.id} />
										<select
											name="target"
											class="rounded-md border border-line bg-base-200 px-2 py-1 text-xs focus:border-primary/70 focus:outline-none"
										>
											<option value="new">+ new library “{rl.name}”</option>
											{#each targetsFor(rl.format) as t (t.id)}
												<option value={t.id}>merge into “{t.name}”{t.virtual ? ' (federated)' : ''}</option>
											{/each}
										</select>
										<button class="rounded-md border border-primary/60 px-2 py-1 text-xs text-primary">map</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
					{#if link.remoteLibraries.length === 0}
						<tr><td class="py-1.5 font-mono text-xs text-faint">Nothing shared to us yet (or not synced yet).</td></tr>
					{/if}
				</tbody>
			</table>
			<div class="mt-2 flex gap-4">
				<form method="POST" action="?/syncNow" use:enhance>
					<input type="hidden" name="linkId" value={link.id} />
					<button class="font-mono text-xs text-muted hover:text-base-content">sync now</button>
				</form>
				<form
					method="POST"
					action="?/unlinkConsumer"
					use:enhance
					onsubmit={(e) => {
						if (!confirm(`Unlink ${link.peerName}? All their mirrored items are removed (your watch history is kept and revives on re-pair).`)) e.preventDefault();
					}}
				>
					<input type="hidden" name="linkId" value={link.id} />
					<button class="font-mono text-xs text-error/80 hover:text-error">unlink</button>
				</form>
			</div>
		</div>
	{/each}
</section>
