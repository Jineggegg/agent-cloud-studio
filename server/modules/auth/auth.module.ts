import { createRequire } from 'node:module';

import { getConnection, userDb } from '@/modules/database/index.js';

import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
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
  // STUDIO_TAILSCALE_NODES, STUDIO_TAILSCALE_USER and STUDIO_PUBLIC_ORIGIN refine it.
  // process.env is filled from .env once at startup, so .env edits apply after a restart.
  tailscaleSignIn: () => parseTailscaleSignInConfig(process.env),
  logInfo: (message) => console.info(message),
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);
