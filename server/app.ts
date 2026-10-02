import fs from 'fs';
import path from 'path';
import http from 'http';

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';

import { AppError, findApplicationRoot, getModuleDirectory, IS_PLATFORM } from '@/shared/utils.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry, closeUserWebSockets, createWebSocketServer } from '@/modules/websocket/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { createGitModule } from './modules/git/index.js';
import {
    admitCloudflareAccessUpgrade,
    authenticateToken,
    authenticateWebSocket,
    authRoutes,
    onSessionsRevoked,
    readRequestClient,
    requireCloudflareAccess,
    validateApiKey,
} from './modules/auth/index.js';
import {
    applyHttpServerLimits,
    BODY_LIMITS,
    clientErrorStatus,
    createBodyParsers,
    createRequestGuard,
    WEBSOCKET_MAX_PAYLOAD_BYTES,
} from './modules/request-guard/index.js';
import { taskmasterRoutes } from './modules/taskmaster/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import { createSystemModule } from './modules/system/index.js';
import { createAgentModule } from './modules/agent/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { userRoutes } from './modules/user/index.js';
import { getPluginPort, pluginsRoutes } from './modules/plugins/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { voiceRoutes } from './modules/voice/index.js';
import { scheduledMessagesRoutes } from './modules/scheduled-messages/index.js';
import { taskRecoveryRouter } from './modules/task-recovery/index.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { fileTreeRoutes } from './modules/file-tree/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { apiKeysDb, sessionsDb } from './modules/database/index.js';
import { createStudioModule } from './modules/studio/index.js';
import { createWebClientModule } from './modules/web-client/index.js';

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
const VITE_PORT = process.env.VITE_PORT || 5173;

/**
 * Builds the Express app, the HTTP server and the WebSocket gateway with every route mounted,
 * without listening. Used by the server entrypoint (index.ts), which starts it, and by the
 * request-guard route-walk test, which mounts the real route table on an ephemeral port.
 *
 * Order matters: the rate limiter answers floods before anything else runs, the optional
 * Cloudflare Access check comes next, and request bodies are only parsed per route group, after
 * authenticateToken for the protected ones (see BODY_LIMITS).
 */
