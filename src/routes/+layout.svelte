<script lang="ts">
	import '../app.css';
	import { onMount, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Search box: mirrors ?q on the Recent page; debounced; drives navigation.
	let q = $state(page.url.pathname === '/' ? (page.url.searchParams.get('q') ?? '') : '');
	let searchEl = $state<HTMLInputElement>();
	let searchTimer: ReturnType<typeof setTimeout>;
	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			const v = q.trim();
			goto(v ? `/?q=${encodeURIComponent(v)}` : '/', { keepFocus: true });
		}, 220);
	}
	$effect(() => {
		const urlQ = page.url.pathname === '/' ? (page.url.searchParams.get('q') ?? '') : '';
		// NEVER clobber the box while the user is typing: our own debounced goto changes page.url
		// mid-word, and rebinding from the (one-keystroke-older) URL here is what "ate" characters
		// during fast typing. Sync from the URL only when the input isn't focused — i.e. on real
		// navigation (back/forward, a link, landing on /?q=…).
		if (document.activeElement !== searchEl) q = urlQ;
	});

	const path = $derived(page.url.pathname);
	const recentActive = $derived(path === '/');
	const channelsActive = $derived(path === '/channels' || path.startsWith('/channel/'));
	// Per-library nav: the ?library id currently shown (string form, for cheap comparison), or null.
	const currentLib = $derived(path === '/channels' ? page.url.searchParams.get('library') : null);

	// Avatar monogram: initials from the username (up to two word-parts), fallback "?".
	const initials = $derived(
		(data.user?.username ?? '')
			.split(/[\s._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((s) => s[0])
			.join('')
			.toUpperCase() || '?'
	);

	// Account/actions dropdown — closes on navigation.
	let menuOpen = $state(false);
	$effect(() => {
		page.url.pathname;
		menuOpen = false;
	});

	let scanning = $state(false);
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout>;
	function flash(msg: string) {
		toast = msg;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 3200);
	}
	async function rescan(full = false) {
		if (scanning) return;
		scanning = true;
		try {
			const r = await fetch(full ? '/api/scan?full=1' : '/api/scan', { method: 'POST' });
			if (!r.ok) throw new Error();
			const s = await r.json();
			flash(`Indexed ${s.videos} videos · ${s.channels} channels · ${s.elapsed_s}s`);
			await invalidateAll();
		} catch {
			flash('Scan failed');
		} finally {
			scanning = false;
		}
	}

	// Syncing indicator: reflects manual rescans AND server-side scans (startup / the
	// 5-min auto-rescan) via a light status poll, so mobile gets a cue too.
	let serverScanning = $state(false);
	const syncing = $derived(scanning || serverScanning);
	async function pollStatus() {
		if (!data.user) return; // logged out (e.g. on /login) → nothing to poll, and avoids a redirect loop
		try {
			const r = await fetch('/api/status');
			if (r.status === 401) {
				// Session ended (revoked, or the server lost it) → bounce to sign-in, returning here. Catches
				// an expired session app-wide within one poll instead of a silent 401 until the next navigation.
				goto(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
				return;
			}
			if (r.ok) serverScanning = (await r.json()).scanning;
		} catch {
			/* ignore */
		}
	}
	onMount(() => {
		pollStatus();
		const iv = setInterval(pollStatus, 8000);
		return () => clearInterval(iv);
	});

	// Pull-to-refresh (mobile): drag down at the top of the page to rescan.
	let pull = $state(0);
	let startY = 0;
	let pulling = false;
	function onTouchStart(e: TouchEvent) {
		if (data.user && !scanning && window.scrollY <= 0) {
			startY = e.touches[0].clientY;
			pulling = true;
		}
	}
	function onTouchMove(e: TouchEvent) {
		if (!pulling) return;
		const dy = e.touches[0].clientY - startY;
		pull = dy > 0 && window.scrollY <= 0 ? Math.min(dy * 0.5, 80) : 0;
	}
	function onTouchEnd() {
		if (!pulling) return;
		pulling = false;
		const go = pull > 55;
		pull = 0;
		if (go) rescan();
	}
</script>

<svelte:window
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	onkeydown={(e) => {
		// `/` focuses the filter box from anywhere (Esc clears it and drops focus) — power-tool
		// affordance for the keyboard-first crowd; inert while typing in any field.
		const t = e.target as HTMLElement | null;
		const typing =
			!!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
		if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault();
			searchEl?.focus();
			searchEl?.select();
		} else if (e.key === 'Escape' && t === searchEl) {
			q = '';
			onSearch();
			searchEl?.blur();
		}
	}}
/>

{#if data.user}
	<!-- Pull-to-refresh feedback ONLY (mobile, while dragging). An active scan is shown by the
	     spinning ring on the avatar instead — the old centered "syncing…" pill sat on top of the
	     search input on desktop. -->
	{#if pull > 0}
		<div
			class="pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-center pt-[env(safe-area-inset-top)]"
			style="transform: translateY({pull - 10}px)"
		>
			<div class="mt-2 rounded-full border border-line bg-base-300 px-3 py-1 font-mono text-[11px] text-muted shadow-lg">
				<span class="inline-block">⟳</span>
				{pull > 55 ? 'release to rescan' : 'pull to rescan'}
			</div>
		</div>
	{/if}

	{#snippet menulink(href: string, label: string)}
		<a
			href={href}
			role="menuitem"
			class="block px-3.5 py-2 font-mono text-xs text-muted hover:bg-base-300 hover:text-base-content"
			>{label}</a
		>
	{/snippet}

	<header
		class="sticky top-0 z-20 flex min-h-14 items-center gap-2 border-b border-line bg-base-100/90 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-md sm:gap-4 sm:px-[22px]"
	>
		<a href="/" class="shrink-0">
			<img src="/logo.png" alt="MytView" class="h-7 w-auto" />
		</a>

		<nav class="flex shrink-0 gap-0.5 sm:gap-1">
			<a
				href="/"
				class="rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors hover:bg-base-200 sm:px-3 {recentActive
					? 'text-base-content'
					: 'text-muted'}">Recent</a
			>
			{#if data.libraries.length > 0}
				<!-- One tab per configured library → /channels?library=<id>. Names are usually lowercase
				     ("shows"), so capitalize for a tidy tab without mutating the stored name. -->
				{#each data.libraries as lib (lib.id)}
					<a
						href="/channels?library={lib.id}"
						class="rounded-md px-2 py-1.5 text-[13px] font-medium capitalize transition-colors hover:bg-base-200 sm:px-3 {currentLib ===
						String(lib.id)
							? 'text-base-content'
							: 'text-muted'}">{lib.name}</a
					>
				{/each}
			{:else}
				<a
					href="/channels"
					class="rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors hover:bg-base-200 sm:px-3 {channelsActive
						? 'text-base-content'
						: 'text-muted'}">Library</a
				>
			{/if}
		</nav>

		<input
			bind:this={searchEl}
			bind:value={q}
			oninput={onSearch}
			type="search"
			placeholder="filter titles"
			autocomplete="off"
			spellcheck="false"
			class="mr-auto min-w-0 flex-1 rounded-lg border border-line bg-base-200 px-3 py-2 font-mono text-[12.5px] outline-none transition-[width,border-color] duration-200 placeholder:text-faint focus:border-primary/50 lg:w-[280px] lg:flex-none lg:focus:w-[320px]"
		/>

		<!-- Everything else (account, admin, rescan, sign out) folds into this avatar menu. -->
		<button
			onclick={() => (menuOpen = !menuOpen)}
			aria-label="Account menu"
			aria-haspopup="menu"
			aria-expanded={menuOpen}
			title={syncing ? 'Scanning library…' : undefined}
			class="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-base-200 font-mono text-xs font-semibold text-base-content transition-colors hover:border-primary/60 {menuOpen
				? 'border-primary/60'
				: 'border-line'}"
		>
			{#if syncing}
				<!-- Scan-in-progress: a spinning amber arc AROUND the avatar — unmissable but takes no
				     space; the initials stay visible underneath (the tiny inline ⟳ was too easy to miss). -->
				<span
					class="absolute -inset-[3px] animate-spin rounded-full border-2 border-transparent border-t-primary border-r-primary/40"
					aria-hidden="true"
				></span>
			{/if}
			{initials}
		</button>
	</header>

	{#if menuOpen}
		<!-- Click-away backdrop + panel rendered OUTSIDE the header: the header's backdrop-blur creates a
		     containing block + stacking context, which would trap a fixed backdrop and mis-layer the panel. -->
		<button
			aria-label="Close menu"
			tabindex="-1"
			class="fixed inset-0 z-30 cursor-default"
			onclick={() => (menuOpen = false)}
		></button>
		<div
			role="menu"
			class="fixed top-[calc(3.25rem_+_env(safe-area-inset-top))] right-3 z-40 w-56 overflow-hidden rounded-xl border border-line bg-base-200 py-1 shadow-2xl sm:right-5"
		>
			<div class="px-3.5 py-2">
				<div class="truncate text-sm font-semibold">{data.user.username}</div>
				<div class="font-mono text-[11px] text-faint">{data.isOwner ? 'owner' : 'signed in'}</div>
			</div>
			<div class="border-t border-line-soft"></div>

			{@render menulink('/account', 'Account')}
			{@render menulink('/shares', 'Share links')}
			{@render menulink('/sessions', 'Devices')}
			{#if data.canInvite}{@render menulink('/invite', 'Invite someone')}{/if}
			{#if data.isOwner}{@render menulink('/admin/libraries', 'Libraries')}{/if}
			{#if data.isOwner}{@render menulink('/admin/visibility', 'Channel visibility')}{/if}
			{#if data.isOwner}{@render menulink('/admin/users', 'Users')}{/if}

			<div class="border-t border-line-soft"></div>
			<button
				role="menuitem"
				onclick={() => {
					menuOpen = false;
					rescan();
				}}
				disabled={scanning}
				class="block w-full px-3.5 py-2 text-left font-mono text-xs text-muted hover:bg-base-300 hover:text-base-content disabled:opacity-50"
				>{scanning ? 'Scanning…' : 'Rescan library'}</button
			>
			{#if data.isOwner}
				<button
					role="menuitem"
					onclick={() => {
						menuOpen = false;
						rescan(true);
					}}
					disabled={scanning}
					title="Re-parse every video (ignores mtime) — fixes stale thumbnails or metadata. Slower."
					class="block w-full px-3.5 py-2 text-left font-mono text-xs text-muted hover:bg-base-300 hover:text-base-content disabled:opacity-50"
					>{scanning ? 'Scanning…' : 'Full rescan'}</button
				>
			{/if}

			<div class="border-t border-line-soft"></div>
			<form method="POST" action="/logout">
				<button
					role="menuitem"
					class="block w-full px-3.5 py-2 text-left font-mono text-xs text-muted hover:bg-base-300 hover:text-base-content"
					>Sign out</button
				>
			</form>
		</div>
	{/if}

	<main class="wrap">
		{@render children()}
	</main>

	{#if toast}
		<div
			class="fixed bottom-[calc(1.5rem_+_env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-base-300 px-4 py-2.5 font-mono text-[12.5px] shadow-2xl"
		>
			{toast}
		</div>
	{/if}
{:else}
	{@render children()}
{/if}
