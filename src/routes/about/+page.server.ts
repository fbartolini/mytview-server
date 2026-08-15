import { SERVER_VERSION } from '$lib/server/config';
import type { PageServerLoad } from './$types';

/** About page — the ONE place the project introduces itself to every web user (not just the owner,
 *  who is the only person a GitHub link would ever reach). It is a destination, never a banner:
 *  nobody is nagged, so there is nothing to dismiss and no need to detect who has contributed.
 *  Doubles as app discovery — household members on the web player learn the native apps exist. */
export const load: PageServerLoad = () => ({ version: SERVER_VERSION });
