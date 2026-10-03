import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';

import type { RequestHandler } from 'express';

import type { StudioCloudflareAccessConfig } from '@/shared/types.js';
import { isViaCloudflareEdge } from '@/shared/utils.js';

/**
 * Server-side check of Cloudflare Access for the public tunnel door (docs/network.md).
 *
 * Cloudflare Access sits in front of studio.ajarche.com and, once a visitor passed its login, adds
 * a Cf-Access-Jwt-Assertion header to every request it forwards through the tunnel. Without this
 * check Access is only as good as the Cloudflare configuration; with STUDIO_CF_ACCESS_TEAM_DOMAIN and
 * STUDIO_CF_ACCESS_AUD set, Studio itself refuses (403) every request that came through Cloudflare's
 * edge without a valid assertion, e.g. when the Access application was removed or its domain
 * changed. Requests through the tailnet door or from this machine carry no Cloudflare headers and
 * are not affected.
 *
 * The only exceptions are GET/HEAD of the paths docs/network.md puts in an Access "Bypass"
 * application, which Access forwards without an assertion: /health (public by design, and what the
 * Settings probe uses to see whether the tunnel is up behind Access) and the home-screen
 * /manifest.json and /icons/*.png|svg. None of them carries data or accepts input.
 *
 * A valid assertion is an RS256 JWT whose `kid` names a key from
 * https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, with `iss` equal to the team origin, an
 * `aud` containing a configured tag, and an `exp` in the future. The key set is cached for an hour
 * and refetched early for an unknown `kid`, at most once a minute, so forged `kid`s cannot make
 * Studio hammer Cloudflare. When a refetch fails, keys already fetched keep working.
 */

type JwtHeader = { alg?: unknown; kid?: unknown };
type JwtVerifyOptions = { algorithms: string[]; audience: string[]; issuer: string; clockTolerance: number };

// jsonwebtoken ships no TypeScript declarations in this project; narrow the two calls used here.
type JwtAdapter = {
  decode(token: string, options: { complete: true }): { header: JwtHeader } | null;
  verify(token: string, key: KeyObject, options: JwtVerifyOptions): unknown;
};

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as JwtAdapter;

type AccessDenialReason =
  | 'config-invalid'
  | 'assertion-missing'
  | 'assertion-malformed'
  | 'key-unavailable'
  | 'assertion-invalid';

type AccessDecision = { allowed: true } | { allowed: false; reason: AccessDenialReason };

type CloudflareAccessGateDependencies = {
  /** Current settings; auth.module reads them from process.env (filled from .env at startup). */
  config: () => StudioCloudflareAccessConfig;
  /** Fetches the team's key set; the global fetch by default. Tests inject a fake. */
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a fetched key set counts as fresh. */
  keysTtlMs?: number;
  /** Least time between two key set fetches. */
  refetchCooldownMs?: number;
  /** Sink for refusals and key fetch failures; reasons only, never the assertion itself. */
  logWarn?: (message: string) => void;
};

type KeySet = { certsUrl: string; keys: Map<string, KeyObject>; fetchedAt: number };

type CheckInput = {
  headers: Record<string, string | string[] | undefined>;
  /** HTTP method; WebSocket upgrades are GET. */
  method: string;
  /** Request path, possibly with a query string (which is never logged). */
  path: string;
  /**
   * True when the connection arrived on the cloudflared listener (STUDIO_CLOUDFLARED_PORT): such a
   * request is public-door traffic and is checked even if it carries no Cloudflare headers.
   */
  viaTunnelListener?: boolean;
};

const ALLOWED: AccessDecision = { allowed: true };
// Exact public paths; icon names must have an extension and cannot be "." or "..".
const PUBLIC_PATHS = new Set(['/health', '/manifest.json']);
const PUBLIC_ICON_PATH = /^\/icons\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|svg)$/;
const KEY_FETCH_TIMEOUT_MS = 5000;
// Seconds of clock skew tolerated on exp / nbf between Cloudflare and this laptop.
const CLOCK_TOLERANCE_SECONDS = 10;

// GET/HEAD of a path that docs/network.md lets bypass Access (see the module comment).
function isPublicPath(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }
  const pathname = path.split('?')[0];
  return PUBLIC_PATHS.has(pathname) || PUBLIC_ICON_PATH.test(pathname);
}

// Parses the certs endpoint answer ({ keys: [JWK...] }) into RSA public keys by kid; entries
// without a kid or that are not RSA keys are skipped.
function parseKeySet(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const entries = typeof body === 'object' && body !== null && Array.isArray((body as { keys?: unknown }).keys)
    ? (body as { keys: unknown[] }).keys
    : [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const jwk = entry as JsonWebKey & { kid?: unknown };
    if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
    try {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // A malformed entry must not hide the valid ones.
    }
  }
  return keys;
}

/**
 * Creates the gate.
 * Used by auth.module, which exposes it as Express middleware (mounted by the server entrypoint
 * before every route) and as a WebSocket upgrade check, and by the auth tests with a fake fetch.
 */
