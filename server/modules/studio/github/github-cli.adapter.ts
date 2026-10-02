import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StudioGhExecFile, StudioGhResult, StudioGhRun } from '@/shared/types.js';

// gh api returns whole GraphQL documents; 8 MiB is far above an inbox of 150 pull requests.
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
// Commands beyond the running ones wait in line; past this many the request is refused instead of piling up.
const MAX_WAITING = 24;
// Where gh is usually installed when the server's PATH (systemd, non-login shells) lacks ~/.local/bin.
const INSTALL_LOCATIONS = (home: string) => [
  path.join(home, '.local', 'bin', 'gh'),
  '/usr/local/bin/gh',
  '/usr/bin/gh',
  '/opt/homebrew/bin/gh',
  '/home/linuxbrew/.linuxbrew/bin/gh',
];

// Every gh process: never prompts, no colour, pager, spinner, browser or update check. GH_DEBUG/DEBUG are
// removed because gh's debug logging prints request details that never belong in Studio's logs or responses.
// The stored login (hosts.yml or the keyring) is found through HOME, which is inherited unchanged.
function ghEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    GH_PAGER: 'cat',
    PAGER: 'cat',
    GH_BROWSER: 'false',
    BROWSER: 'false',
    NO_COLOR: '1',
    CLICOLOR: '0',
  };
  delete env.GH_DEBUG;
  delete env.DEBUG;
  return env;
}

/**
 * Used by studio.module to locate gh: an absolute STUDIO_GH_PATH wins, then the usual install locations
 * (~/.local/bin first, where this machine keeps it), then a plain `gh` looked up on PATH by execFile.
 * A relative STUDIO_GH_PATH is ignored with a warning, since it would resolve against the server's cwd.
 */
export function resolveGhPath(configured: string | undefined, {
  home = os.homedir(),
  exists = existsSync,
  log = (message: string) => console.warn(`[studio] ${message}`),
}: { home?: string; exists?: (file: string) => boolean; log?: (message: string) => void } = {}) {
  const explicit = configured?.trim();
  if (explicit) {
    if (path.isAbsolute(explicit)) return explicit;
    log('STUDIO_GH_PATH must be an absolute path; looking for gh in the usual places instead');
  }
  return INSTALL_LOCATIONS(home).find(candidate => exists(candidate)) ?? 'gh';
}

/**
 * Used by studio.module (and the GitHub service tests through their own fake) to run gh: execFile with an exact
 * argv and no shell, a per-command timeout, a neutral working directory (so gh never picks up a local checkout)
 * and at most `maxConcurrent` processes at once. The returned function never rejects; see StudioGhResult.
 */
export function createGhRunner({
  execFile: runExecFile = execFile as unknown as StudioGhExecFile,
  ghPath = 'gh',
  maxConcurrent = 3,
  env = process.env,
  cwd = os.tmpdir(),
}: {
  execFile?: StudioGhExecFile;
  ghPath?: string;
  maxConcurrent?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): StudioGhRun {
  const environment = ghEnvironment(env);
  let running = 0;
  const waiting: Array<() => void> = [];

  // A finished command hands its slot straight to the next waiter, so a newcomer can never squeeze in between
  // and push the count past the limit.
  function release() {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }

  function invoke(args: string[], timeoutMs: number, maxBuffer: number) {
    return new Promise<StudioGhResult>(resolve => {
      const finish: Parameters<StudioGhExecFile>[3] = (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout: stdout ?? '' });
          return;
        }
        const output = { stdout: stdout ?? '', stderr: stderr ?? '' };
        if (error.code === 'ENOENT') resolve({ ok: false, reason: 'missing', ...output, exitCode: null });
        else if (error.killed || error.signal) resolve({ ok: false, reason: 'timeout', ...output, exitCode: null });
        else resolve({ ok: false, reason: 'failed', ...output, exitCode: typeof error.code === 'number' ? error.code : null });
      };
      try {
        runExecFile(ghPath, args, { cwd, env: environment, timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8' }, finish);
      } catch (error) {
        // Synchronous spawn failures (EAGAIN, invalid arguments) arrive here rather than in the callback.
        finish(error as Error & { code?: string }, '', '');
      }
    });
  }

  return async (args, { timeoutMs, maxBuffer = DEFAULT_MAX_BUFFER }) => {
    if (running < maxConcurrent) running += 1;
    else if (waiting.length >= MAX_WAITING) return { ok: false, reason: 'busy', stdout: '', stderr: '', exitCode: null };
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await invoke(args, timeoutMs, maxBuffer);
    } finally {
      release();
    }
  };
}
