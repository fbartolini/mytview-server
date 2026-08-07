#!/usr/bin/env node
/**
 * Break-glass password reset — the escape hatch for OWNER LOCKOUT.
 *
 * We track no email, so a forgotten owner password can't be reset from the UI (the owner is the one
 * account no other owner can reset). This sets any user's password directly against state.db from a
 * shell on the server. It also clears `deactivated_at`, so it doubles as "un-suspend + reset".
 *
 * Usage (run where /data is mounted — e.g. `docker compose exec app`):
 *   node scripts/set-password.mjs <username>              # prompts for the new password
 *   MYT_NEW_PASSWORD=… node scripts/set-password.mjs <username>   # non-interactive
 *   STATE_DB=/data/state.db node scripts/set-password.mjs <username>   # explicit db path
 *
 * The hash format is IDENTICAL to auth.ts hashPassword (`saltHex:keyHex`, scrypt→64 bytes); keep them
 * in sync if that ever changes. Runs fine while the server is up (SQLite WAL allows a concurrent write).
 */
import Database from 'better-sqlite3';
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';

// ⇔ auth.ts hashPassword — MUST match, or the produced hash won't verify at login.
function hashPassword(pw) {
	const salt = randomBytes(16);
	const key = scryptSync(pw, salt, 64);
	return `${salt.toString('hex')}:${key.toString('hex')}`;
}

function resolveStatePath() {
	if (process.env.STATE_DB) return process.env.STATE_DB;
	const dbPath = path.resolve(process.env.DB_PATH ?? 'index.db'); // mirrors config.ts DB_PATH
	const derived = path.join(path.dirname(dbPath), 'state.db'); // mirrors state.ts STATE_PATH
	if (fs.existsSync(derived)) return derived;
	if (fs.existsSync('/data/state.db')) return '/data/state.db'; // container default
	return derived;
}

async function readPassword(username) {
	if (process.env.MYT_NEW_PASSWORD) return process.env.MYT_NEW_PASSWORD;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const pw = await new Promise((res) => rl.question(`New password for ${username}: `, res));
	rl.close();
	return pw;
}

const username = process.argv[2];
if (!username) {
	console.error('usage: node scripts/set-password.mjs <username>   (STATE_DB=/path/state.db to override)');
	process.exit(1);
}

const statePath = resolveStatePath();
if (!fs.existsSync(statePath)) {
	console.error(`state.db not found at ${statePath} — set STATE_DB or DB_PATH.`);
	process.exit(2);
}
const db = new Database(statePath);
const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!row) {
	console.error(`No user "${username}" in ${statePath}.`);
	process.exit(2);
}

const pw = (await readPassword(username)).trim();
if (pw.length < 6) {
	console.error('Password must be at least 6 characters.');
	process.exit(3);
}
db.prepare('UPDATE users SET password_hash = ?, deactivated_at = NULL WHERE id = ?').run(
	hashPassword(pw),
	row.id
);
console.log(`Password updated for "${username}". Sign in with the new password.`);
