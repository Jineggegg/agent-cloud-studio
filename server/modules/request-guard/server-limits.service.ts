import type { Server } from 'node:http';

import express from 'express';
import type { RequestHandler } from 'express';

/**
 * Timeouts and caps of the HTTP server (see applyHttpServerLimits).
 * - headersTimeout counts from the first byte of each request (Node 18+ does not count the idle
 *   time of a keep-alive connection), so it can be short: cloudflared and Tailscale Serve deliver
 *   complete headers at once, and only a slowloris client ever gets near it.
 * - requestTimeout must let the largest upload through: the file tree accepts 200 MB, which takes
 *   10 minutes at 2.7 Mbit/s. Response streams (event streams, streamed chat answers) are not
 *   affected; it only covers receiving the request.
 * - keepAliveTimeout stays above the idle time the proxies keep a connection for reuse.
 * A client holding many slow requests is bounded by the request guard's in-flight cap.
 * Used by applyHttpServerLimits and its tests.
 */
export const HTTP_SERVER_LIMITS = {
  /** Whole request (headers and body) must arrive within this. */
  requestTimeoutMs: 600_000,
  /** Headers must be complete within this, counted from the request's first byte (slowloris). */
  headersTimeoutMs: 20_000,
  /** An idle keep-alive connection is closed after this. */
  keepAliveTimeoutMs: 65_000,
  /** Requests served on one connection before it is closed, so one socket cannot be pinned forever. */
  maxRequestsPerSocket: 1000,
  /** Open connections (WebSockets included); beyond it new connections are dropped at once. */
  maxConnections: 1024,
};

/**
 * Body size limits per kind of route (see createBodyParsers):
 * - `public`: /api/auth/* and other endpoints reachable without a session; a login or a
 *   passkey assertion is well under 16 kB;
 * - `gateway`: routes that check their own credential inside the router (API key, Browser MCP
 *   token, SNR cookie), so their bodies are read before that check;
 * - `authenticated`: routes behind authenticateToken, whose bodies are only read after the
 *   token was verified (file saves, long prompts).
 * Used by the server entrypoint and the request-guard tests.
 */
export const BODY_LIMITS = {
  public: '32kb',
  gateway: '10mb',
  authenticated: '50mb',
} as const;

/**
 * Largest WebSocket message accepted (ws closes the socket with 1009 beyond it). Chat prompts and
 * terminal input are text; images travel over HTTP uploads, never over the socket.
 * Used by the websocket module through the server entrypoint.
 */
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Applies HTTP_SERVER_LIMITS (or overrides) to the server before it listens.
 * Used by the server entrypoint.
 */
export function applyHttpServerLimits(server: Server, limits: typeof HTTP_SERVER_LIMITS = HTTP_SERVER_LIMITS): void {
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.maxConnections = limits.maxConnections;
}

/**
 * The JSON and URL-encoded body parsers with one size limit. Mounted per route group by the
 * server entrypoint instead of globally, so an unauthenticated request can never make the server
 * read more than BODY_LIMITS.public (or .gateway) bytes, and the large limit only applies after
 * authenticateToken. Multipart uploads are left to the routes' own multer limits.
 */
export function createBodyParsers(limit: string): RequestHandler[] {
  return [
    express.json({
      limit,
      type: (req) => {
        const contentType = String(req.headers['content-type'] ?? '');
        return !contentType.includes('multipart/form-data') && contentType.includes('json');
      },
    }),
    express.urlencoded({ limit, extended: true, parameterLimit: 1000 }),
  ];
}

/**
 * For the server's error handler: the status of a client error raised by middleware such as the
 * body parsers (413 too large, 400 malformed JSON, 415 unsupported charset), or null for anything
 * else. Lets the handler answer those with a short message instead of logging a 500.
 */
export function clientErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 && candidate.expose !== false ? status : null;
}
