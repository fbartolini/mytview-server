import adapter from '@sveltejs/adapter-node';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode across the project (except node_modules).
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// adapter-node: produces a standalone Node server for the Docker image.
			adapter: adapter(),
			// LAN tool accessed by IP: disable the Origin-based CSRF check so login/signup
			// work without a per-deployment ORIGIN that must match the access URL exactly.
			// The only form POSTs are auth; the library is read-only. Cookie stays httpOnly.
			// `trustedOrigins: ['*']` is the successor to the deprecated `checkOrigin: false`
			// and is EXACTLY equivalent — Kit computes the check as
			// `checkOrigin && !trustedOrigins.includes('*')`. A narrower allow-list can't work
			// here: the same deploy is reached at an unknowable set of LAN IPs and hostnames.
			csrf: { trustedOrigins: ['*'] }
		})
	]
});
