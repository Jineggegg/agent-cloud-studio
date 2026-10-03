import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import type { StudioAppRunState, StudioAppStatus } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

// An app that has not answered on its port by then counts as failed to start.
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
// A running app nobody has used for this long is stopped; opening its 主页 starts it again.
const IDLE_STOP_MS = 30 * 60_000;
const IDLE_SWEEP_MS = 60_000;
// SIGTERM first; whatever is still alive after this gets SIGKILL.
const KILL_GRACE_MS = 3_000;
// The last lines of the app's own output, shown when it fails to start.
const LOG_LINES = 40;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
// Folders a static app (no server of its own) may keep its index.html in, in order of preference.
const STATIC_ROOTS = ['', 'public', 'dist'];
// Environment variables an app process inherits; Studio's own secrets and settings stay behind.
const INHERITED_ENV = /^(PATH|HOME|USER|SHELL|TMPDIR|LANG|LC_[A-Z_]+|TERM|TZ|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;

/** How an app is started: its npm start script, its package.json main file, or its static files served by Studio. */
export type StudioAppEntry =
  | { kind: 'npm' }
  | { kind: 'node'; file: string }
  | { kind: 'static'; root: string };

type AppProcess = {
  state: StudioAppRunState;
  entry: StudioAppEntry | null;
  directory: string;
  port: number | null;
  child: ChildProcess | null;
  // The commit the running code came from; a newer commit (the AI changed the app) restarts it on the next open.
  head: string | null;
  startedAt: number | null;
  lastUsedAt: number;
  error: string | null;
  log: string[];
  // The start in flight, shared by every caller that asks for the app meanwhile.
  starting: Promise<void> | null;
};

type Dependencies = {
  spawnProcess?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
  freePort?: () => Promise<number>;
  // Resolves once something answers HTTP on the port (any status counts); rejects on timeout or abort.
  waitReady?: (port: number, signal: AbortSignal) => Promise<void>;
  readHead?: (directory: string) => Promise<string | null>;
  now?: () => number;
  idleStopMs?: number;
};

// The repository's current commit, or null outside a repository.
async function gitHead(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: directory, timeout: 3_000, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function waitForHttp(port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const attempt = () => {
      if (signal.aborted) { reject(new Error('aborted')); return; }
      const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2_000 }, response => {
        response.resume();
        resolve();
      });
      request.on('error', retry);
      request.on('timeout', () => request.destroy(new Error('timeout')));
    };
    const retry = () => {
      if (Date.now() > deadline) { reject(new Error('timeout')); return; }
      setTimeout(attempt, READY_POLL_MS);
    };
    attempt();
  });
}

function spawnDetached(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  // Its own process group, so stopping the app also stops whatever `npm start` started under it.
  return spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
}

// Whether `file` (resolved) lies inside `directory`.
function isInside(directory: string, file: string) {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * How the app in `directory` starts: `npm start` when package.json has a start script, `node <main>` when it names
 * a main file inside the folder, otherwise its index.html (in the folder, public/ or dist/) served as static files.
 * Null when it has none of these.
 */
export function detectAppEntry(directory: string): StudioAppEntry | null {
  const manifest = path.join(directory, 'package.json');
  if (existsSync(manifest) && statSync(manifest).size <= MAX_PACKAGE_JSON_BYTES) {
    try {
      const data = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, unknown>; main?: unknown };
      if (typeof data.scripts?.start === 'string' && data.scripts.start.trim()) return { kind: 'npm' };
      if (typeof data.main === 'string' && data.main.trim()) {
        const file = path.resolve(directory, data.main);
        if (isInside(directory, file) && existsSync(file)) return { kind: 'node', file };
      }
    } catch { /* An unreadable package.json is treated like none. */ }
  }
  for (const folder of STATIC_ROOTS) {
    const root = path.join(directory, folder);
    if (existsSync(path.join(root, 'index.html'))) return { kind: 'static', root };
  }
  return null;
}

