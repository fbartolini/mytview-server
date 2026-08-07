/** Test-only stand-in for SvelteKit's `$env/dynamic/private` (aliased in vitest.config.ts).
 *  Reads live process.env, so a test can set vars before dynamically importing server modules. */
export const env: Record<string, string | undefined> = process.env;
