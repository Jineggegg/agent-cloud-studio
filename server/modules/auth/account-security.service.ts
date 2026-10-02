import type { StudioRequestClient } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { createAccountLockout } from './account-lockout.service.js';
import type { createAuthSecurityStore } from './auth-security.store.js';
import type { createAuthService } from './auth.service.js';
import type { createPasskeyCeremonies } from './passkey-signin.service.js';
import type { createSecurityEventLog } from './security-events.service.js';

type SessionUser = { id: number; username: string };

type AccountSecurityDependencies = {
  /** The password step-up, under the same throttle and lockout as login (auth.service). */
  verifyStepUpPassword: ReturnType<typeof createAuthService>['verifyStepUpPassword'];
  passkeys: Pick<
    ReturnType<typeof createPasskeyCeremonies>,
    'trustedOrigin' | 'allowedOrigins' | 'registrationOptions' | 'register' | 'list' | 'remove'
  >;
  events: ReturnType<typeof createSecurityEventLog>;
  lockout: Pick<ReturnType<typeof createAccountLockout>, 'status'>;
  sessionVersions: ReturnType<typeof createAuthSecurityStore>['sessionVersions'];
  /**
   * Called after "sign out everywhere" bumped the user's token version: auth.module forwards it to
   * its listeners (the server entrypoint closes the user's live WebSockets) and discards the user's
   * pending handoff codes.
   */
  onSessionsRevoked: (userId: number) => void;
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

/**
 * Settings → 安全 for the signed-in account: its sign-in passkeys per domain (adding and removing
 * both need the current password, checked by the step-up before anything changes), the recent
 * security events, the password lock state, and "sign out everywhere".
 * Used by auth.module, which wires it to auth.routes; every method expects a user already
 * authenticated by authenticateToken.
 */
export function createAccountSecurityService(dependencies: AccountSecurityDependencies) {
  return {
    /**
     * Everything the 安全 section shows. `passkeyOrigins` are the doors where sign-in passkeys work;
     * the page compares them with its own origin (a same-origin GET carries no Origin header).
     */
    overview(user: unknown) {
      const sessionUser = sessionUserOf(user);
      const lock = dependencies.lockout.status(sessionUser.username);
      return {
        passkeyOrigins: dependencies.passkeys.allowedOrigins(),
        passkeys: dependencies.passkeys.list(sessionUser.id),
        events: dependencies.events.recent(30),
        passwordLock: { locked: lock.locked, lockedUntil: lock.lockedUntil ? new Date(lock.lockedUntil).toISOString() : null },
      };
    },

    /**
     * Step 1 of adding a sign-in passkey for this door: checks the password (403 when wrong, 429
     * while throttled or locked), then returns WebAuthn creation options whose challenge is the
     * only way to finish step 2 within 60 s.
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
     * one included) is refused by authenticateToken and WebSocket auth from now on, and live
     * WebSockets are closed. Signing in again issues tokens with the new version.
     */
    revokeAllSessions(user: unknown, client: StudioRequestClient) {
      const sessionUser = sessionUserOf(user);
      const version = dependencies.sessionVersions.bump(sessionUser.id);
      dependencies.onSessionsRevoked(sessionUser.id);
      dependencies.events.record({ type: 'sessions-revoked', client });
      dependencies.logInfo(`[auth] Every session of local user "${sessionUser.username}" revoked (token version ${version})`);
      return { success: true };
    },
  };
}
