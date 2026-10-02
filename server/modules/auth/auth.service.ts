import type { StudioIngressId, StudioIngressOrigins, StudioRequestClient } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { createAccountLockout } from './account-lockout.service.js';
import { createClientThrottle } from './client-throttle.service.js';
import type { createHandoffCodeStore } from './handoff.service.js';
import type { createPasskeyCeremonies } from './passkey-signin.service.js';
import type { createSecurityEventLog } from './security-events.service.js';
import {
  evaluateTailscaleSessionRequest,
  isTailscaleSessionRevoked,
  maskTailscaleLogin,
} from './tailscale-session.service.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type TailscaleSessionRequest = Parameters<typeof evaluateTailscaleSessionRequest>[0];
type TailscaleSignInConfig = Parameters<typeof evaluateTailscaleSessionRequest>[1];
type TailscaleSessionClaim = Extract<
  ReturnType<typeof evaluateTailscaleSessionRequest>,
  { allowed: true }
>['session'];

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    countActiveUsers(): number;
    getFirstUser(): AuthUser | undefined;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  /**
   * Signs a session token. `tailscaleSession` marks a session issued by Tailscale sign-in; the
   * token must carry it so auth.middleware can revoke the session when the allowlist changes.
   */
  generateToken(user: AuthUser, tailscaleSession?: TailscaleSessionClaim): string;
  /**
   * Current Tailscale sign-in settings, read per request from process.env (which load-env fills
   * from .env once at startup, so .env edits need a restart).
   */
  tailscaleSignIn(): TailscaleSignInConfig;
  /** Pending one-time codes for moving a session to the other front door (handoff.service). */
  handoffCodes: ReturnType<typeof createHandoffCodeStore>;
  /**
   * Origins of both front doors (STUDIO_PUBLIC_ORIGIN / STUDIO_TAILNET_ORIGIN), read per request
   * from process.env like tailscaleSignIn.
   */
  ingressOrigins(): StudioIngressOrigins;
  /** Info-level sink for Tailscale sign-in and handoff outcomes. */
  logInfo(message: string): void;
  /**
   * Wrong-password budget shared by `login` and the handoff password, so neither is an unlimited
   * password oracle on the public domain. Defaults to PASSWORD_FAILURE_LIMITS on `now`.
   */
  passwordFailures?: ReturnType<typeof createClientThrottle>;
  /** Clock for the default password throttle; Date.now by default. */
  now?: () => number;
  /**
   * Persistent account lockout (5 wrong passwords in a row lock password sign-in for 15 min, then
   * 30, 60 ... up to 24 h). Production always injects it; without it only the throttle applies.
   */
  accountLockout?: ReturnType<typeof createAccountLockout>;
  /** Security event log (Settings → 安全); events are dropped when it is not injected. */
  securityEvents?: Pick<ReturnType<typeof createSecurityEventLog>, 'record'>;
  /** Passkey sign-in ceremonies; passkey sign-in answers 403 when they are not injected. */
  passkeys?: Pick<ReturnType<typeof createPasskeyCeremonies>, 'signInOptions' | 'verifySignIn'>;
  /** Looks an active user up by id, for passkey sign-in. */
  findUserById?: (userId: number) => AuthUser | undefined;
  /**
   * A bcrypt hash compared when the username is unknown, so such attempts cost the same time as a
   * real account's; TIMING_HASH by default.
   */
  timingHash?: string;
};

// Wrong passwords allowed per 10 minutes: 5 per client (CF-Connecting-IP through Cloudflare, the
// socket address otherwise) and 20 for all clients of one door together. The door total bounds a
// distributed guesser on the public domain; it can block password logins there for a while, but
// never on the tailnet door, and signed-in sessions are unaffected.
const PASSWORD_FAILURE_LIMITS = { windowMs: 10 * 60_000, perClient: 5, perDoor: 20 };
// Stands in when a caller (tests, older code paths) does not say who is asking.
const UNKNOWN_CLIENT: StudioRequestClient = { door: 'direct', address: 'unknown' };
// Cost-12 bcrypt hash of a random string nobody knows, compared in place of a missing account's
// hash so an unknown username takes as long to refuse as a wrong password does.
const TIMING_HASH = '$2b$12$tGGCKzQOSdxNXD/GlV9lc.3ajYv0196H6VwHboOo.SJQJ9G/KFQH2';
const MAX_PASSWORD_LENGTH = 1024;

