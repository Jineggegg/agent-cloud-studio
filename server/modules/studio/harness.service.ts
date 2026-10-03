import fsp from 'node:fs/promises';
import path from 'node:path';

import { isRecordedProcessAlive } from '@/shared/utils.js';

// Which side of the computer an agent runs on: WSL (where Studio itself runs) or the Windows host.
type HarnessMachine = 'wsl' | 'windows';
type HarnessProvider = 'claude' | 'codex';

/**
 * One Claude Code or Codex session on this computer, as the Harness app lists it. `running` is mid-turn now; `idle` is
 * a Claude Code session still open but waiting for its owner; `done` is a Codex task that finished recently.
 */
type HarnessTask = {
  id: string;
  provider: HarnessProvider;
  machine: HarnessMachine;
  sessionId: string;
  title: string;
  directory: string | null;
  client: string | null;
  state: 'running' | 'idle' | 'done';
  startedAt: string | null;
  updatedAt: string | null;
  summary: string | null;
  href: string | null;
};

type HarnessHome = { machine: HarnessMachine; home: string };

// Per-poll bounds: a directory full of stale files must not turn every poll into unbounded work (the Windows side is
// read over WSL's slow 9p mount).
const MAX_CLAUDE_REGISTRY_FILES = 256;
const MAX_CODEX_FILES = 40;
// How much of a Codex rollout's start and end is read: its session_meta line, and its latest turn events.
const CODEX_HEAD_BYTES = 64 * 1024;
const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_INDEX_TAIL_BYTES = 256 * 1024;
// A turn whose transcript has not moved for this long is no longer believed to run (a crash leaves the "busy"
// status or the open turn behind). Windows pids cannot be checked from WSL, so there this is the only signal.
const RUNNING_FRESH_MS = 30 * 60_000;
// Open Claude sessions untouched for this long, and Codex tasks finished longer ago, drop off the list.
const IDLE_WINDOW_MS = 12 * 3_600_000;
const DONE_WINDOW_MS = 3 * 3_600_000;
// The iPad polls every few seconds; one scan serves every poll in this window.
const CACHE_MS = 4_000;
const SUMMARY_LIMIT = 160;

// The app a session runs in, from Claude's `entrypoint` and Codex's `originator`.
const CLAUDE_CLIENTS: Record<string, string> = {
  'claude-desktop': '桌面版', cli: '终端', 'claude-vscode': 'VS Code', 'sdk-ts': 'SDK', 'sdk-py': 'SDK',
};
const CODEX_CLIENTS: Record<string, string> = {
  codex_work_desktop: '桌面版', 'Codex Desktop': '桌面版', codex_cli_rs: '终端', codex_vscode: 'VS Code', codex_exec: '后台',
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const iso = (ms: number | null) => ms !== null && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
const mtimeOf = (file: string) => fsp.stat(file).then(info => info.mtimeMs, () => null);

function parseLine(line: string): Json | null {
  try { return record(JSON.parse(line)); } catch { return null; }
}

// Reads `length` bytes of `file` from `position` (clamped to the file), as text.
async function readSlice(file: string, position: number, length: number): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, position));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

// The complete lines in the last `bytes` of `file` (the first, cut-off line is dropped unless the file is shorter).
async function tailLines(file: string, size: number, bytes: number): Promise<string[]> {
  const chunk = await readSlice(file, size - bytes, Math.min(size, bytes));
  const lines = chunk.split('\n');
  if (size > bytes) lines.shift();
  return lines.filter(Boolean);
}

/**
 * A working directory as WSL sees it: the Windows apps record WSL folders as `\\wsl.localhost\<distro>\home\…`, which
 * becomes `/home/…`; the home folder reads as `~`. Windows paths otherwise stay as they are.
 */
function displayDirectory(cwd: string, linuxHome: string): string | null {
  if (!cwd) return null;
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)?$/i.exec(cwd);
  const posix = unc ? (unc[1] ?? '\\').replace(/\\/g, '/') : cwd;
  if (posix === linuxHome) return '~';
  return posix.startsWith(`${linuxHome}/`) ? `~${posix.slice(linuxHome.length)}` : posix;
}

