<script lang="ts">
	import { fmtDuration, fmtEpisode } from '$lib/format';
	import type { VideoSummary } from '$lib/types';

	// Items come from the page's SSR load (indexed query, ~0.2ms), so no client fetch/flash.
	//  - variant 'list' = the desktop sidebar (thumbnail left, title right, boxed).
	//  - variant 'grid' = mobile, right under the video (2-up cards, thumbnail on top).
	let { items, variant = 'list' }: { items: VideoSummary[]; variant?: 'list' | 'grid' } = $props();

	// Series episodes lead the meta line with their SxE label (the rail is next-episodes for a show).
	const ep = (v: VideoSummary) => fmtEpisode(v.season_number, v.episode_number);
</script>

{#if items.length}
	{#if variant === 'grid'}
		<section>
			<h2 class="mb-2.5 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase">
				Related
			</h2>
			<div class="grid grid-cols-2 gap-3">
				{#each items as v (v.id)}
					<a href="/video/{encodeURIComponent(v.id)}" class="group block">
						<div class="relative aspect-video overflow-hidden rounded-lg bg-base-300">
							{#if v.thumb_path}
								<img
									loading="lazy"
									src="/thumb/{encodeURIComponent(v.id)}"
									alt=""
									class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
								/>
							{/if}
							{#if v.duration}
								<span
									class="absolute right-1 bottom-1 rounded bg-black/80 px-1 font-mono text-[9px] leading-tight text-neutral-100"
									>{fmtDuration(v.duration)}</span
								>
							{/if}
						</div>
						<div class="mt-1.5 line-clamp-2 text-xs leading-snug font-medium">{v.title}</div>
						<div class="mt-0.5 truncate font-mono text-[10px] text-muted">
							{#if ep(v)}<span class="text-base-content">{ep(v)}</span> · {/if}{v.channel_name}
						</div>
					</a>
				{/each}
			</div>
		</section>
	{:else}
		<div class="overflow-hidden rounded-xl border border-line bg-base-200">
			<h2
				class="border-b border-line px-3.5 py-3 font-mono text-[11px] font-semibold tracking-widest text-faint uppercase"
			>
				Related
			</h2>
			{#each items as v (v.id)}
				<a
					href="/video/{encodeURIComponent(v.id)}"
					class="flex gap-2.5 border-b border-line-soft p-2.5 last:border-b-0 hover:bg-base-300"
				>
					<div class="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-base-300">
						{#if v.thumb_path}
							<img
								loading="lazy"
								src="/thumb/{encodeURIComponent(v.id)}"
								alt=""
								class="h-full w-full object-cover"
							/>
						{/if}
						{#if v.duration}
							<span
								class="absolute right-0.5 bottom-0.5 rounded bg-black/80 px-1 font-mono text-[9px] leading-tight text-neutral-100"
								>{fmtDuration(v.duration)}</span
							>
						{/if}
					</div>
					<div class="min-w-0">
						<div class="line-clamp-2 text-xs leading-snug font-medium">{v.title}</div>
						<div class="mt-1 truncate font-mono text-[10px] text-muted">
							{#if ep(v)}<span class="text-base-content">{ep(v)}</span> · {/if}{v.channel_name}
						</div>
					</div>
				</a>
			{/each}
		</div>
	{/if}
{/if}
