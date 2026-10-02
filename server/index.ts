#!/usr/bin/env node
// Load environment variables before other imports execute.
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';

import { readCloudflaredPort, terminalTextStyles } from '@/shared/utils.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    providerRuntimeService,
} from '@/modules/providers/index.js';
import { initializeTaskRecovery } from '@/modules/task-recovery/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { createStudioServer } from './app.js';
import { startEnabledPluginServers, stopAllPlugins } from './modules/plugins/index.js';
import {
    closeScheduledMessageDispatcher,
    initializeScheduledMessageDispatcher,
} from './modules/scheduled-messages/index.js';
import { HTTP_SERVER_LIMITS, startCloudflaredListener } from './modules/request-guard/index.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { initializeDatabase } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

// Every route, the WebSocket gateway and the server's DoS limits (server/app.ts).
const { server, appRoot: APP_ROOT } = createStudioServer();
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    return String(error.code);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', getErrorMessage(error));
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();
        // Old approvals and uncertain tool operations are never replayed on boot.
        initializeTaskRecovery();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${terminalTextStyles.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${terminalTextStyles.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${terminalTextStyles.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);

        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log(`  ${terminalTextStyles.bright('CloudCLI Server - Ready')}`);
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log('');
            console.log(`${terminalTextStyles.info('[INFO]')} Server URL:  ${terminalTextStyles.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${terminalTextStyles.info('[INFO]')} Installed at: ${terminalTextStyles.dim(appInstallPath)}`);
            console.log(`${terminalTextStyles.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            // The public door's own loopback port (docs/security.md): only connections arriving
            // there count as Cloudflare traffic once STUDIO_CLOUDFLARED_PORT is set.
            const tunnelPort = readCloudflaredPort(process.env);
            if (tunnelPort !== null) {
                await startCloudflaredListener(server, tunnelPort, { maxConnections: HTTP_SERVER_LIMITS.maxConnections })
                    .then(() => console.log(`${terminalTextStyles.info('[INFO]')} Cloudflare Tunnel listener: http://127.0.0.1:${tunnelPort}`))
                    .catch((error) => console.error('[ERROR] Could not open the Cloudflare Tunnel listener:', getErrorMessage(error)));
            } else if (process.env.STUDIO_CLOUDFLARED_PORT?.trim()) {
                console.warn('[WARN] STUDIO_CLOUDFLARED_PORT is not a usable port (or equals SERVER_PORT); Cloudflare traffic is recognised by its headers only');
            }

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();
            // Sends anything that came due while the server was not running,
            // then keeps polling.
            initializeScheduledMessageDispatcher(providerRuntimeService);

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });
        });

        await closeSessionsWatcher();
        closeScheduledMessageDispatcher();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
