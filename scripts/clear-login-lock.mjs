#!/usr/bin/env node
// Lifts the password sign-in lock of Agent Cloud Studio (docs/security.md) on this machine.
//
//   node scripts/clear-login-lock.mjs              # clears every lock and failure count
//   node scripts/clear-login-lock.mjs <username>   # clears one typed username only
//
// It needs no running server and no password: whoever can run it already controls this machine.
// The database is DATABASE_PATH (from the environment, else from the app's .env), else
// ~/.cloudcli/auth.db, the same lookup the server uses. The running server reads the lock from the
// database on every attempt, so the change applies at once; the in-memory per-client throttle
// (5 wrong passwords per address per 10 minutes) is not stored and simply runs out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function databasePathFromEnvFile() {
  try {
    for (const line of fs.readFileSync(path.join(appRoot, '.env'), 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('DATABASE_PATH=')) continue;
      const value = trimmed.slice('DATABASE_PATH='.length).trim();
      if (value) return value;
    }
  } catch {
    // No .env: fall through to the default.
  }
  return null;
}

const databasePath = process.env.DATABASE_PATH
  || databasePathFromEnvFile()
  || path.join(os.homedir(), '.cloudcli', 'auth.db');
const username = process.argv[2];

if (!fs.existsSync(databasePath)) {
  console.error(`No Studio database at ${databasePath}`);
  process.exit(1);
}

const db = new Database(databasePath);
db.pragma('busy_timeout = 5000');
const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_login_lockouts'").get();
if (!hasTable) {
  console.log('Nothing to clear: this database has never recorded a password lock.');
  process.exit(0);
}

const removed = username
  ? db.prepare('DELETE FROM auth_login_lockouts WHERE account_key = ?').run(username).changes
  : db.prepare('DELETE FROM auth_login_lockouts').run().changes;
const hasEvents = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_security_events'").get();
if (hasEvents && removed > 0) {
  db.prepare('INSERT INTO auth_security_events (at, type, door, client, detail) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'lockout-cleared', 'direct', 'unknown', 'command line');
}
db.close();
console.log(removed > 0
  ? `Password sign-in unlocked (${removed} record${removed === 1 ? '' : 's'} cleared in ${databasePath}).`
  : 'No lock or failure count was recorded.');
