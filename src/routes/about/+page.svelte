<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	const card = 'rounded-xl border border-line bg-base-200 p-5';

	// Fixed separators, never toLocaleString(): the server renders these once and the browser hydrates
	// them — a server locale that groups differently to the visitor's would mismatch on every number.
	const n = (v: number) => v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

	/** Total runtime, read as a library size rather than a timestamp ("412 hours", "18 days"). */
	function runtime(sec: number): string {
		const h = Math.round(sec / 3600);
		if (h < 1) return `${Math.round(sec / 60)} min`;
		if (h < 100) return `${h} hour${h === 1 ? '' : 's'}`;
		const d = Math.floor(h / 24);
		return `${n(d)} day${d === 1 ? '' : 's'} of video`;
	}

	function uptime(sec: number): string {
		const d = Math.floor(sec / 86400);
		const h = Math.floor((sec % 86400) / 3600);
		const m = Math.floor((sec % 3600) / 60);
		return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
	}

	const k = $derived(data.content.byKind);
	// Only formats this server actually holds get a line — an empty "0 films" tells nobody anything.
	const holdings = $derived(
		[
			k.channel.channels && { label: k.channel.channels === 1 ? 'channel' : 'channels', count: k.channel.channels, items: `${n(k.channel.videos)} videos` },
			k.series.channels && { label: k.series.channels === 1 ? 'show' : 'shows', count: k.series.channels, items: `${n(k.series.videos)} episodes` },
			k.movies.videos && { label: k.movies.videos === 1 ? 'film' : 'films', count: k.movies.videos, items: null }
		].filter((h) => !!h)
	);

	const hw = $derived(data.playback.hwaccel);
	const features = $derived([
		{
			label: 'Direct play',
			detail: 'Files stream to your device exactly as they are on disk — nothing is converted.',
			state: 'always on',
			on: true
		},
		{
			label: 'Live transcoding',
			detail: data.playback.hls
				? 'When a device can’t decode a file, the server converts it on the fly while you watch. Nothing is stored.'
				: 'Turned off — a device that can’t decode a file will fail to play it.',
			state: data.playback.hls ? 'on' : 'off',
			on: data.playback.hls
		},
		{
			label: 'Hardware acceleration',
			detail:
				hw === 'on'
					? 'Transcoding runs on the GPU, so it costs the server very little.'
					: hw === 'off'
						? 'Transcoding runs on the CPU. A GPU can be enabled on the server if one is available.'
						: 'Requested, but no usable GPU was found — transcoding falls back to the CPU.',
			state: hw === 'on' ? 'GPU' : 'CPU',
			on: hw === 'on'
		},
		{
			label: 'Artwork cache',
			detail: 'Thumbnails and posters are pre-sized, so grids load quickly on phones and TVs.',
			state: data.playback.imageCache ? 'on' : 'off',
			on: data.playback.imageCache
		},
		{
			label: 'Plex sync',
			detail: data.plex.linked
				? `Your account is linked to Plex as ${data.plex.linked} — watched state and resume points stay in step.`
				: data.plex.configured
					? 'This server can sync watched state with Plex. Link your Plex account on the Account page.'
					: 'Not set up on this server.',
			state: data.plex.linked ? 'linked' : data.plex.configured ? 'available' : 'off',
			on: !!data.plex.linked
		}
	]);
</script>

<svelte:head><title>About · MytView</title></svelte:head>

<a href="/" class="mb-4 inline-flex gap-1.5 font-mono text-xs text-muted hover:text-base-content">← back</a>

