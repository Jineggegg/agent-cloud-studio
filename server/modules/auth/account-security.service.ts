import type { StudioRequestClient, StudioSessionRevocation } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { createAccountLockout } from './account-lockout.service.js';
import type { createAuthSecurityStore } from './auth-security.store.js';
import type { createAuthService } from './auth.service.js';
import type { createPasskeyCeremonies } from './passkey-signin.service.js';
import type { createSecurityEventLog } from './security-events.service.js';

type SessionUser = { id: number; username: string };

type AccountSecurityDependencies = {
  /** The password step-up, under the session's own per-user budget (auth.service). */
  verifyStepUpPassword: ReturnType<typeof createAuthService>['verifyStepUpPassword'];
  passkeys: Pick<
    ReturnType<typeof createPasskeyCeremonies>,
    'trustedOrigin' | 'allowedOrigins' | 'registrationOptions' | 'register' | 'list' | 'remove'
  >;
  events: ReturnType<typeof createSecurityEventLog>;
  lockout: Pick<ReturnType<typeof createAccountLockout>, 'status' | 'clearScope'>;
  sessionVersions: ReturnType<typeof createAuthSecurityStore>['sessionVersions'];
  /**
   * Called after "sign out everywhere" bumped the user's token version: auth.module discards the
   * user's pending handoff codes and asks its listeners (the server entrypoint: live WebSockets,
   * API keys, SNR gateway cookies) to revoke the rest, returning what each of them took away.
   */
  onSessionsRevoked: (userId: number) => StudioSessionRevocation;
  logInfo: (message: string) => void;
};

const PASSKEY_ID_PATTERN = /^[0-9a-f-]{36}$/i;

// The signed-in user as authenticateToken attached it (getUserById's public row).
function sessionUserOf(user: unknown): SessionUser {
  const candidate = user as { id?: unknown; username?: unknown } | null;
  const id = typeof candidate?.id === 'bigint' ? Number(candidate.id) : candidate?.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof candidate?.username !== 'string') {
    throw new AppError('Authenticated user is required', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
  }
  return { id, username: candidate.username };
}