function appEnvironment(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (INHERITED_ENV.test(key) && value !== undefined) env[key] = value;
  return { ...env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', STUDIO_APP: '1' };
}

/**
 * Used by the Studio apps routes and the app gateway to run the apps Studio's AI builds made: each one starts on a
 * free loopback port when its 主页 opens (npm start, node main, or Studio serving its static files), stops after
 * half an hour unused, and restarts when the repository has a newer commit than the running code. An app process
 * inherits only the basic environment (PATH, HOME, locale, proxy) plus PORT and HOST=127.0.0.1.
 */
export function createStudioAppRunner(deps: Dependencies = {}) {
  const spawnProcess = deps.spawnProcess ?? spawnDetached;
  const freePort = deps.freePort ?? findFreePort;
  const waitReady = deps.waitReady ?? waitForHttp;
  const readHead = deps.readHead ?? gitHead;
  const now = deps.now ?? Date.now;
  const idleStopMs = deps.idleStopMs ?? IDLE_STOP_MS;
  const apps = new Map<string, AppProcess>();

  function record(key: string, directory: string): AppProcess {
    let app = apps.get(key);
    if (!app || app.directory !== directory) {
      if (app) stopProcess(app);
      app = { state: 'stopped', entry: null, directory, port: null, child: null, head: null, startedAt: null, lastUsedAt: now(), error: null, log: [], starting: null };
      apps.set(key, app);
    }
    return app;
  }

  function appendLog(app: AppProcess, chunk: Buffer) {
    const lines = chunk.toString('utf8').split(/\r?\n/).filter(line => line.trim());
    app.log = [...app.log, ...lines].slice(-LOG_LINES);
  }

  function stopProcess(app: AppProcess) {
    const child = app.child;
    app.child = null;
    app.port = null;
    app.startedAt = null;
    if (app.state === 'running' || app.state === 'starting') app.state = 'stopped';
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    const signalGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid!, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    signalGroup('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null) signalGroup('SIGKILL'); }, KILL_GRACE_MS);
    timer.unref();
  }

  async function start(app: AppProcess) {
    stopProcess(app);
    app.state = 'starting';
    app.error = null;
    app.log = [];
    app.head = await readHead(app.directory);
    const entry = detectAppEntry(app.directory);
    app.entry = entry;
    if (!entry) {
      app.state = 'failed';
      app.error = '没有找到启动方式：需要 package.json 的 start 脚本、main 文件，或 index.html';
      return;
    }
    if (entry.kind === 'static') {
      app.state = 'running';
      app.startedAt = now();
      return;
    }
    const port = await freePort();
    const [command, args] = entry.kind === 'npm' ? ['npm', ['start', '--silent']] : [process.execPath, [entry.file]];
    const child = spawnProcess(command, args, { cwd: app.directory, env: appEnvironment(port) });
    app.child = child;
    app.port = port;
    child.stdout?.on('data', (chunk: Buffer) => appendLog(app, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendLog(app, chunk));
    const controller = new AbortController();
    const exited = new Promise<never>((_, reject) => {
      child.once('exit', code => {
        controller.abort();
        if (app.child === child) {
          app.child = null;
          app.port = null;
          if (app.state === 'running' || app.state === 'starting') {
            app.state = 'failed';
            app.error = `应用已退出（退出码 ${code ?? '未知'}）`;
          }
        }
        reject(new Error('exited'));
      });
      child.once('error', error => {
        controller.abort();
        if (app.child === child) { app.child = null; app.port = null; app.state = 'failed'; app.error = `无法启动：${error.message}`; }
        reject(error);
      });
    });
    exited.catch(() => undefined);
    try {
      await Promise.race([waitReady(port, controller.signal), exited]);
      if (app.child !== child) return;
      app.state = 'running';
      app.startedAt = now();
      app.lastUsedAt = now();
    } catch {
      if (app.child === child) {
        stopProcess(app);
        app.state = 'failed';
        app.error = `应用没有在 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒内响应：它需要监听环境变量 PORT 给的端口`;
      }
    }
  }

  // Starts the app (or joins the start in flight) unless it already runs the repository's latest commit.
  async function ensure(key: string, directory: string, options: { restart?: boolean } = {}) {
    const app = record(key, directory);
    app.lastUsedAt = now();
    if (app.starting) { await app.starting; return app; }
    const stale = app.state === 'running' && (options.restart || (await readHead(directory)) !== app.head);
    if (app.state !== 'running' || stale) {
      app.starting = start(app).finally(() => { app.starting = null; });
      await app.starting;
    }
    return app;
  }

  function statusOf(app: AppProcess | undefined): StudioAppStatus {
    if (!app) return { state: 'stopped', error: null, log: [], startedAt: null, kind: null };
    return {
      state: app.state, error: app.error, log: app.state === 'failed' ? app.log : [],
      startedAt: app.startedAt ? new Date(app.startedAt).toISOString() : null, kind: app.entry?.kind ?? null,
    };
  }

  const sweeper = setInterval(() => {
    for (const app of apps.values()) {
      if (app.state === 'running' && app.child && now() - app.lastUsedAt > idleStopMs) stopProcess(app);
    }
  }, IDLE_SWEEP_MS);
  sweeper.unref();

  return {
    /** Starts the app if needed (restarting it for a newer commit, or when asked) and returns its status. */
    async open(key: string, directory: string, options: { restart?: boolean } = {}): Promise<StudioAppStatus> {
      return statusOf(await ensure(key, directory, options));
    },
    status(key: string): StudioAppStatus {
      return statusOf(apps.get(key));
    },
    stop(key: string): StudioAppStatus {
      const app = apps.get(key);
      if (app) { stopProcess(app); app.state = 'stopped'; }
      return statusOf(app);
    },
    /**
     * Where the gateway sends a request for the app, starting it again when it was stopped meanwhile (idle, or the
     * server restarted); marks it used. Throws when it cannot run.
     */
    async target(key: string, directory: string): Promise<{ kind: 'proxy'; port: number } | { kind: 'static'; root: string }> {
      const app = record(key, directory);
      app.lastUsedAt = now();
      if (app.state !== 'running' && !app.starting) await ensure(key, directory);
      else if (app.starting) await app.starting;
      if (app.state === 'running' && app.entry?.kind === 'static') return { kind: 'static', root: app.entry.root };
      if (app.state === 'running' && app.port) return { kind: 'proxy', port: app.port };
      throw new AppError(app.error ?? '应用没有在运行', { statusCode: 502, code: 'STUDIO_APP_NOT_RUNNING' });
    },
    /** Stops every app (server shutdown). */
    stopAll() {
      clearInterval(sweeper);
      for (const app of apps.values()) stopProcess(app);
    },
  };
}
