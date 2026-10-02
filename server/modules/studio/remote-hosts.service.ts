import { execFile, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { StudioRemoteHost, StudioRemoteLaunch, StudioRemoteStatus } from '@/shared/types.js';
import { AppError, isSafeRemoteDirectory, stripAnsiSequences } from '@/shared/utils.js';

type RemoteAgent = 'claude' | 'codex' | 'shell';

// One validated STUDIO_SSH_HOSTS entry; `dir` is '' when the host has no default project directory.
type RemoteHostEntry = StudioRemoteHost & { dir: string };

// The subset of child_process.execFile this service calls; tests pass a fake so no process is spawned.
type ExecFileFunction = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean; encoding: 'utf8' },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

type Dependencies = {
  // Raw STUDIO_SSH_HOSTS value: a JSON array of { name, label?, target, dir? }.
  hostsConfig?: string;
  execFile?: ExecFileFunction;
  now?: () => number;
  log?: (message: string) => void;
};

// Lower-case slug used in URLs, tmux session names and project configs.
const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// An ssh_config alias or user@host. It can never start with "-" or contain spaces, quotes or options.
const SSH_TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_HOSTS = 16;
const MAX_LABEL_LENGTH = 40;

const STATUS_TTL_MS = 60_000;
const STATUS_TIMEOUT_MS = 12_000;
const MAX_ERROR_LENGTH = 120;

// Non-login SSH sessions on Ubuntu do not have ~/.local/bin (where codex lives) on PATH.
const REMOTE_PATH_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';
// Read-only probe: prints one "<tool>=0|1" line per tool and always exits 0 when the shell is POSIX-like.
const STATUS_SCRIPT = `${REMOTE_PATH_EXPORT}; for t in claude codex tmux; do command -v "$t" >/dev/null && echo "$t=1" || echo "$t=0"; done`;
// BatchMode never prompts (unknown host keys and missing keys fail fast); -T because the probe needs no TTY.
const STATUS_SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
// Interactive sessions force a TTY and survive short network stalls (about one minute of silence).
const SESSION_SSH_OPTIONS = ['-tt', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

// Separate config dirs keep Studio's logins on the host apart from anything the host owner already uses.
const AGENT_LAUNCHES: Record<RemoteAgent, { title: string; program: string | null; configDir: string | null; run: string }> = {
  claude: { title: 'Claude Code', program: 'claude', configDir: '$HOME/.studio/claude', run: 'CLAUDE_CONFIG_DIR="$HOME/.studio/claude" exec claude' },
  codex: { title: 'Codex', program: 'codex', configDir: '$HOME/.studio/codex', run: 'CODEX_HOME="$HOME/.studio/codex" exec codex' },
  shell: { title: '终端', program: null, configDir: null, run: 'exec "$SHELL" -l' },
};

function fail(message: string, statusCode: number, code: string): never {
  throw new AppError(message, { statusCode, code });
}

// POSIX single quoting: the only character that needs care inside '...' is the quote itself.
function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Returns the entry, or a short reason (never echoing unvalidated input) why it is skipped.
function readEntry(item: unknown, taken: Set<string>): RemoteHostEntry | string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'not an object';
  const { name, label, target, dir } = item as Record<string, unknown>;
  if (typeof name !== 'string' || !HOST_NAME.test(name)) return 'invalid name (expected ^[a-z0-9][a-z0-9-]{0,31}$)';
  if (taken.has(name)) return `duplicate name "${name}"`;
  if (typeof target !== 'string' || target.length > 255 || !SSH_TARGET.test(target)) return `invalid target for "${name}" (expected an ssh alias or user@host)`;
  if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_LENGTH || CONTROL_CHARACTERS.test(label))) {
    return `invalid label for "${name}"`;
  }
  if (dir !== undefined && dir !== '' && (typeof dir !== 'string' || !isSafeRemoteDirectory(dir))) return `invalid dir for "${name}"`;
  return { name, label: typeof label === 'string' ? label.trim() : name, target, dir: typeof dir === 'string' ? dir : '' };
}

