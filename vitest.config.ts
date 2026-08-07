import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Unit tests import server modules directly, without the SvelteKit plugin: `$lib` maps to src/lib
 * and `$env/dynamic/private` to a process.env shim, so a test can set env vars and then
 * dynamically import config.ts (which reads env once at import). Forked per-file isolation keeps
 * the better-sqlite3 singletons (db/state connections) scoped to each test file's temp dirs.
 */
export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		pool: 'forks'
	},
	resolve: {
		alias: {
			'$env/dynamic/private': path.resolve(import.meta.dirname, 'tests/env-shim.ts'),
			$lib: path.resolve(import.meta.dirname, 'src/lib')
		}
	}
});