export function createStudioServer(): { app: express.Express; server: http.Server; appRoot: string } {
    const systemRoutes = createSystemModule({
        appRoot: APP_ROOT,
        installMode,
        isPlatform: IS_PLATFORM,
    });

    const app = express();
    const server = http.createServer(app);
    applyHttpServerLimits(server);
    // Per-client and per-door token buckets (CF-Connecting-IP only behind cloudflared on loopback);
    // the same guard caps WebSocket upgrades and open sockets per client.
    const requestGuard = createRequestGuard({ readClient: (request) => readRequestClient(request) });
    const queryClaude = providerRuntimeService.getRunner('claude');
    const queryCursor = providerRuntimeService.getRunner('cursor');
    const queryCodex = providerRuntimeService.getRunner('codex');
    const queryOpenCode = providerRuntimeService.getRunner('opencode');
    const gitRoutes = createGitModule({
        queryClaude,
        queryCursor,
    });
    const agentRoutes = createAgentModule({
        queryClaude,
        queryCursor,
        queryCodex,
        queryOpenCode,
    });

    // Single WebSocket server that handles chat, shell, and plugin proxy paths.
    // A completed run stays subscribable while its session's background work
    // (agents, workflows, backgrounded commands) is still reporting through it.
    chatRunRegistry.setRetentionGuard((sessionId) => providerRuntimeService.hasBackgroundWork(sessionId));

    createWebSocketServer(server, {
        verifyClient: {
            isPlatform: IS_PLATFORM,
            authenticateWebSocket,
            // Optional Cloudflare Access check for upgrades through the public door (docs/network.md).
            admitEdgeRequest: admitCloudflareAccessUpgrade,
        },
        connectionGuard: requestGuard,
        maxPayloadBytes: WEBSOCKET_MAX_PAYLOAD_BYTES,
        chat: {
            runtime: providerRuntimeService,
        },
        shell: {
            resolveProviderSessionId: (sessionId, provider) => {
                const dbSession = sessionsDb.getSessionById(sessionId);
                if (dbSession) {
                    return dbSession.provider_session_id ?? null;
                }

                return null;
            },
        },
        getPluginPort,
    });
    const studioModule = createStudioModule();
    // "退出所有设备" refuses the user's old tokens from now on; what outlives a token goes here:
    // open sockets are terminated, API keys deactivated and SNR gateway cookies dropped.
    onSessionsRevoked((userId) => ({
        webSockets: closeUserWebSockets(userId),
        apiKeys: apiKeysDb.deactivateAllForUser(userId),
        snrAccess: studioModule.revokeSnrAccess(userId),
    }));

    app.use(cors({ exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error', 'Retry-After'] }));
    // 429 with Retry-After before any other work, per client and per door (docs/security.md).
    app.use(requestGuard.middleware);
    // With STUDIO_CF_ACCESS_TEAM_DOMAIN and STUDIO_CF_ACCESS_AUD set, every request through the public
    // tunnel door needs a valid Cloudflare Access assertion (docs/network.md); others pass untouched.
    app.use(requireCloudflareAccess);

    // Body parsers per route group (BODY_LIMITS): small for public endpoints, the large limit only
    // after authenticateToken has accepted the token.
    const publicBodies = createBodyParsers(BODY_LIMITS.public);
    const gatewayBodies = createBodyParsers(BODY_LIMITS.gateway);
    const protectedRoute = [authenticateToken, ...createBodyParsers(BODY_LIMITS.authenticated)];

    // Public health check endpoint (no authentication required). It carries no user data: the
    // running version and install mode are what the web client compares with its own build.
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            installMode,
            version: RUNNING_VERSION
        });
    });

    // Optional API key validation (if configured)
    app.use('/api', validateApiKey);

    // Authentication routes (public sign-in endpoints; the session and Settings → 安全 routes inside
    // apply authenticateToken themselves)
    app.use('/api/auth', publicBodies, authRoutes);
    // The SNR gateway checks its own short-lived cookie; the Gmail OAuth callback is a GET whose
    // state binds it to a signed-in user and project.
    app.use('/api/studio/snr-site', gatewayBodies, studioModule.snrRoutes);
    app.use('/api/studio/gmail/callback', studioModule.mailCallbackRoutes);
    app.use('/api/studio', protectedRoute, studioModule.routes);

    // File Tree API Routes (protected)
    app.use('/api/file-tree', protectedRoute, fileTreeRoutes);

    // Projects API Routes (protected)
    app.use('/api/projects', protectedRoute, projectModuleRoutes);

    // Chat attachment upload/serving (global ~/.cloudcli/assets store, protected)
    app.use('/api/assets', protectedRoute, assetsRoutes);

    // Git API Routes (protected)
    app.use('/api/git', protectedRoute, gitRoutes);

    // Git worktree management (protected)
    app.use('/api/worktrees', protectedRoute, worktreesRoutes);

    // TaskMaster API Routes (protected)
    app.use('/api/taskmaster', protectedRoute, taskmasterRoutes);

    // Commands API Routes (protected)
    app.use('/api/commands', protectedRoute, commandsRoutes);

    // Settings API Routes (protected)
    app.use('/api/settings', protectedRoute, settingsRoutes);

    app.use('/api/system', protectedRoute, systemRoutes);

    app.use('/api/notifications', protectedRoute, notificationRoutes);

    // User API Routes (protected)
    app.use('/api/user', protectedRoute, userRoutes);

    // Plugins API Routes (protected)
    app.use('/api/plugins', protectedRoute, pluginsRoutes);

    // Browser MCP bridge API (local token protected)
    app.use('/api/browser-use-mcp', gatewayBodies, browserUseMcpRoutes);

    // Browser API Routes (protected)
    app.use('/api/browser-use', protectedRoute, browserUseRoutes);

    // Unified provider MCP routes (protected)
    app.use('/api/providers', protectedRoute, providerRoutes);
    app.use('/api/scheduled-messages', protectedRoute, scheduledMessagesRoutes);
    app.use('/api/task-recovery', protectedRoute, taskRecoveryRouter);

    // Agent API Routes (uses API key authentication)
    app.use('/api/agent', gatewayBodies, agentRoutes);

    app.use('/api/voice', protectedRoute, voiceRoutes);

    // Anything else under /api is a JSON 404, never the web client's index.html.
    app.use('/api', (_req, res) => {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
    });

    // Serve public files (like api-docs.html)
    app.use(express.static(path.join(APP_ROOT, 'public')));

    // Static files served after API routes. Hashed bundles go out brotli/gzip-compressed and cached for a
    // year; index.html (sent by the catch-all below, hence index: false) is revalidated on every launch.
    const webClient = createWebClientModule({ distDir: path.join(APP_ROOT, 'dist') });
    app.use(webClient.compressedAssets);
    app.use(express.static(path.join(APP_ROOT, 'dist'), { index: false, setHeaders: webClient.staticCacheHeaders }));

    // Chat uploads live under /api/assets (server/modules/assets), which stores
    // images and general files in the global ~/.cloudcli/assets folder.

    // Serve React app for all other routes (excluding static files)
    app.get('*', (req, res, next) => {
        // Skip requests for static assets (files with extensions)
        if (path.extname(req.path)) {
            return res.status(404).send('Not found');
        }

        // Only serve index.html for HTML routes, not for static assets
        // Static assets should already be handled by express.static middleware above
        const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

        // Check if dist/index.html exists (production build available)
        if (fs.existsSync(indexPath)) {
            // Compressed when accepted, and no-cache so neither the browser nor the service worker keeps an old build.
            webClient.sendIndexHtml(req, res, next);
        } else {
            // In development, redirect to Vite dev server only if dist doesn't exist
            const redirectHost = getConnectableHost(req.hostname);
            res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
        }
    });

    // global error middleware must be last
    app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
      if (err instanceof AppError) {
        // A refusal that knows when to come back (the password lock) says so the standard way too.
        const retryAfterSeconds = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
        if (err.statusCode === 429 && typeof retryAfterSeconds === 'number') {
            res.setHeader('Retry-After', String(retryAfterSeconds));
        }
        return res.status(err.statusCode).json({
          success: false,
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
          },
        });
      }

      // Oversized or malformed bodies (body parsers) and other client errors: a short answer, no
      // stack trace in the log, so junk requests cannot fill it.
      const clientStatus = clientErrorStatus(err);
      if (clientStatus !== null) {
        return res.status(clientStatus).json({
          success: false,
          error: {
            code: clientStatus === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
            message: clientStatus === 413 ? '请求内容太大' : '请求格式不正确',
          },
        });
      }

      console.error(err);

      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
        },
      });
    });

    return { app, server, appRoot: APP_ROOT };
}