// Invalid configuration never stops the server: bad entries are logged and skipped.
function parseRegistry(raw: string | undefined, log: (message: string) => void) {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log('STUDIO_SSH_HOSTS is not valid JSON; no remote hosts are configured');
    return [];
  }
  if (!Array.isArray(parsed)) {
    log('STUDIO_SSH_HOSTS must be a JSON array; no remote hosts are configured');
    return [];
  }
  const entries: RemoteHostEntry[] = [];
  const taken = new Set<string>();
  parsed.forEach((item, index) => {
    const entry = entries.length >= MAX_HOSTS ? `more than ${MAX_HOSTS} hosts` : readEntry(item, taken);
    if (typeof entry === 'string') {
      log(`STUDIO_SSH_HOSTS entry #${index + 1} skipped: ${entry}`);
      return;
    }
    taken.add(entry.name);
    entries.push(entry);
  });
  return entries;
}

function parseTools(stdout: string) {
  const found = new Map<string, boolean>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(claude|codex|tmux)=([01])$/.exec(line.trim());
    if (match) found.set(match[1], match[2] === '1');
  }
  return {
    tools: { claude: found.get('claude') ?? false, codex: found.get('codex') ?? false, tmux: found.get('tmux') ?? false },
    complete: found.size === 3,
  };
}

