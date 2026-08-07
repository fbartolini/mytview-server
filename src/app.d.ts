// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: import('$lib/server/auth').User | null;
			/** The raw token that authenticated this request (cookie or bearer) — for naming/revoking
			 *  the current session. Undefined on unauthenticated requests. */
			sessionToken?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
