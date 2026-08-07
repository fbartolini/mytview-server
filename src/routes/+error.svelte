<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="rounded-xl border border-dashed border-line p-12 text-center font-mono text-sm text-muted">
	<div class="text-4xl font-bold text-faint">{page.status}</div>
	<div class="mt-3">{page.error?.message ?? 'Something went wrong'}</div>
	<a href="/" class="mt-5 inline-block text-primary">← back to Recent</a>
</div>
