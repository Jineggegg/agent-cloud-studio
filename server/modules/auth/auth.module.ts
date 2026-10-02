import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';

import { getConnection, userDb } from '@/modules/database/index.js';
import { readCloudflareAccessConfig, readStudioIngressOrigins } from '@/shared/utils.js';

import { createAccountLockout } from './account-lockout.service.js';
import { createAccountSecurityService } from './account-security.service.js';
import { getAuthSecurityStore } from './auth-security.store.js';
import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createCloudflareAccessGate, createCloudflareAccessMiddleware } from './cloudflare-access.service.js';
import { createHandoffCodeStore } from './handoff.service.js';
import { createPasskeyCeremonies } from './passkey-signin.service.js';
import { createSecurityEventLog } from './security-events.service.js';
import { parseTailscaleSignInConfig } from './tailscale-session.service.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const databaseConnection = getConnection();
// Lockouts, sign-in passkeys, the security event log and token versions (auth-security.store).
const securityStore = getAuthSecurityStore();
const ingressOrigins = () => readStudioIngressOrigins(process.env);

const accountLockout = createAccountLockout({
  store: securityStore.lockouts,
  // Rows of real accounts are never evicted to make room for made-up usernames.
  isAccount: (accountKey) => userDb.getUserByUsername(accountKey) !== undefined,
});
const securityEvents = createSecurityEventLog({ store: securityStore.events });
// Sign-in passkeys work only on the two configured front doors (STUDIO_PUBLIC_ORIGIN and
// STUDIO_TAILNET_ORIGIN), read per request like the other door settings.
const passkeys = createPasskeyCeremonies({ store: securityStore.passkeys, origins: ingressOrigins });
// Switching between the two front doors (docs/network.md); codes live in this process only.
const handoffCodes = createHandoffCodeStore();
const sessionsRevokedListeners = new Set<(userId: number) => void>();

const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash) => userDb.createUser(username, passwordHash),
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
    countActiveUsers: () => userDb.countActiveUsers(),
    getFirstUser: () => userDb.getFirstUser(),
  },
  transaction: {
    begin: () => databaseConnection.prepare('BEGIN').run(),
    commit: () => databaseConnection.prepare('COMMIT').run(),
    rollback: () => databaseConnection.prepare('ROLLBACK').run(),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  // STUDIO_TAILSCALE_LOGINS enables passwordless sign-in through Tailscale Serve;
  // STUDIO_TAILSCALE_NODES and STUDIO_TAILSCALE_USER refine it, and STUDIO_TAILNET_ORIGIN (or,
  // when that is unset, STUDIO_PUBLIC_ORIGIN) pins the only origin it accepts.
  // process.env is filled from .env once at startup, so .env edits apply after a restart.
  tailscaleSignIn: () => parseTailscaleSignInConfig(process.env),
  handoffCodes,
  ingressOrigins,
  logInfo: (message) => console.info(message),
  accountLockout,
  securityEvents,
  passkeys,
  findUserById: (userId) => userDb.getUserById(userId),
});

const accountSecurity = createAccountSecurityService({
  verifyStepUpPassword: authService.verifyStepUpPassword,
  passkeys,
  events: securityEvents,
  lockout: accountLockout,
  sessionVersions: securityStore.sessionVersions,
  onSessionsRevoked: (userId) => {
    handoffCodes.discardForUser(userId);
    for (const listener of sessionsRevokedListeners) {
      try {
        listener(userId);
      } catch (error) {
        console.warn('[auth] A sessions-revoked listener failed:', error instanceof Error ? error.message : String(error));
      }
    }
  },
  logInfo: (message) => console.info(message),
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken, accountSecurity);

/**
 * Used by the server entrypoint to close a user's live WebSockets (websocket module) once
 * "退出所有设备" revoked their tokens; the tokens themselves are refused from then on anyway.
 */
export function onSessionsRevoked(listener: (userId: number) => void): () => void {
  sessionsRevokedListeners.add(listener);
  return () => sessionsRevokedListeners.delete(listener);
}

// STUDIO_CF_ACCESS_TEAM_DOMAIN + STUDIO_CF_ACCESS_AUD turn on Studio's own check of Cloudflare
// Access for requests through the public tunnel door (docs/network.md); read per request like the
// other settings, so it applies after a restart once .env changes.
const cloudflareAccess = createCloudflareAccessGate({
  config: () => readCloudflareAccessConfig(process.env),
});

/**
 * Used by the server entrypoint before every route (static files included): a request through
 * Cloudflare without a valid Cloudflare Access assertion gets 403 while the check is configured.
 */
export const requireCloudflareAccess = createCloudflareAccessMiddleware(cloudflareAccess);

/**
 * Used by the server entrypoint for WebSocket upgrades, which bypass Express: resolves false for
 * an upgrade through Cloudflare without a valid Cloudflare Access assertion.
 */
export async function admitCloudflareAccessUpgrade(request: IncomingMessage): Promise<boolean> {
  const decision = await cloudflareAccess.check({ headers: request.headers, method: request.method ?? 'GET', path: request.url ?? '/' });
  return decision.allowed;
}
