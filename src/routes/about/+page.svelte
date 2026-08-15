<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	const card = 'rounded-xl border border-line bg-base-200 p-5';
</script>

<svelte:head><title>About · MytView</title></svelte:head>

<a href="/" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</a>

<div class="max-w-xl">
	<h1 class="text-xl font-bold tracking-tight">About MytView</h1>
	<p class="mt-1 font-mono text-xs text-muted">server {data.version}</p>

	<div class="{card} mt-5">
		<p class="text-[13px] leading-relaxed text-muted">
			MytView is a viewer for a self-hosted video library — it plays what's on
			<span class="text-base-content">your</span> server and nothing else. No cloud, no analytics,
			no ads, and it never modifies your files.
		</p>
		<p class="mt-3 text-[13px] leading-relaxed text-muted">
			If it's useful to you, you can
			<a
				href="https://buymeacoffee.com/fbartolini"
				target="_blank"
				rel="noopener"
				class="text-primary underline">buy me a coffee</a
			> — entirely optional, and it unlocks nothing: the software is the same either way.
		</p>
		<p class="mt-3 font-mono text-xs text-faint">
			The server and this web app are free and open source (GPL-3) ·
			<a href="https://mytview.com" target="_blank" rel="noopener" class="text-muted underline hover:text-base-content">mytview.com</a>
			·
			<a
				href="https://github.com/fbartolini/mytview-server"
				target="_blank"
				rel="noopener"
				class="text-muted underline hover:text-base-content">source</a
			>
		</p>
	</div>

	<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
		Apps for your devices
	</h2>
	<div class={card}>
		<p class="text-[13px] leading-relaxed text-muted">
			Native apps connect to this same server — with offline-friendly navigation, background audio,
			and proper TV remotes. They're in beta right now, and
			<span class="text-base-content">anything installed before 1 November 2026 stays free forever</span>.
		</p>
		<ul class="mt-3 space-y-1.5 font-mono text-xs">
			<li>
				<span class="text-muted">iPhone · iPad · Apple TV</span> —
				<a
					href="https://testflight.apple.com/join/CsBAkfb9"
					target="_blank"
					rel="noopener"
					class="text-primary underline">join the beta</a
				>
			</li>
			<li><span class="text-muted">Google TV · Android</span> <span class="text-faint">— beta opening shortly</span></li>
			<li><span class="text-muted">Samsung TV</span> <span class="text-faint">— free, coming to the Samsung store</span></li>
		</ul>
	</div>
</div>