// The session id authenticateToken attached to the user, if any (see auth.middleware).
function sessionIdOf(user: unknown): string | undefined {
  const value = typeof user === 'object' && user !== null ? (user as { sessionId?: unknown }).sessionId : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

// "API 密钥 2 · 连接 3 · SNR 1" for the event log; parts that revoked nothing are left out.
function describeRevocation(revoked: StudioSessionRevocation): string {
  const parts: [keyof StudioSessionRevocation, string][] = [
    ['webSockets', '连接'],
    ['apiKeys', 'API 密钥'],
    ['snrAccess', 'SNR 入口'],
    ['pushSubscriptions', '推送订阅'],
    ['handoffCodes', '切换代码'],
  ];
  return ['所有会话', ...parts.filter(([key]) => (revoked[key] ?? 0) > 0).map(([key, label]) => `${label} ${revoked[key]}`)].join(' · ');
}

/**
 * Settings → 安全 for the signed-in account: its sign-in passkeys per domain (adding and removing
 * both need the current password, checked by the step-up before anything changes), the password
 * lock of each door, the recent and the important security events, and "sign out everywhere".
 * Used by auth.module, which wires it to auth.routes; every method expects a user already
 * authenticated by authenticateToken.
 */
export function createAccountSecurityService(dependencies: AccountSecurityDependencies) {
  const lockView = (username: string, scope: Parameters<AccountSecurityDependencies['lockout']['status']>[1], subject?: string) => {
    const lock = dependencies.lockout.status(username, scope, subject);
    return { locked: lock.locked, lockedUntil: lock.lockedUntil ? new Date(lock.lockedUntil).toISOString() : null };
  };

  return {
    /**
     * Everything the 安全 section shows. `passkeyOrigins` are the doors where sign-in passkeys work;
     * the page compares them with its own origin (a same-origin GET carries no Origin header).
     */
    overview(user: unknown) {
      const sessionUser = sessionUserOf(user);
      return {
        passkeyOrigins: dependencies.passkeys.allowedOrigins(),
        passkeys: dependencies.passkeys.list(sessionUser.id),
        events: dependencies.events.recent(30),
        importantEvents: dependencies.events.recentImportant(10),
        signIns: dependencies.events.recentSignIns(10),
        passwordLocks: {
          public: lockView(sessionUser.username, 'public'),
          tailnet: lockView(sessionUser.username, 'tailnet'),
          // This session's own step-up budget (other sessions, a stolen token's included, are apart).
          session: lockView(sessionUser.username, 'session', sessionIdOf(user)),
        },
      };
    },

    /**
     * Step 1 of adding a sign-in passkey for this door: checks the password (403 when wrong, 429
     * while the session's budget is used up), then returns WebAuthn creation options whose
     * challenge is the only way to finish step 2 within 60 s.
     */
    async passkeyRegistrationOptions(user: unknown, input: { password: unknown; origin: string | undefined; client: StudioRequestClient }) {
      const sessionUser = sessionUserOf(user);
      // The door is checked first, so a wrong origin never costs a password attempt.
      dependencies.passkeys.trustedOrigin(input.origin);
      await dependencies.verifyStepUpPassword(sessionUser, input.password, input.client);
      return dependencies.passkeys.registrationOptions(sessionUser, input.origin);
    },

    /** Step 2: verifies the authenticator's answer against the step-1 challenge and stores the passkey. */
    async registerPasskey(user: unknown, input: { response: unknown; origin: string | undefined; userAgent: string | undefined; client: StudioRequestClient }) {
      const sessionUser = sessionUserOf(user);
      const passkey = await dependencies.passkeys.register(sessionUser, input.origin, input.response, input.userAgent);
      dependencies.events.record({ type: 'passkey-added', client: input.client, detail: `${passkey.rpId} · ${passkey.label ?? '设备'}` });
      dependencies.logInfo(`[auth] Sign-in passkey added on ${passkey.rpId}`);
      return passkey;
    },

    /** Removes one of the user's sign-in passkeys after the password step-up; 404 when unknown. */
    async removePasskey(user: unknown, input: { id: unknown; password: unknown; client: StudioRequestClient }) {
      const sessionUser = sessionUserOf(user);
      if (typeof input.id !== 'string' || !PASSKEY_ID_PATTERN.test(input.id)) {
        throw new AppError('找不到这把通行密钥', { code: 'AUTH_PASSKEY_NOT_FOUND', statusCode: 404 });
      }
      await dependencies.verifyStepUpPassword(sessionUser, input.password, input.client);
      const removed = dependencies.passkeys.remove(sessionUser.id, input.id);
      if (!removed) {
        throw new AppError('找不到这把通行密钥', { code: 'AUTH_PASSKEY_NOT_FOUND', statusCode: 404 });
      }
      dependencies.events.record({ type: 'passkey-removed', client: input.client, detail: `${removed.rpId} · ${removed.label ?? '设备'}` });
      dependencies.logInfo(`[auth] Sign-in passkey removed from ${removed.rpId}`);
      return removed;
    },

    /**
     * "退出所有设备": bumps the user's token version, so every session token issued so far (this
     * one included) is refused by authenticateToken and WebSocket auth from now on, and has the
     * listeners terminate live WebSockets, deactivate the user's API keys and drop SNR gateway
     * cookies. Returns what was revoked, for Settings to show.
     */
    revokeAllSessions(user: unknown, client: StudioRequestClient) {
      const sessionUser = sessionUserOf(user);
      const version = dependencies.sessionVersions.bump(sessionUser.id);
      const revoked = dependencies.onSessionsRevoked(sessionUser.id);
      // Every session is gone, so are their step-up locks.
      dependencies.lockout.clearScope(sessionUser.username, 'session');
      dependencies.events.record({ type: 'sessions-revoked', client, detail: describeRevocation(revoked) });
      if ((revoked.apiKeys ?? 0) > 0) {
        dependencies.events.record({ type: 'api-keys-revoked', client, detail: `${revoked.apiKeys} 个` });
      }
      dependencies.logInfo(`[auth] Every session of local user "${sessionUser.username}" revoked (token version ${version})`);
      return {
        success: true,
        revoked: {
          sessions: true,
          webSockets: revoked.webSockets ?? 0,
          apiKeys: revoked.apiKeys ?? 0,
          snrAccess: revoked.snrAccess ?? 0,
          pushSubscriptions: revoked.pushSubscriptions ?? 0,
          handoffCodes: revoked.handoffCodes ?? 0,
        },
      };
    },
  };
}
