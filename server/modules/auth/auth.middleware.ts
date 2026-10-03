// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { IS_PLATFORM } from '@/shared/utils.js';

import { userDb, appConfigDb } from '../database/index.js';

import { getAuthSecurityStore } from './auth-security.store.js';
import {
  isTailnetDoorRequest,
  isTailscaleSessionRevoked,
  parseTailscaleSignInConfig,
} from './tailscale-session.service.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// A token issued by Tailscale sign-in carries a `tailscale` claim and stays valid only while its
// login (and, with STUDIO_TAILSCALE_NODES, its device) is still allowlisted. Password sessions
// carry no claim and are unaffected; rotating JWT_SECRET still revokes every session.
const isRevokedTailscaleSession = (decoded) =>
  isTailscaleSessionRevoked(decoded.tailscale, parseTailscaleSignInConfig(process.env));

// Passwordless sign-in only vouches for a tailnet device of the owner, so a token carrying the
// claim is accepted only on requests that came through the tailnet door (docs/network.md). On the
// public domain or a local address it is refused like an invalid token, even before it expires.
// `request` is an Express request or the WebSocket upgrade request; without one, fail closed.
const isTailscaleSessionOffTailnetDoor = (decoded, request) =>
  decoded.tailscale !== undefined
  && !(request && isTailnetDoorRequest(request, parseTailscaleSignInConfig(process.env)));

// Every token carries the user's token version (`ver`) from when it was signed; "退出所有设备"
// (account-security.service) bumps the stored version, which refuses every older token at once.
// Tokens signed before versions existed carry none and count as version 0, the starting value.
const tokenVersionOf = (decoded) => (Number.isSafeInteger(decoded.ver) ? decoded.ver : 0);
const currentSessionVersion = (userId) => getAuthSecurityStore().sessionVersions.current(Number(userId));
const isRevokedSessionVersion = (decoded) => tokenVersionOf(decoded) !== currentSessionVersion(decoded.userId);

// Every sign-in gets its own session id (sid), which refreshes keep; the per-session step-up
// budget (auth.service) is keyed by it, so a stolen token can only lock its own password checks.
// Tokens signed before session ids existed fall back to their issue time and version.
const sessionIdOf = (decoded) => (typeof decoded.sid === 'string' && decoded.sid
  ? decoded.sid.slice(0, 64)
  : `${decoded.iat ?? 0}.${tokenVersionOf(decoded)}`);

// Attaches the token's session id to the user row as a non-enumerable property, so it reaches the
// services and generateToken without ever appearing in a JSON response.
const withSessionId = (user, decoded) => Object.defineProperty(user, 'sessionId', {
  value: sessionIdOf(decoded),
  enumerable: false,
  configurable: true,
});

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    if (isRevokedSessionVersion(decoded)) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Session revoked. Please sign in again.',
        code: 'AUTH_TOKEN_REVOKED',
      });
    }

    if (isRevokedTailscaleSession(decoded)) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. Tailscale sign-in no longer allows this session.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    if (isTailscaleSessionOffTailnetDoor(decoded, req)) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. A Tailscale sign-in session only works through the Tailscale address.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one.
    // The replacement keeps the Tailscale claim so it stays revocable.
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(withSessionId(user, decoded), decoded.tailscale);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    // The session id rides along (not serialized) for per-session step-up budgets and refreshes.
    req.user = withSessionId(user, decoded);
    // Read by the /refresh route so an explicit refresh keeps the claim as well.
    req.tailscaleSession = decoded.tailscale;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Generate JWT token. `tailscaleSession` ({ login, node }) is passed only for sessions issued by
// Tailscale sign-in, and by every refresh of such a session. `ver` is the user's current token
// version, so "退出所有设备" revokes this token along with every other one.
const generateToken = (user, tailscaleSession?) => {
  const payload = {
    userId: user.id,
    username: user.username,
    ver: currentSessionVersion(user.id),
    // A refresh carries the session id on; a new sign-in starts a new session.
    sid: typeof user.sessionId === 'string' && user.sessionId ? user.sessionId : randomUUID(),
  };
  if (tailscaleSession) {
    payload.tailscale = { login: tailscaleSession.login, node: tailscaleSession.node };
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
};

// WebSocket authentication function. `request` is the HTTP upgrade request, needed to check which
// door a Tailscale-issued token arrived through.
const authenticateWebSocket = (token, request?) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (
      !user
      || isRevokedSessionVersion(decoded)
      || isRevokedTailscaleSession(decoded)
      || isTailscaleSessionOffTailnetDoor(decoded, request)
    ) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