// One refusal for every lock, whichever username was typed, so a lock never confirms a username.
function accountLockedError(retryAfterMs: number): AppError {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  const wait = minutes >= 120 ? `${Math.ceil(minutes / 60)} 小时` : `${minutes} 分钟`;
  return new AppError(`密码错误次数过多，密码登录已暂时锁定，请 ${wait}后再试，或改用面容 ID / Tailscale 登录`, {
    code: 'AUTH_ACCOUNT_LOCKED',
    statusCode: 429,
    details: { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
  });
}

function lockDescription(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  return minutes >= 60 ? `锁定 ${minutes / 60} 小时` : `锁定 ${minutes} 分钟`;
}

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function handoffError(code: string, message: string, statusCode: number): AppError {
  return new AppError(message, { code, statusCode });
}

// Serialized origin of an Origin header, or null when it is missing, "null" or malformed.
function requestOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function isIngressId(value: unknown): value is StudioIngressId {
  return value === 'public' || value === 'tailnet';
}

function requireSessionUser(user: unknown): AuthUser {
  if (
    typeof user !== 'object'
    || user === null
    || !('id' in user)
    || !('username' in user)
    || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
    || typeof user.username !== 'string'
  ) {
    throw new AppError('Authenticated user is required', {
      code: 'AUTH_USER_REQUIRED',
      statusCode: 401,
    });
  }
  return { id: user.id, username: user.username };
}

// One response for every refusal, so callers cannot probe whether the feature is configured
// or which check failed; the reason only goes to the server log.
function tailscaleSignInUnavailable(): AppError {
  return new AppError('Tailscale sign-in is not available', {
    code: 'AUTH_TAILSCALE_UNAVAILABLE',
    statusCode: 403,
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  // Without STUDIO_TAILSCALE_USER an identity may only stand for the single local account;
  // with several accounts the mapping must be explicit. Failure reasons are returned as strings.
  function resolveTailscaleUser(mappedUsername: string | null) {
    if (mappedUsername) {
      return dependencies.users.getUserByUsername(mappedUsername) ?? 'mapped-user-missing';
    }
    const activeUsers = dependencies.users.countActiveUsers();
    if (activeUsers > 1) {
      return 'ambiguous-user';
    }
    return (activeUsers === 1 ? dependencies.users.getFirstUser() : undefined) ?? 'no-user';
  }

  const passwordFailures = dependencies.passwordFailures
    ?? createClientThrottle({ ...PASSWORD_FAILURE_LIMITS, now: dependencies.now });
  const timingHash = dependencies.timingHash ?? TIMING_HASH;
  const recordEvent: NonNullable<AuthDependencies['securityEvents']>['record'] = (event) => {
    dependencies.securityEvents?.record(event);
  };

  // Forgets counted failures after a sign-in that proved the owner (password, passkey or Tailscale),
  // and logs it when that lifted a lock or a run of failures.
  function clearLockout(username: string, client: StudioRequestClient, method: string) {
    const cleared = dependencies.accountLockout?.clear(username);
    if (cleared?.wasLocked) {
      recordEvent({ type: 'lockout-cleared', client, detail: method });
      dependencies.logInfo(`[auth] Password lock cleared by ${method} sign-in`);
    }
  }

  /**
   * Checks the account password for login, the handoff to the public door and the Settings
   * step-up, all under one set of limits: the per-client/per-door throttle (429) and the persistent
   * account lockout (429 AUTH_ACCOUNT_LOCKED), both checked and counted before bcrypt runs. An
   * unknown username compares against TIMING_HASH, so it costs the same and locks the same way.
   * Returns the account on success; returns null for a wrong password or unknown username (the
   * failure is already counted and logged), leaving the caller to word the refusal.
   */
  async function verifyAccountPassword(
    username: string,
    password: string,
    client: StudioRequestClient,
    purpose: 'login' | 'handoff' | 'step-up',
  ): Promise<AuthLoginUser | null> {
    if (passwordFailures.isBlocked(client)) {
      dependencies.logInfo(purpose === 'login'
        ? `[auth] Login refused (rate-limited, ${client.door} door)`
        : `[auth] Password check refused (rate-limited, ${client.door} door, ${purpose})`);
      throw purpose === 'handoff'
        ? handoffError('AUTH_HANDOFF_RATE_LIMITED', '密码错误次数过多，请 10 分钟后再试', 429)
        : new AppError('登录失败次数过多，请 10 分钟后再试', { code: 'AUTH_RATE_LIMITED', statusCode: 429 });
    }
    const attempt = dependencies.accountLockout?.begin(username);
    if (attempt && !attempt.allowed) {
      dependencies.logInfo(`[auth] Password check refused (account locked, ${client.door} door, ${purpose})`);
      throw accountLockedError(attempt.retryAfterMs);
    }
    // Counted before the slow comparison, so parallel guesses cannot all pass the checks above;
    // a success takes it back.
    passwordFailures.record(client);
    const account = dependencies.users.getUserByUsername(username);
    const valid = await dependencies.comparePassword(password, account?.password_hash ?? timingHash);
    if (!account || !valid) {
      recordEvent({
        type: purpose === 'step-up' ? 'step-up-failed' : 'login-failed',
        client,
        detail: account ? `wrong-password (${purpose})` : `unknown-user (${purpose})`,
      });
      const lock = dependencies.accountLockout?.fail(username);
      if (lock?.locked) {
        recordEvent({ type: 'account-locked', client, detail: lockDescription(lock.durationMs) });
        dependencies.logInfo(`[auth] Password sign-in locked (${lockDescription(lock.durationMs)}, ${client.door} door)`);
      }
      return null;
    }
    passwordFailures.forgive(client);
    clearLockout(account.username, client, 'password');
    return account;
  }

  // Verifies the account password before a Tailscale session may move to the public door.
  async function verifyHandoffPassword(username: string, passwordInput: unknown, client: StudioRequestClient) {
    if (typeof passwordInput !== 'string' || !passwordInput) {
      throw handoffError(
        'AUTH_HANDOFF_PASSWORD_REQUIRED',
        '从 Tailscale 免密码会话切换到公网域名，需要输入一次账户密码',
        403,
      );
    }
    if (!await verifyAccountPassword(username, passwordInput.slice(0, MAX_PASSWORD_LENGTH), client, 'handoff')) {
      dependencies.logInfo('[auth] Handoff to the public door refused (wrong password)');
      throw handoffError('AUTH_INVALID_CREDENTIALS', '密码不正确', 401);
    }
  }

  // Passkey sign-in refusals all look alike; the reason only goes to the log and the event list.
  function passkeySignInFailed(): AppError {
    return new AppError('通行密钥登录失败，请重试或改用密码登录', { code: 'AUTH_PASSKEY_FAILED', statusCode: 401 });
  }

  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    /**
     * First-run account creation. Refused (403) as soon as any account exists, before the body is
     * even looked at, so on a configured server this public route does no work and says nothing.
     */
    async register(usernameInput: unknown, passwordInput: unknown) {
      if (dependencies.users.hasUsers()) {
        throw new AppError('User already exists. This is a single-user system.', {
          code: 'AUTH_USER_ALREADY_CONFIGURED',
          statusCode: 403,
        });
      }
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }
      if (username.length > 128 || password.length > MAX_PASSWORD_LENGTH) {
        throw new AppError('Username or password is too long', { code: 'AUTH_CREDENTIALS_TOO_LONG', statusCode: 400 });
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    /**
     * Password login. Wrong passwords are throttled per client and per door (shared with the
     * handoff password), and five in a row lock password sign-in for the account (persisted, with
     * exponential backoff); both refusals come before bcrypt runs. Unknown usernames take the same
     * time and lock the same way, and every refusal is worded the same whichever name was typed.
     */
    async login(usernameInput: unknown, passwordInput: unknown, client: StudioRequestClient = UNKNOWN_CLIENT) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = await verifyAccountPassword(username.slice(0, 128), password.slice(0, MAX_PASSWORD_LENGTH), client, 'login');
      if (!user) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      recordEvent({ type: 'login-succeeded', client, detail: 'password' });
      const sessionUser = { id: user.id, username: user.username };
      return {
        success: true,
        user: sessionUser,
        token: dependencies.generateToken(sessionUser),
      };
    },

    /**
     * Checks the signed-in user's password for a sensitive Settings change (adding or removing a
     * sign-in passkey), under the same throttle and lockout as login. Used by
     * account-security.service through auth.module. Throws 403 for a wrong password.
     */
    async verifyStepUpPassword(user: unknown, passwordInput: unknown, client: StudioRequestClient = UNKNOWN_CLIENT) {
      const sessionUser = requireSessionUser(user);
      if (typeof passwordInput !== 'string' || !passwordInput || passwordInput.length > MAX_PASSWORD_LENGTH) {
        throw new AppError('请输入 Studio 登录密码', { code: 'AUTH_STEP_UP_REQUIRED', statusCode: 400 });
      }
      if (!await verifyAccountPassword(sessionUser.username, passwordInput, client, 'step-up')) {
        throw new AppError('密码不正确', { code: 'AUTH_STEP_UP_FAILED', statusCode: 403 });
      }
    },

    /** WebAuthn options for "用面容 ID 登录" on the door the page was opened on (its Origin header). */
    async passkeySignInOptions(origin: string | undefined) {
      if (!dependencies.passkeys) {
        throw new AppError('通行密钥登录不可用', { code: 'AUTH_PASSKEY_UNAVAILABLE', statusCode: 403 });
      }
      return dependencies.passkeys.signInOptions(origin);
    },

    /**
     * Issues a session for a verified passkey assertion, like `login` does for a password. The
     * passkey needs user verification, so it stands in for the password: it also works, and lifts
     * the lock, while password sign-in is locked. Every refusal is the same 401.
     */
    async signInWithPasskey(input: { origin: string | undefined; response: unknown; client?: StudioRequestClient }) {
      const client = input.client ?? UNKNOWN_CLIENT;
      if (!dependencies.passkeys || !dependencies.findUserById) {
        throw new AppError('通行密钥登录不可用', { code: 'AUTH_PASSKEY_UNAVAILABLE', statusCode: 403 });
      }
      const result = await dependencies.passkeys.verifySignIn(input.origin, input.response);
      const account = result.ok ? dependencies.findUserById(result.userId) : undefined;
      if (!result.ok || !account) {
        const reason = result.ok ? 'user-missing' : result.reason;
        dependencies.logInfo(`[auth] Passkey sign-in refused (${reason}, ${client.door} door)`);
        recordEvent({ type: 'passkey-signin-failed', client, detail: reason });
        throw passkeySignInFailed();
      }
      const sessionUser = { id: account.id, username: account.username };
      clearLockout(account.username, client, 'passkey');
      dependencies.users.updateLastLogin(numericUserId(account.id));
      recordEvent({ type: 'passkey-signin', client, detail: result.rpId });
      dependencies.logInfo(`[auth] Passkey sign-in granted on ${result.rpId} for local user "${account.username}"`);
      return { success: true, user: sessionUser, token: dependencies.generateToken(sessionUser) };
    },

    /**
     * Issues a session like `login`, without a password, for an allowlisted Tailscale identity
     * proxied by Tailscale Serve. The token records the login and device so the session is
     * revoked when either leaves the allowlist. Every refusal is the same 403; the reason is
     * logged together with the validated tailnet address, which is what STUDIO_TAILSCALE_NODES
     * lists.
     */
    signInWithTailscale(request: TailscaleSessionRequest) {
      const config = dependencies.tailscaleSignIn();
      const decision = evaluateTailscaleSessionRequest(request, config);
      const maskedLogin = maskTailscaleLogin(decision.login);
      const node = decision.allowed ? decision.session.node : decision.node;
      // Only addresses that passed validation are logged, so the line stays printable.
      const fromNode = node ? ` from ${node}` : '';
      const refuse = (reason: string) => {
        dependencies.logInfo(`[auth] Tailscale sign-in refused (${reason}) for ${maskedLogin}${fromNode}`);
        return tailscaleSignInUnavailable();
      };
      if (!decision.allowed) {
        throw refuse(decision.reason);
      }

      const user = resolveTailscaleUser(config.mappedUsername);
      if (typeof user === 'string') {
        throw refuse(user);
      }

      const sessionUser = { id: user.id, username: user.username };
      // An allowlisted owner device proves the owner, so it also lifts a password lock.
      clearLockout(user.username, { door: 'tailnet', address: decision.session.node }, 'Tailscale');
      dependencies.users.updateLastLogin(numericUserId(user.id));
      dependencies.logInfo(
        `[auth] Tailscale sign-in granted for ${maskedLogin}${fromNode} as local user "${user.username}"`,
      );
      return {
        success: true,
        user: sessionUser,
        token: dependencies.generateToken(sessionUser, decision.session),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    /**
     * Issues a replacement token. A Tailscale-issued session passes its verified claim, which the
     * replacement keeps; dropping it would turn a revocable session into a password-equivalent one.
     */
    refreshSession(user: unknown, tailscaleSession?: TailscaleSessionClaim) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser, tailscaleSession) };
    },

    /**
     * Issues a one-time code (60 s) that signs the same user in on the other front door; the page
     * there redeems it with `redeemHandoff`. The rule (docs/network.md) is that the moved session
     * is never broader than the one it came from:
     * - A password session moves as a password session to either door.
     * - A Tailscale-issued session keeps its claim when it moves to the tailnet door, so the
     *   allowlist can still revoke it there.
     * - A Tailscale-issued session may not move to the public door on its claim alone: passwordless
     *   sign-in vouches for "a tailnet device of the owner", which says nothing about the public
     *   internet. It moves only with the account password, and then becomes exactly the session a
     *   password login on the public door would have issued.
     */
    async issueHandoff(
      user: unknown,
      tailscaleSession: TailscaleSessionClaim | undefined,
      input: { target: unknown; password: unknown; client?: StudioRequestClient },
    ) {
      const sessionUser = requireSessionUser(user);
      if (!isIngressId(input.target)) {
        throw handoffError('AUTH_HANDOFF_TARGET_INVALID', '未知的入口', 400);
      }
      const target = input.target;
      const targetOrigin = dependencies.ingressOrigins()[target];
      if (!targetOrigin) {
        throw handoffError('AUTH_HANDOFF_TARGET_UNCONFIGURED', '这个入口还没有配置', 409);
      }

      let carriedClaim = tailscaleSession;
      if (tailscaleSession && target === 'public') {
        await verifyHandoffPassword(sessionUser.username, input.password, input.client ?? UNKNOWN_CLIENT);
        carriedClaim = undefined;
      }

      const issued = dependencies.handoffCodes.issue({
        userId: numericUserId(sessionUser.id),
        username: sessionUser.username,
        target,
        targetOrigin,
        ...(carriedClaim ? { tailscaleSession: { login: carriedClaim.login, node: carriedClaim.node } } : {}),
      });
      dependencies.logInfo(
        `[auth] Handoff to the ${target} door issued (${carriedClaim ? 'Tailscale' : 'password'} session)`,
      );
      return {
        code: issued.code,
        target,
        origin: targetOrigin,
        expiresAt: new Date(issued.expiresAt).toISOString(),
      };
    },

    /**
     * Redeems a handoff code for a session, like `login` does with a password. Public on purpose:
     * the target page has no token yet. The code is consumed by this call whatever the outcome; it
     * must be redeemed by a page on the exact target origin (the request's Origin header), for a
     * user who still exists, and a carried Tailscale claim must still pass the allowlist. Every
     * refusal is the same error; the reason only goes to the log.
     */
    redeemHandoff(input: { code: unknown; origin: string | undefined; client?: StudioRequestClient }) {
      const client = input.client ?? UNKNOWN_CLIENT;
      const result = dependencies.handoffCodes.redeem(input.code, client);
      if (result.status === 'rate-limited') {
        dependencies.logInfo(`[auth] Handoff redemption refused (rate-limited, ${client.door} door)`);
        throw handoffError('AUTH_HANDOFF_RATE_LIMITED', '尝试次数过多，请稍后再试', 429);
      }
      const refuse = (reason: string, target?: StudioIngressId) => {
        dependencies.logInfo(`[auth] Handoff${target ? ` to the ${target} door` : ''} refused (${reason})`);
        return handoffError('AUTH_HANDOFF_INVALID', '切换链接无效或已过期', 400);
      };
      if (result.status === 'invalid') {
        throw refuse('unknown-or-expired');
      }

      const { grant } = result;
      if (requestOrigin(input.origin) !== grant.targetOrigin) {
        throw refuse('origin-mismatch', grant.target);
      }
      // The door may have been reconfigured (and the server restarted) since the code was issued.
      if (dependencies.ingressOrigins()[grant.target] !== grant.targetOrigin) {
        throw refuse('target-changed', grant.target);
      }
      const account = dependencies.users.getUserByUsername(grant.username);
      if (!account || numericUserId(account.id) !== grant.userId) {
        throw refuse('user-missing', grant.target);
      }
      if (grant.tailscaleSession && isTailscaleSessionRevoked(grant.tailscaleSession, dependencies.tailscaleSignIn())) {
        throw refuse('tailscale-revoked', grant.target);
      }

      const sessionUser = { id: account.id, username: account.username };
      dependencies.users.updateLastLogin(numericUserId(account.id));
      dependencies.logInfo(`[auth] Handoff to the ${grant.target} door granted for local user "${account.username}"`);
      return {
        success: true,
        user: sessionUser,
        token: dependencies.generateToken(sessionUser, grant.tailscaleSession),
        target: grant.target,
      };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
