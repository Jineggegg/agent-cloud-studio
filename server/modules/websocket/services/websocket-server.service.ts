import type { Server as HttpServer, IncomingMessage } from 'node:http';

import { WebSocket, WebSocketServer, type VerifyClientCallbackAsync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketUpgrade } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { handleDesktopNotificationsConnection } from '@/modules/notifications/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketUpgrade>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[1];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
  /**
   * Rate limit and per-client connection cap (the request-guard module): `admitUpgrade` runs
   * before every other upgrade check, `trackConnection` counts each accepted socket until it
   * closes.
   */
  connectionGuard?: {
    admitUpgrade(request: IncomingMessage): { allowed: true } | { allowed: false; statusCode: number; retryAfterSeconds: number };
    trackConnection(request: IncomingMessage): () => void;
  };
  /** Largest message accepted from a client; ws closes the socket (1009) beyond it. */
  maxPayloadBytes?: number;
};

// Open sockets per signed-in user, so "退出所有设备" can close them (closeUserWebSockets).
const socketsByUser = new Map<string, Set<WebSocket>>();

function userKeyOf(request: AuthenticatedWebSocketRequest): string | null {
  const id = request.user?.userId ?? request.user?.id;
  return id === undefined || id === null ? null : String(id);
}

function rememberUserSocket(ws: WebSocket, request: AuthenticatedWebSocketRequest) {
  const key = userKeyOf(request);
  if (key === null) return;
  const sockets = socketsByUser.get(key) ?? new Set<WebSocket>();
  sockets.add(ws);
  socketsByUser.set(key, sockets);
  ws.once('close', () => {
    sockets.delete(ws);
    if (sockets.size === 0 && socketsByUser.get(key) === sockets) socketsByUser.delete(key);
  });
}

/**
 * Closes every open WebSocket of a user with 4401 ("session revoked"), returning how many. Used by
 * the server entrypoint after the auth module's "退出所有设备", whose token-version bump already
 * refuses the user's old tokens on any new upgrade.
 */
export function closeUserWebSockets(userId: number | string): number {
  const sockets = socketsByUser.get(String(userId));
  if (!sockets) return 0;
  let closed = 0;
  for (const ws of [...sockets]) {
    try {
      ws.close(4401, 'Session revoked');
      closed += 1;
    } catch {
      ws.terminate();
      closed += 1;
    }
  }
  return closed;
}

/**
 * Used by this module's websocket gateway to keep active transports alive and
 * close half-open connections so their route-specific clients can reconnect.
 */
export function attachWebSocketHeartbeat(
  ws: WebSocket,
  intervalMs = 30_000,
  scheduler = {
    setInterval,
    clearInterval,
  },
): () => void {
  let isAlive = true;
  let stopped = false;

  const markAlive = () => {
    isAlive = true;
  };

  const stopHeartbeat = () => {
    if (stopped) {
      return;
    }

    stopped = true;
    scheduler.clearInterval(heartbeat);
    ws.off('pong', markAlive);
    ws.off('close', stopHeartbeat);
    ws.off('error', stopHeartbeat);
  };

  ws.on('pong', markAlive);
  ws.on('close', stopHeartbeat);
  ws.on('error', stopHeartbeat);

  const heartbeat = scheduler.setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // A socket that did not answer the previous ping is half-open from the
    // server's perspective. Terminating it emits close and lets clients resume.
    if (!isAlive) {
      stopHeartbeat();
      ws.terminate();
      return;
    }

    isAlive = false;
    try {
      ws.ping();
    } catch {
      stopHeartbeat();
      ws.terminate();
    }
  }, intervalMs);

  return stopHeartbeat;
}

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes. Exported through the websocket module for server startup.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  // Asynchronous (two parameters) because the optional Cloudflare Access check may fetch keys.
  const verifyClient: VerifyClientCallbackAsync<AuthenticatedWebSocketRequest> = (info, done) => {
    const admission = dependencies.connectionGuard?.admitUpgrade(info.req);
    if (admission && !admission.allowed) {
      done(false, admission.statusCode, 'Too Many Requests', { 'Retry-After': String(admission.retryAfterSeconds) });
      return;
    }
    verifyWebSocketUpgrade(info, dependencies.verifyClient).then(
      (result) => (result.allowed ? done(true) : done(false, result.statusCode)),
      (error: unknown) => {
        console.error('[WARN] WebSocket verification failed:', error instanceof Error ? error.message : String(error));
        done(false, 500);
      },
    );
  };
  const wss = new WebSocketServer({
    server,
    verifyClient,
    ...(dependencies.maxPayloadBytes ? { maxPayload: dependencies.maxPayloadBytes } : {}),
  });

  wss.on('connection', (ws, request) => {
    attachWebSocketHeartbeat(ws);
    const release = dependencies.connectionGuard?.trackConnection(request);
    if (release) ws.once('close', release);

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    rememberUserSocket(ws, incomingRequest);
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      handleShellConnection(ws, dependencies.shell);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname === '/desktop-notifications') {
      handleDesktopNotificationsConnection(ws, incomingRequest);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