// The last stderr line usually names the cause; it is flattened and cut so raw output never reaches the UI.
function lastStderrLine(stderr: string) {
  const lines = stripAnsiSequences(stderr).split(/\r?\n/)
    .map(line => line.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const line = lines.at(-1) ?? '';
  const room = MAX_ERROR_LENGTH - 'SSH 连接失败：'.length;
  return line.length > room ? `${line.slice(0, room - 1)}…` : line;
}

function describeConnectionFailure(error: ExecFileException, stderr: string) {
  if (error.code === 'ENOENT') return '本机没有可用的 ssh 命令';
  if (error.killed || error.signal) return '连接超时';
  const text = stderr.toLowerCase();
  if (text.includes('permission denied')) return 'SSH 认证失败（密钥未被远程主机接受）';
  if (text.includes('host key verification failed') || text.includes('remote host identification has changed')) return '主机密钥校验失败';
  if (text.includes('could not resolve hostname')) return '无法解析主机名';
  if (text.includes('connection refused')) return '连接被拒绝';
  if (text.includes('timed out')) return '连接超时';
  if (text.includes('no route to host') || text.includes('network is unreachable')) return '网络不可达';
  const line = lastStderrLine(stderr);
  return line ? `SSH 连接失败：${line}` : 'SSH 连接失败';
}

/**
 * Used by studio.module: the owner-configured SSH host registry (from STUDIO_SSH_HOSTS), feeding the project hub's
 * remoteHosts/remoteSeeds/remoteCommand dependencies and the /api/studio/remote routes.
 */
export function createRemoteHostsService({
  hostsConfig,
  execFile: runExecFile = execFile,
  now = Date.now,
  log = message => console.warn(`[studio] ${message}`),
}: Dependencies = {}) {
  const entries = parseRegistry(hostsConfig, log);
  const cache = new Map<string, { at: number; value: StudioRemoteStatus }>();
  const pending = new Map<string, Promise<StudioRemoteStatus>>();

  function find(name: string) {
    const entry = entries.find(item => item.name === name);
    if (!entry) fail('远程主机未在服务器配置中', 404, 'REMOTE_HOST_NOT_FOUND');
    return entry;
  }

  // Never rejects: every failure becomes an offline status with a short, safe message.
  function probe(entry: RemoteHostEntry) {
    const started = now();
    return new Promise<StudioRemoteStatus>(resolve => {
      const finish = (error: ExecFileException | null, stdout: string, stderr: string) => {
        const checkedAt = new Date(now()).toISOString();
        const { tools, complete } = parseTools(stdout ?? '');
        // ssh exits 255 for its own failures; spawn errors and timeouts carry no numeric exit code.
        if (error && (typeof error.code !== 'number' || error.code === 255 || error.killed)) {
          resolve({ name: entry.name, online: false, latencyMs: null, checkedAt, tools: { claude: false, codex: false, tmux: false }, error: describeConnectionFailure(error, stderr ?? '') });
          return;
        }
        const status: StudioRemoteStatus = { name: entry.name, online: true, latencyMs: Math.max(0, now() - started), checkedAt, tools };
        if (error) status.error = '远程检查命令执行失败（登录 shell 需兼容 POSIX）';
        else if (!complete) status.error = '远程主机返回了无法识别的检查结果';
        resolve(status);
      };
      try {
        // No shell on this side: the target is one argv entry after "--", and the probe script is fixed.
        runExecFile('ssh', [...STATUS_SSH_OPTIONS, '--', entry.target, STATUS_SCRIPT], {
          timeout: STATUS_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8',
        }, finish);
      } catch (error) {
        finish(error as ExecFileException, '', '');
      }
    });
  }

  return {
    hosts(): StudioRemoteHost[] {
      return entries.map(({ name, label, target }) => ({ name, label, target }));
    },
    names() {
      return entries.map(entry => entry.name);
    },
    // Hosts with a default directory become built-in projects in the hub, in the shape its remoteSeeds dep expects.
    seeds() {
      return entries.filter(entry => entry.dir).map(entry => ({ host: entry.name, label: entry.label, dir: entry.dir }));
    },
    // Cached for a minute and single-flight per host, so polling clients never stack SSH logins on the host.
    async status(name: string) {
      const entry = find(name);
      const hit = cache.get(name);
      if (hit && now() - hit.at < STATUS_TTL_MS) return hit.value;
      const running = pending.get(name);
      if (running) return running;
      const request = probe(entry).then(value => {
        cache.set(name, { at: now(), value });
        pending.delete(name);
        return value;
      });
      pending.set(name, request);
      return request;
    },
    /**
     * The exact line the local terminal runs with `bash -c`. Only registry targets, validated directories and the
     * three fixed agents can appear in it; the whole remote script is one single-quoted ssh argument.
     */
    command(host: string, dir: string, agent: RemoteAgent): StudioRemoteLaunch {
      const entry = find(host);
      if (!isSafeRemoteDirectory(dir)) fail('远程目录无效', 400, 'REMOTE_DIR_INVALID');
      if (agent !== 'claude' && agent !== 'codex' && agent !== 'shell') fail('远程会话只支持 Claude Code、Codex 或终端', 400, 'REMOTE_AGENT_INVALID');
      const launch = AGENT_LAUNCHES[agent];
      // One tmux session per agent and directory: reopening reattaches instead of starting a second agent.
      const session = `studio-${agent}-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
      // `dir` stays unquoted so a leading "~" expands; isSafeRemoteDirectory guarantees it has no shell syntax.
      const steps = [REMOTE_PATH_EXPORT, `cd ${dir} || exit 1`];
      if (launch.configDir) steps.push(`mkdir -p "${launch.configDir}"`);
      if (launch.program) steps.push(`command -v ${launch.program} >/dev/null 2>&1 || { echo "远程主机上找不到 ${launch.program}，请先安装" >&2; exit 127; }`);
      // A tmux server started elsewhere keeps its own PATH, so the session command re-exports it.
      const tmuxCommand = shellQuote(`${REMOTE_PATH_EXPORT}; ${launch.run}`);
      steps.push(`if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${session} -c "$PWD" ${tmuxCommand}; else ${launch.run}; fi`);
      return {
        command: ['ssh', ...SESSION_SSH_OPTIONS, '--', entry.target, shellQuote(steps.join('; '))].join(' '),
        title: `${launch.title} · ${entry.label}`,
      };
    },
  };
}