export function createCloudflareAccessGate(dependencies: CloudflareAccessGateDependencies) {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const keysTtlMs = dependencies.keysTtlMs ?? 60 * 60_000;
  const refetchCooldownMs = dependencies.refetchCooldownMs ?? 60_000;
  const logWarn = dependencies.logWarn ?? ((message: string) => console.warn(message));
  let keySet: KeySet | null = null;
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  // Concurrent requests share one fetch.
  let inflight: Promise<void> | null = null;

  async function fetchKeySet(certsUrl: string) {
    lastFetchAt = now();
    try {
      const response = await request(certsUrl, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const keys = parseKeySet(await response.json());
      if (keys.size === 0) throw new Error('no RSA keys');
      keySet = { certsUrl, keys, fetchedAt: now() };
    } catch (error) {
      logWarn(`[auth] Cloudflare Access keys could not be fetched (${error instanceof Error ? error.message : 'error'})`);
    }
  }

  async function keyFor(certsUrl: string, kid: string): Promise<KeyObject | null> {
    const current = keySet?.certsUrl === certsUrl ? keySet : null;
    const needsFetch = current === null || now() - current.fetchedAt >= keysTtlMs || !current.keys.has(kid);
    if (needsFetch && now() - lastFetchAt >= refetchCooldownMs) {
      inflight ??= fetchKeySet(certsUrl).finally(() => { inflight = null; });
      await inflight;
    } else if (inflight) {
      await inflight;
    }
    // A stale set still holds Cloudflare's keys; it beats refusing everyone while the fetch fails.
    return keySet?.certsUrl === certsUrl ? keySet.keys.get(kid) ?? null : null;
  }

  async function decide(input: CheckInput): Promise<AccessDecision> {
    const { headers } = input;
    if ((!input.viaTunnelListener && !isViaCloudflareEdge(headers)) || isPublicPath(input.method, input.path)) {
      return ALLOWED;
    }
    const config = dependencies.config();
    if (config.status === 'off') {
      return ALLOWED;
    }
    if (config.status === 'invalid') {
      return { allowed: false, reason: 'config-invalid' };
    }
    const rawAssertion = headers['cf-access-jwt-assertion'];
    const assertion = typeof rawAssertion === 'string' ? rawAssertion.trim() : '';
    if (!assertion) {
      return { allowed: false, reason: 'assertion-missing' };
    }
    let header: JwtHeader | undefined;
    try {
      header = jwt.decode(assertion, { complete: true })?.header;
    } catch {
      header = undefined;
    }
    // Only RS256 is accepted, so an HS256 token "signed" with a public key cannot pass.
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      return { allowed: false, reason: 'assertion-malformed' };
    }
    const key = await keyFor(config.certsUrl, header.kid);
    if (!key) {
      return { allowed: false, reason: 'key-unavailable' };
    }
    try {
      const payload = jwt.verify(assertion, key, {
        algorithms: ['RS256'],
        audience: config.audience,
        issuer: config.issuer,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      // jsonwebtoken only checks exp when present; Access always sets it, so require it.
      const expiresAt = typeof payload === 'object' && payload !== null ? (payload as { exp?: unknown }).exp : undefined;
      return typeof expiresAt === 'number' ? ALLOWED : { allowed: false, reason: 'assertion-invalid' };
    } catch {
      return { allowed: false, reason: 'assertion-invalid' };
    }
  }

  return {
    /**
     * Decides whether a request may proceed. Requests without Cloudflare's edge headers, the public
     * paths, and every request while the check is off, are allowed without looking at anything
     * else. Refusals are logged with their reason and the request path.
     */
    async check(input: CheckInput): Promise<AccessDecision> {
      const decision = await decide(input);
      if (!decision.allowed) {
        // Only the path, never the query string, which may carry a token (SSE, WebSocket).
        logWarn(`[auth] Cloudflare Access refused ${input.path.split('?')[0]} (${decision.reason})`);
      }
      return decision;
    },
  };
}

/**
 * Wraps the gate as Express middleware: a refused request gets 403 with the usual AppError body
 * (code CF_ACCESS_REQUIRED). Used by auth.module for the middleware the server entrypoint mounts
 * before every route, static files included. `tunnelPort` reads STUDIO_CLOUDFLARED_PORT, so every
 * request on the cloudflared listener is checked, Cloudflare headers or not.
 */
export function createCloudflareAccessMiddleware(
  gate: ReturnType<typeof createCloudflareAccessGate>,
  tunnelPort: () => number | null = () => null,
): RequestHandler {
  return (req, res, next) => {
    const port = tunnelPort();
    const viaTunnelListener = port !== null && req.socket.localPort === port;
    gate.check({ headers: req.headers, method: req.method, path: req.originalUrl, viaTunnelListener }).then((decision) => {
      if (decision.allowed) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(403).json({
        success: false,
        error: { code: 'CF_ACCESS_REQUIRED', message: '请先通过 Cloudflare Access 验证，再打开 Studio' },
      });
    }, next);
  };
}