// Claude Code's transcript folder for a working directory: every character that is not a letter or digit becomes '-'.
const claudeProjectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// A Codex reply is markdown: links keep their text, list markers and emphasis go, lines run together.
function trimSummary(value: string): string | null {
  const plain = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*`#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  return plain.length > SUMMARY_LIMIT ? `${plain.slice(0, SUMMARY_LIMIT - 1)}…` : plain;
}

type ScanContext = { now: number; linuxHome: string; studioRuns: Set<string>; href: (sessionId: string) => string | null };

// Claude Code: one registry file per open session (`<pid>.json`, status busy or idle), its transcript beside it.
async function scanClaude({ machine, home }: HarnessHome, context: ScanContext): Promise<HarnessTask[]> {
  const registry = path.join(home, '.claude', 'sessions');
  const entries = await fsp.readdir(registry).catch(() => [] as string[]);
  const tasks = await Promise.all(entries.filter(entry => entry.endsWith('.json')).slice(0, MAX_CLAUDE_REGISTRY_FILES).map(async (entry): Promise<HarnessTask | null> => {
    const data = parseLine(await fsp.readFile(path.join(registry, entry), 'utf8').catch(() => ''));
    const sessionId = text(data?.sessionId);
    const pid = typeof data?.pid === 'number' ? data.pid : NaN;
    if (!data || !sessionId || !Number.isInteger(pid) || pid <= 0) return null;
    // Only this machine's pids can be probed; a Windows entry stands on how recently its transcript moved.
    if (machine === 'wsl' && !(await isRecordedProcessAlive(pid, data.procStart))) return null;
    const cwd = text(data.cwd);
    const transcriptAt = cwd ? await mtimeOf(path.join(home, '.claude', 'projects', claudeProjectFolder(cwd), `${sessionId}.jsonl`)) : null;
    const updatedAt = Math.max(Number(data.updatedAt) || 0, transcriptAt ?? 0) || null;
    const age = updatedAt === null ? Infinity : context.now - updatedAt;
    const running = data.status === 'busy' && (machine === 'wsl' || age < RUNNING_FRESH_MS);
    if (!running && age > IDLE_WINDOW_MS) return null;
    const studio = machine === 'wsl' && context.studioRuns.has(sessionId);
    return {
      id: `claude:${machine}:${sessionId}`, provider: 'claude', machine, sessionId,
      title: text(data.name).trim() || path.basename(displayDirectory(cwd, context.linuxHome) ?? '') || '新会话',
      directory: displayDirectory(cwd, context.linuxHome),
      client: studio ? 'Studio' : CLAUDE_CLIENTS[text(data.entrypoint)] ?? null,
      state: running ? 'running' : 'idle',
      startedAt: iso(running ? Number(data.statusUpdatedAt) || Number(data.startedAt) : Number(data.startedAt)),
      updatedAt: iso(updatedAt), summary: null,
      href: machine === 'wsl' ? context.href(sessionId) : null,
    };
  }));
  return tasks.filter((task): task is HarnessTask => task !== null);
}

// The latest name of each Codex thread, from the tail of session_index.jsonl (one line per rename).
async function codexThreadNames(home: string): Promise<Map<string, string>> {
  const file = path.join(home, '.codex', 'session_index.jsonl');
  const names = new Map<string, string>();
  try {
    const { size } = await fsp.stat(file);
    for (const line of await tailLines(file, size, CODEX_INDEX_TAIL_BYTES)) {
      const item = parseLine(line);
      if (item && text(item.id) && text(item.thread_name).trim()) names.set(text(item.id), text(item.thread_name).trim());
    }
  } catch { /* No index: threads fall back to their folder name. */ }
  return names;
}

// The day folders (sessions/YYYY/MM/DD) a recent rollout can be in: today and the two days before, by local date.
function codexDayFolders(root: string, now: number): string[] {
  return [0, 1, 2].map(daysBack => {
    const day = new Date(now - daysBack * 86_400_000);
    return path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  });
}

// Codex: one rollout file per thread; a turn runs from `task_started` until `task_complete` or `turn_aborted`.
async function scanCodex({ machine, home }: HarnessHome, context: ScanContext): Promise<HarnessTask[]> {
  const root = path.join(home, '.codex', 'sessions');
  const files: { file: string; size: number; mtime: number }[] = [];
  for (const folder of codexDayFolders(root, context.now)) {
    const entries = await fsp.readdir(folder).catch(() => [] as string[]);
    await Promise.all(entries.filter(entry => entry.startsWith('rollout-') && entry.endsWith('.jsonl')).map(async entry => {
      const file = path.join(folder, entry);
      const info = await fsp.stat(file).catch(() => null);
      if (info && context.now - info.mtimeMs <= DONE_WINDOW_MS) files.push({ file, size: info.size, mtime: info.mtimeMs });
    }));
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const names = files.length ? await codexThreadNames(home) : new Map<string, string>();
  const tasks = await Promise.all(files.slice(0, MAX_CODEX_FILES).map(async ({ file, size, mtime }): Promise<HarnessTask | null> => {
    try {
      const head = await readSlice(file, 0, Math.min(size, CODEX_HEAD_BYTES));
      const meta = record(parseLine(head.split('\n')[0] ?? '')?.payload);
      // Sub-agents' rollouts belong to their parent's task.
      const source = record(meta?.source);
      if (meta?.thread_source === 'subagent' || (source && 'subagent' in source)) return null;
      const sessionId = text(meta?.id) || /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(file)?.[1] || '';
      if (!sessionId) return null;
      let started: Json | null = null;
      let finished: Json | null = null;
      let startedAtLine: string | null = null;
      for (const line of (await tailLines(file, size, CODEX_TAIL_BYTES)).reverse()) {
        if (!line.includes('"event_msg"') || !/"type":"(task_started|task_complete|turn_aborted)"/.test(line)) continue;
        const event = parseLine(line);
        const payload = record(event?.payload);
        if (!payload) continue;
        if (payload.type === 'task_started') { started = payload; startedAtLine = text(event?.timestamp); }
        else finished = payload;
        break;
      }
      const running = started !== null && context.now - mtime < RUNNING_FRESH_MS;
      if (!running && context.now - mtime > DONE_WINDOW_MS) return null;
      const cwd = text(meta?.cwd);
      const directory = displayDirectory(cwd, context.linuxHome);
      const startedAt = started ? (Number(started.started_at) * 1000 || Date.parse(startedAtLine ?? '') || null) : null;
      const studio = machine === 'wsl' && context.studioRuns.has(sessionId);
      return {
        id: `codex:${machine}:${sessionId}`, provider: 'codex', machine, sessionId,
        title: names.get(sessionId) || path.basename(directory ?? '').replace(/^~$/, '') || '新任务',
        directory,
        client: studio ? 'Studio' : CODEX_CLIENTS[text(meta?.originator)] ?? null,
        state: running ? 'running' : 'done',
        startedAt: iso(startedAt), updatedAt: iso(mtime),
        summary: !running && finished ? trimSummary(text(finished.last_agent_message)) : null,
        href: machine === 'wsl' ? context.href(sessionId) : null,
      };
    } catch {
      // A rollout that vanished or cannot be read mid-poll is simply left out.
      return null;
    }
  }));
  return tasks.filter((task): task is HarnessTask => task !== null);
}

/**
 * Used by studio.module for the Harness app (GET /api/studio/harness/tasks): the Claude Code and Codex sessions on this
 * computer, on both sides of WSL (`homes`: WSL's home and, when found, the Windows user's), including ones started
 * outside Studio — Claude's per-session registry and transcripts, Codex's rollout files. Only ever reads those files.
 * `studioRuns` names the sessions Studio's own chat runs are driving; `href` links a WSL session to the workbench.
 */
export function createHarnessService({ homes, linuxHome, studioRuns, href, now = () => Date.now() }: {
  homes: HarnessHome[];
  linuxHome: string;
  studioRuns: () => Promise<Set<string>>;
  href: (sessionId: string) => string | null;
  now?: () => number;
}) {
  let cached: { at: number; result: Promise<{ tasks: HarnessTask[]; machines: HarnessMachine[]; checkedAt: string }> } | null = null;

  async function scan() {
    const at = now();
    const context: ScanContext = { now: at, linuxHome, studioRuns: await studioRuns().catch(() => new Set<string>()), href };
    const found = await Promise.all(homes.flatMap(home => [scanClaude(home, context), scanCodex(home, context)]));
    const order = { running: 0, idle: 1, done: 2 } as const;
    const tasks = found.flat().sort((a, b) => order[a.state] - order[b.state]
      || (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
    return { tasks, machines: homes.map(home => home.machine), checkedAt: new Date(at).toISOString() };
  }

  return {
    tasks() {
      if (!cached || now() - cached.at >= CACHE_MS) {
        const result = scan();
        cached = { at: now(), result };
        // A failed scan is not served from the cache.
        result.catch(() => { if (cached?.result === result) cached = null; });
      }
      return cached.result;
    },
  };
}
