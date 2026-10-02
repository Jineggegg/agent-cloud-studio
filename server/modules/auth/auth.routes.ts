import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';

type AuthService = ReturnType<typeof createAuthService>;

// Set by authenticateToken: the active user and, for a token issued by Tailscale sign-in, its
// claim, which the middleware has already verified and re-checked against the allowlist.
type AuthenticatedRequest = express.Request & {
  user?: unknown;
  tailscaleSession?: Parameters<AuthService['refreshSession']>[1];
};

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
  service: AuthService,
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
        // Set by Cloudflare's edge on the public tunnel door, which must never sign in this way.
        cfRay: readHeader(req, 'cf-ray'),
        cfConnectingIp: readHeader(req, 'cf-connecting-ip'),
        cdnLoop: readHeader(req, 'cdn-loop'),
      }));
    } catch (error) {
      next(error);
    }
  });

  // Moves the signed-in session to the other front door: returns a one-time code for the page there.
  router.post('/handoff', authenticateToken, async (req, res, next) => {
    try {
      // The response carries a code worth a session for 60 s.
      res.setHeader('Cache-Control', 'no-store');
      const authenticated = req as AuthenticatedRequest;
      const body = (req.body ?? {}) as { target?: unknown; password?: unknown };
      res.json(await service.issueHandoff(authenticated.user, authenticated.tailscaleSession, {
        target: body.target,
        password: body.password,
      }));
    } catch (error) {
      next(error);
    }
  });

  // Public on purpose: the target page has no token yet. The service checks the Origin header
  // against the code's target door and rate-limits attempts.
  router.post('/handoff/redeem', (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const body = (req.body ?? {}) as { code?: unknown };
      res.json(service.redeemHandoff({ code: body.code, origin: readHeader(req, 'origin') }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    const authenticated = req as AuthenticatedRequest;
    res.json(service.refreshSession(authenticated.user, authenticated.tailscaleSession));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