<div class="max-w-xl">
	<h1 class="text-xl font-bold tracking-tight">About MytView</h1>
	<p class="mt-1 font-mono text-xs text-muted">
		server {data.version}{data.build ? ` · build ${data.build}` : ''}
	</p>

	<div class="{card} mt-5">
		<p class="text-[13px] leading-relaxed text-muted">
			MytView — said <span class="text-base-content">"mighty view"</span>, and its first four
			letters are <span class="text-base-content">MyTV</span> — is a viewer for a self-hosted video
			library. It plays what's on <span class="text-base-content">your</span> server and nothing
			else. No cloud, no analytics, no ads, and it never modifies your files.
		</p>
		<p class="mt-3 text-[13px] leading-relaxed text-muted">
			If it's useful to you, you can buy me a coffee — entirely optional, and it unlocks nothing:
			the software is the same either way.
		</p>
		<!-- Buy Me a Coffee's OWN button is a third-party <script> from their CDN. We render it
		     locally instead (same brand yellow #FFDD00, black text, cup): no outbound request on
		     page view — which would contradict this product's "no cloud, no analytics" promise and
		     hand every visitor's IP to a CDN — and it still renders on a LAN server with no
		     internet access, where the remote script would silently show nothing. -->
		<a
			href="https://buymeacoffee.com/fbartolini"
			target="_blank"
			rel="noopener"
			class="mt-3 inline-flex items-center gap-2 rounded-lg border border-black/10 bg-[#FFDD00] px-4 py-2 text-[15px] font-semibold text-black shadow-sm transition-transform hover:scale-[1.03]"
		>
			<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8">
				<path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" stroke-linejoin="round" />
				<path d="M16 9h2.5a2.5 2.5 0 0 1 0 5H16" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M7 3.5c0 1-.8 1.3-.8 2.2M10.5 3.5c0 1-.8 1.3-.8 2.2M14 3.5c0 1-.8 1.3-.8 2.2" stroke-linecap="round" />
			</svg>
			Buy me a coffee
		</a>
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

	<!-- Content: what YOU can see (visibility-filtered server-side), not what the owner has. -->
	<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
		Your library
	</h2>
	<div class={card}>
		<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1">
			<p class="text-2xl font-bold tracking-tight">{n(data.content.videos)}</p>
			<p class="text-[13px] text-muted">
				items{data.content.seconds ? ` · ${runtime(data.content.seconds)}` : ''}
			</p>
		</div>
		{#if holdings.length}
			<ul class="mt-3 space-y-1 border-t border-line-soft pt-3 font-mono text-xs text-muted">
				{#each holdings as h (h.label)}
					<li>
						<span class="text-base-content">{n(h.count)}</span>
						{h.label}{h.items ? ` · ${h.items}` : ''}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-3 border-t border-line-soft pt-3 text-[13px] text-muted">
				Nothing indexed yet — content appears here once the server has scanned the library.
			</p>
		{/if}
		{#if data.content.federated}
			<p class="mt-3 text-[12px] text-muted">
				Includes <span class="text-base-content">{n(data.content.federated)}</span> items shared by
				another MytView server. They stream straight from that server — nothing is copied here.
			</p>
		{/if}
	</div>

	<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
		How this server plays
	</h2>
	<div class={card}>
		{#each features as f (f.label)}
			<div class="flex items-start justify-between gap-4 border-t border-line-soft py-2.5 first:border-0 first:pt-0 last:pb-0">
				<div>
					<p class="text-[13px] text-base-content">{f.label}</p>
					<p class="text-[12px] leading-relaxed text-muted">{f.detail}</p>
				</div>
				<span class="mt-0.5 shrink-0 font-mono text-[11px] {f.on ? 'text-primary' : 'text-faint'}">
					{f.state}
				</span>
			</div>
		{/each}
	</div>

	<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
		Apps for your devices
	</h2>
	<div class={card}>
		<p class="text-[13px] leading-relaxed text-muted">
			Native apps connect to this same server — with offline-friendly navigation, background audio,
			and proper TV remotes. Stores approve each device class separately, so availability differs
			per platform, and
			<span class="text-base-content">anything installed before 1 November 2026 stays free forever</span>.
		</p>
		<ul class="mt-3 space-y-1.5 font-mono text-xs">
			<li>
				<span class="text-muted">Apple TV</span> —
				<a href="https://apps.apple.com/app/id6790113115" target="_blank" rel="noopener" class="text-primary underline"
					>App Store</a
				>
			</li>
			<li>
				<span class="text-muted">iPhone · iPad</span> —
				<a
					href="https://testflight.apple.com/join/CsBAkfb9"
					target="_blank"
					rel="noopener"
					class="text-primary underline">TestFlight beta</a
				>
				<span class="text-faint">(App Store review in progress)</span>
			</li>
			<li>
				<span class="text-muted">Android phone · tablet</span> —
				<a
					href="https://play.google.com/store/apps/details?id=com.mytview.app"
					target="_blank"
					rel="noopener"
					class="text-primary underline">Google Play</a
				>
				<span class="text-faint">(open beta)</span>
			</li>
			<li><span class="text-muted">Google TV</span> <span class="text-faint">— in store review</span></li>
			<li><span class="text-muted">Samsung TV</span> <span class="text-faint">— free, coming to the Samsung store</span></li>
		</ul>
	</div>

	<!-- Owner-only: the server's SETUP (vs the capabilities above, which describe behaviour every user
	     sees). Deliberately terse + mono — this is the block you screenshot into a bug report. -->
	{#if data.owner}
		<h2 class="mt-8 mb-2 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
			Server details
		</h2>
		<div class="{card} space-y-1 font-mono text-[11px] text-faint">
			<p>
				MytView {data.version}{data.build ? ` · build ${data.build}` : ' · dev build'}{data.builtAt
					? ` · built ${data.builtAt}`
					: ''}
			</p>
			<p>Node {data.owner.node} · {data.owner.platform}</p>
			<p>
				up {uptime(data.owner.uptimeSec)} ·
				{data.owner.libraries} librar{data.owner.libraries === 1 ? 'y' : 'ies'} ·
				sign-up: {data.owner.signup}
			</p>
			<p>
				ffmpeg {data.playback.ffmpeg ?? 'NOT FOUND — no transcoding or artwork resizing'}
				{#if data.playback.ffmpeg}
					· transcoding {data.owner.hlsEncoding}/{data.owner.hlsMax} ·
					GPU {data.owner.hlsDevice ? 'device present' : 'no device'}
					{data.playback.hwaccel === 'unavailable' && data.owner.hlsDevice ? '(failed — using CPU)' : ''}
					{data.playback.hwaccel === 'off' ? '(not enabled)' : ''}
				{/if}
			</p>
			{#if data.owner.peers.sharing || data.owner.peers.consuming}
				<p>
					federation: sharing to {data.owner.peers.sharing} · consuming from {data.owner.peers
						.consuming}
				</p>
			{/if}
			{#if data.owner.lastScan}
				<p>
					last scan: {n(data.owner.lastScan.videos)} videos, {n(data.owner.lastScan.channels)} channels
					in {data.owner.lastScan.elapsed_s}s
				</p>
			{/if}
			<p class="pt-1">
				<a href="/admin" class="text-muted underline hover:text-base-content">Server settings →</a>
			</p>
		</div>
	{/if}
</div>
