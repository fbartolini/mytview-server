import { json } from '@sveltejs/kit';
import { listChannels } from '$lib/server/queries';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => json(listChannels(locals.user));
