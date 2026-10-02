import { AppError } from '@/shared/utils.js';

import {
  evaluateTailscaleSessionRequest,
  maskTailscaleLogin,
} from './tailscale-session.service.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type TailscaleSessionRequest = Parameters<typeof evaluateTailscaleSessionRequest>[0];
type TailscaleSignInConfig = Parameters<typeof evaluateTailscaleSessionRequest>[1];

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
  generateToken(user: AuthUser): string;
  /** Current Tailscale sign-in settings; read per request so the policy follows the env. */
  tailscaleSignIn(): TailscaleSignInConfig;
  /** Info-level sink for Tailscale sign-in outcomes. */
  logInfo(message: string): void;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
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
     * Issues the same session as `login`, without a password, for an allowlisted Tailscale
     * identity proxied by Tailscale Serve. Every refusal is the same 403; the reason is logged.
     */
    signInWithTailscale(request: TailscaleSessionRequest) {
      const config = dependencies.tailscaleSignIn();
      const decision = evaluateTailscaleSessionRequest(request, config);
      const maskedLogin = maskTailscaleLogin(decision.login);
      const refuse = (reason: string) => {
        dependencies.logInfo(`[auth] Tailscale sign-in refused (${reason}) for ${maskedLogin}`);
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
        `[auth] Tailscale sign-in granted for ${maskedLogin} as local user "${user.username}"`,
      );
      return {
        success: true,
        user: sessionUser,
        token: dependencies.generateToken(sessionUser),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
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

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
