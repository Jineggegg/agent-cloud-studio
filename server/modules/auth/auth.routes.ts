import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

// Node joins repeated headers with ", " (keeping only the first Host), so most values are strings.
function readHeader(req: express.Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.login(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  // Public on purpose: the caller has no token yet. The service decides from the socket and the
  // headers Tailscale Serve sets; every refusal is an identical 403.
  router.post('/tailscale-session', (req, res, next) => {
    try {
      // The response carries a session token, so it must never be cached.
      res.setHeader('Cache-Control', 'no-store');
      res.json(service.signInWithTailscale({
        // The raw socket peer, not req.ip, which would honour X-Forwarded-For under trust proxy.
        remoteAddress: req.socket.remoteAddress,
        host: readHeader(req, 'host'),
        origin: readHeader(req, 'origin'),
        fetchSite: readHeader(req, 'sec-fetch-site'),
        forwardedFor: readHeader(req, 'x-forwarded-for'),
        userLogin: readHeader(req, 'tailscale-user-login'),
        funnelRequest: readHeader(req, 'tailscale-funnel-request'),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
