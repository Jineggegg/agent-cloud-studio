import express from 'express';
import type { RequestHandler } from 'express';

import type { createAccountSecurityService } from './account-security.service.js';
import type { createAuthService } from './auth.service.js';
import { readRequestClient } from './request-client.service.js';

type AuthService = ReturnType<typeof createAuthService>;
type AccountSecurityService = ReturnType<typeof createAccountSecurityService>;

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

function bodyOf(req: express.Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {};
}

/**
 * Creates the Auth transport adapter. Handlers only parse request data and delegate
 * authentication behavior to the injected application services. `accountSecurity` adds the
 * Settings → 安全 routes; tests that only exercise sign-in leave it out.
 */
export function createAuthRouter(
  service: AuthService,
  authenticateToken: RequestHandler,
  accountSecurity?: AccountSecurityService,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  // First-run only: the service refuses (403) as soon as an account exists.
  router.post('/register', async (req, res, next) => {
    try {
      const body = bodyOf(req);
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const body = bodyOf(req);
      res.json(await service.login(body.username, body.password, readRequestClient(req)));
    } catch (error) {
      next(error);
    }
  });

  // Public on purpose: "用面容 ID 登录" starts here, before there is a session. The answer carries
  // a fresh challenge for this door's RP ID (no credential ids, so it names no account) and the
  // ceremony id the assertion must come back with.
  router.post('/passkey/options', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await service.passkeySignInOptions(readHeader(req, 'origin'), readRequestClient(req)));
    } catch (error) {
      next(error);
    }
  });

  // Public on purpose: exchanges a verified passkey assertion for a session; every refusal is the
  // same 401.
  router.post('/passkey', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const body = bodyOf(req);
      res.json(await service.signInWithPasskey({
        origin: readHeader(req, 'origin'),
        ceremonyId: body.ceremonyId,
        response: body.response,
        client: readRequestClient(req),
      }));
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
        // The cloudflared listener (STUDIO_CLOUDFLARED_PORT) never carries Tailscale traffic.
        localPort: req.socket.localPort,
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
      const body = bodyOf(req);
      res.json(await service.issueHandoff(authenticated.user, authenticated.tailscaleSession, {
        target: body.target,
        password: body.password,
        client: readRequestClient(req),
      }));
    } catch (error) {
      next(error);
    }
  });

  // Public on purpose: the target page has no token yet. The service checks the Origin header
  // against the code's target door and rate-limits attempts per client and per door.
  router.post('/handoff/redeem', (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(service.redeemHandoff({
        code: bodyOf(req).code,
        origin: readHeader(req, 'origin'),
        client: readRequestClient(req),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  // authenticateToken has already refused a Tailscale-issued token that did not arrive through the
  // tailnet door, so the claim passed on here was presented where it is valid.
  router.post('/refresh', authenticateToken, (req, res) => {
    const authenticated = req as AuthenticatedRequest;
    res.setHeader('Cache-Control', 'no-store');
    res.json(service.refreshSession(authenticated.user, authenticated.tailscaleSession));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  if (accountSecurity) {
    // Settings → 安全. Everything below needs a session; passkey changes also need the password.
    router.get('/security', authenticateToken, (req, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(accountSecurity.overview((req as AuthenticatedRequest).user));
      } catch (error) {
        next(error);
      }
    });

    router.post('/security/passkeys/options', authenticateToken, async (req, res, next) => {
      try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await accountSecurity.passkeyRegistrationOptions((req as AuthenticatedRequest).user, {
          password: bodyOf(req).password,
          origin: readHeader(req, 'origin'),
          client: readRequestClient(req),
        }));
      } catch (error) {
        next(error);
      }
    });

    router.post('/security/passkeys', authenticateToken, async (req, res, next) => {
      try {
        res.json(await accountSecurity.registerPasskey((req as AuthenticatedRequest).user, {
          response: bodyOf(req).response,
          origin: readHeader(req, 'origin'),
          userAgent: readHeader(req, 'user-agent'),
          client: readRequestClient(req),
        }));
      } catch (error) {
        next(error);
      }
    });

    router.post('/security/passkeys/:id/remove', authenticateToken, async (req, res, next) => {
      try {
        res.json(await accountSecurity.removePasskey((req as AuthenticatedRequest).user, {
          id: req.params.id,
          password: bodyOf(req).password,
          client: readRequestClient(req),
        }));
      } catch (error) {
        next(error);
      }
    });

    router.post('/security/revoke-all', authenticateToken, (req, res, next) => {
      try {
        res.json(accountSecurity.revokeAllSessions((req as AuthenticatedRequest).user, readRequestClient(req)));
      } catch (error) {
        next(error);
      }
    });
  }

  return router;
}
