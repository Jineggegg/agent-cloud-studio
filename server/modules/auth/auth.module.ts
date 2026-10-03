import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';

import { getConnection, userDb } from '@/modules/database/index.js';
import type { StudioRequestClient, StudioSessionRevocation } from '@/shared/types.js';
import { readCloudflareAccessConfig, readCloudflaredPort, readStudioIngressOrigins } from '@/shared/utils.js';

import { createAccountLockout, createStepUpFailureCap } from './account-lockout.service.js';
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

type SessionsRevokedListener = (userId: number) => StudioSessionRevocation | void;

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const databaseConnection = getConnection();
// Lockouts, sign-in passkeys, the security event log and token versions (auth-security.store).
const securityStore = getAuthSecurityStore();
const ingressOrigins = () => readStudioIngressOrigins(process.env);
// STUDIO_CLOUDFLARED_PORT, read per request like the other settings (filled from .env at start).
const cloudflaredPort = () => readCloudflaredPort(process.env);

const accountLockout = createAccountLockout({
  store: securityStore.lockouts,
  // Rows of real accounts are flagged and never evicted to make room for made-up usernames.
  isAccount: (username) => userDb.getUserByUsername(username) !== undefined,
});
// 20 wrong step-up passwords per user per rolling day, across all sessions.
const stepUpFailureCap = createStepUpFailureCap({ store: securityStore.stepUpFailures });
const securityEvents = createSecurityEventLog({ store: securityStore.events });
// Sign-in passkeys work only on the two configured front doors (STUDIO_PUBLIC_ORIGIN and
// STUDIO_TAILNET_ORIGIN), read per request like the other door settings.
const passkeys = createPasskeyCeremonies({ store: securityStore.passkeys, origins: ingressOrigins });
// Switching between the two front doors (docs/network.md); codes live in this process only.
const handoffCodes = createHandoffCodeStore();
const sessionsRevokedListeners = new Set<SessionsRevokedListener>();

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
  stepUpFailureCap,
  securityEvents,
  passkeys,
  findUserById: (userId) => userDb.getUserById(userId),
});

const accountSecurity = createAccountSecurityService({
  verifyStepUpPassword: authService.verifyStepUpPassword,
  passkeys,
  events: securityEvents,
  lockout: accountLockout,
  stepUpCap: stepUpFailureCap,
  sessionVersions: securityStore.sessionVersions,
  onSessionsRevoked: (userId) => {
    const revoked: StudioSessionRevocation = { handoffCodes: handoffCodes.discardForUser(userId) };
    for (const listener of sessionsRevokedListeners) {
      try {
        const part = listener(userId) ?? {};
        for (const [key, value] of Object.entries(part) as [keyof StudioSessionRevocation, number | undefined][]) {
          revoked[key] = (revoked[key] ?? 0) + (value ?? 0);
        }
      } catch (error) {
        console.warn('[auth] A sessions-revoked listener failed:', error instanceof Error ? error.message : String(error));
      }
    }
    return revoked;
  },
  logInfo: (message) => console.info(message),
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken, accountSecurity);

/**
 * Used by the server entrypoint to revoke what outlives a token once "退出所有设备" ran: it
 * terminates the user's live WebSockets (websocket module), deactivates their API keys (database
 * module) and drops their SNR gateway cookies (studio module). Each listener returns what it took
 * away, which Settings shows.
 */
export function onSessionsRevoked(listener: SessionsRevokedListener): () => void {
  sessionsRevokedListeners.add(listener);
  return () => sessionsRevokedListeners.delete(listener);
}

/**
 * Used by the settings module to step up sensitive changes (creating or re-activating an API key)
 * with the current password, under the session's own per-user budget. Throws 403 for a wrong
 * password and 429 while the budget is used up.
 */
export function verifyStepUpPassword(user: unknown, password: unknown, client: StudioRequestClient): Promise<void> {
  return authService.verifyStepUpPassword(user, password, client);
}

// STUDIO_CF_ACCESS_TEAM_DOMAIN + STUDIO_CF_ACCESS_AUD turn on Studio's own check of Cloudflare
// Access for requests through the public tunnel door (docs/network.md); read per request like the
// other settings, so it applies after a restart once .env changes.
const cloudflareAccess = createCloudflareAccessGate({
  config: () => readCloudflareAccessConfig(process.env),
});

/**
 * Used by the server entrypoint before every route (static files included): a request through
 * Cloudflare (or on the cloudflared listener) without a valid Cloudflare Access assertion gets 403
 * while the check is configured.
 */
export const requireCloudflareAccess = createCloudflareAccessMiddleware(cloudflareAccess, cloudflaredPort);

/**
 * Used by the server entrypoint for WebSocket upgrades, which bypass Express: resolves false for
 * an upgrade through Cloudflare (or on the cloudflared listener) without a valid Cloudflare Access
 * assertion.
 */
export async function admitCloudflareAccessUpgrade(request: IncomingMessage): Promise<boolean> {
  const port = cloudflaredPort();
  const decision = await cloudflareAccess.check({
    headers: request.headers,
    method: request.method ?? 'GET',
    path: request.url ?? '/',
    viaTunnelListener: port !== null && request.socket.localPort === port,
  });
  return decision.allowed;
}
