import type { StudioIngressId, StudioIngressOrigins } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { createHandoffCodeStore } from './handoff.service.js';
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
  /** Clock for the handoff password throttle; Date.now by default. */
  now?: () => number;
};

// Wrong passwords while moving a Tailscale session to the public door; a holder of a tailnet-only
// session must not get an unlimited password oracle. Counted per process in a fixed window.
const HANDOFF_PASSWORD_FAILURES = 5;
const HANDOFF_PASSWORD_WINDOW_MS = 10 * 60_000;

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

  const now = dependencies.now ?? Date.now;
  // Fixed window of wrong handoff passwords, reset lazily once it ends.
  const handoffPasswordFailures = { startedAt: 0, count: 0 };

  // Verifies the account password before a Tailscale session may move to the public door.
  async function verifyHandoffPassword(username: string, passwordInput: unknown) {
    if (typeof passwordInput !== 'string' || !passwordInput) {
      throw handoffError(
        'AUTH_HANDOFF_PASSWORD_REQUIRED',
        '从 Tailscale 免密码会话切换到公网域名，需要输入一次账户密码',
        403,
      );
    }
    const at = now();
    if (at - handoffPasswordFailures.startedAt >= HANDOFF_PASSWORD_WINDOW_MS) {
      handoffPasswordFailures.startedAt = at;
      handoffPasswordFailures.count = 0;
    }
    if (handoffPasswordFailures.count >= HANDOFF_PASSWORD_FAILURES) {
      throw handoffError('AUTH_HANDOFF_RATE_LIMITED', '密码错误次数过多，请 10 分钟后再试', 429);
    }
    const account = dependencies.users.getUserByUsername(username);
    const valid = account ? await dependencies.comparePassword(passwordInput, account.password_hash) : false;
    if (!valid) {
      handoffPasswordFailures.count += 1;
      dependencies.logInfo('[auth] Handoff to the public door refused (wrong password)');
      throw handoffError('AUTH_INVALID_CREDENTIALS', '密码不正确', 401);
    }
  }

  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
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

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
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
      input: { target: unknown; password: unknown },
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
        await verifyHandoffPassword(sessionUser.username, input.password);
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
    redeemHandoff(input: { code: unknown; origin: string | undefined }) {
      const result = dependencies.handoffCodes.redeem(input.code);
      if (result.status === 'rate-limited') {
        dependencies.logInfo('[auth] Handoff redemption refused (rate-limited)');
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
