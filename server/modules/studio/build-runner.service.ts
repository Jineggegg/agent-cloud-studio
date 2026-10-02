import { accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
  StudioBuildEnvironment,
  StudioBuildOutcome,
  StudioBuildRunner,
  StudioBuildTodo,
} from '@/shared/types.js';

/*
 * Unattended Claude Code turns for App Store-style AI builds.
 *
 * Permission policy (documented here because this file enforces it; the owner-facing version is docs/ai-builds.md):
 * - Deny by default. Every tool call of a build turn — the agent's and its sub-agents' — is decided by
 *   `evaluateBuildPermission` in a PreToolUse hook (`buildIsolation.reviewToolUse`, applied by the Claude runtime),
 *   which runs before Claude Code's own rules and auto-approvals and either allows or denies outright. The turn
 *   loads no settings files and no MCP servers, so allow rules, hooks or MCP servers in the owner's or the project's
 *   Claude configuration cannot widen it. Plan mode and `bypassPermissions` are never used.
 * - File tools (Read, Glob, Grep, Write, Edit, MultiEdit, NotebookEdit) pass only when every path-like field
 *   resolves, through symlinks, inside the build folder. Writes are also refused for agent, git and editor control
 *   files anywhere in it (.claude/, .codex/, .mcp.json, .git/, .vscode/, .idea/, .husky/), so the agent cannot grant
 *   itself permissions, hooks or MCP servers for a later turn (the owner continuing in the workbench included).
 * - WebFetch and WebSearch are removed from build turns; MCP tools, skills, worktrees, Monitor and every other tool
 *   not named here are refused. AskUserQuestion and plan mode are refused with "decide by yourself" guidance.
 * - Bash depends on the environment (`detectBuildEnvironment`):
 *   · `sandbox` (bubblewrap and socat installed on Linux, or macOS): commands run inside Claude Code's OS sandbox
 *     with `failIfUnavailable` and no escape hatch: writes only inside the build folder (minus the control files),
 *     nothing of the home directory readable except toolchains and the folder itself, network only to package
 *     registries. Any command is then allowed, because the sandbox, not this file, is the boundary.
 *   · `restricted` (anything else): no shell syntax is trusted. A command must be a plain argument vector — letters,
 *     digits, spaces and `. _ - / : = + , @ %` only, so no quoting, expansion, globbing, redirection or chaining can
 *     survive — naming one of a few programs that cannot run code (ls, cat, mkdir, rm, mv, cp, git init/status/
 *     diff/log/add/commit …), with every path argument inside the folder. No installs, no tests, no network; the
 *     composer and docs tell the owner that full builds need `sudo apt-get install -y bubblewrap socat`.
 * - Should a prompt still reach the runtime (a hook that did not apply), this runner answers it at once with the
 *   same policy instead of letting it wait 55 seconds, and without notifying the owner.
 */

type PermissionVerdict = { allow: true } | { allow: false; reason: string };

const allow = (): PermissionVerdict => ({ allow: true });
const deny = (reason: string): PermissionVerdict => ({ allow: false, reason });

//----------------- ENVIRONMENT ------------

// Programs Claude Code's sandbox needs on Linux, with the Debian/Ubuntu package that provides each.
const LINUX_SANDBOX_PROGRAMS = [{ program: 'bwrap', pkg: 'bubblewrap' }, { program: 'socat', pkg: 'socat' }];

function onSearchPath(program: string, searchPath: string) {
  return searchPath.split(path.delimiter).some(directory => {
    // Relative PATH entries depend on the current directory and never count.
    if (!directory || !path.isAbsolute(directory)) return false;
    try {
      accessSync(path.join(directory, program), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Whether Claude Code's OS sandbox can run build commands on this machine: Linux needs bubblewrap and socat on
 * PATH, macOS ships Seatbelt, other platforms have no sandbox. A sandbox that is detected but fails to start makes
 * the turn fail (`failIfUnavailable`), never run unsandboxed.
 *
 * Used by builds.module (through the runner's `environment` dependency) and by this runner's tests.
 */
export function detectBuildEnvironment(platform: NodeJS.Platform = process.platform, searchPath = process.env.PATH ?? ''): StudioBuildEnvironment {
  if (platform === 'darwin') return { mode: 'sandbox', missing: [] };
  if (platform !== 'linux') return { mode: 'restricted', missing: [] };
  const missing = LINUX_SANDBOX_PROGRAMS.filter(entry => !onSearchPath(entry.program, searchPath)).map(entry => entry.pkg);
  return missing.length ? { mode: 'restricted', missing } : { mode: 'sandbox', missing: [] };
}

// Hosts sandboxed commands may reach: the npm and Python package registries (more via STUDIO_BUILD_EXTRA_DOMAINS).
const REGISTRY_DOMAINS = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org'];
// Toolchains installed under the home directory: the only parts of it a sandboxed command may read, besides the
// build folder. Claude Code's Bash tool also sources its shell snapshot from ~/.claude/shell-snapshots.
const HOME_TOOLCHAINS = [
  '.local/bin', '.local/lib', '.local/share/uv/python', '.local/share/pnpm', '.local/share/fnm', '.nvm', '.volta',
  '.bun', '.deno', '.pyenv', '.gitconfig', '.claude/shell-snapshots',
];
// Folder (inside the build folder, excluded from git) that sandboxed package managers cache into.
const BUILD_CACHE_DIR = '.studio-cache';

// Agent, git and editor control files: a write could grant permissions, hooks or MCP servers to a later turn.
const CONTROL_SEGMENTS = new Set(['.claude', '.codex', '.git', '.vscode', '.idea', '.husky']);
const CONTROL_FILES = new Set(['.mcp.json']);
// The same, as the sandbox's write denials; git itself must still write objects, refs and the index under .git.
const SANDBOX_DENY_WRITE = ['.claude', '.codex', '.mcp.json', '.vscode', '.idea', '.husky', '.git/hooks', '.git/config', '.git/info'];

function sandboxSettings(workspace: string, home: string, extraDomains: string[]) {
  return {
    enabled: true,
    // A sandbox that cannot start fails the turn instead of running commands without it.
    failIfUnavailable: true,
    // Every Bash call still goes through the policy hook; the sandbox parameter cannot opt a command out.
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [...REGISTRY_DOMAINS, ...extraDomains], allowLocalBinding: true },
    filesystem: {
      // Writes default to the working directory (the build folder) and the sandbox's own temp directory.
      denyWrite: SANDBOX_DENY_WRITE.map(entry => path.join(workspace, entry)),
      ...(home !== path.parse(home).root ? {
        denyRead: [home],
        allowRead: [workspace, ...HOME_TOOLCHAINS.map(entry => path.join(home, entry))],
      } : {}),
    },
  };
}

// Package-manager caches inside the build folder: the sandbox lets commands write nowhere else.
function cacheEnvironment(workspace: string) {
  const cache = path.join(workspace, BUILD_CACHE_DIR);
  return {
    npm_config_cache: path.join(cache, 'npm'), npm_config_store_dir: path.join(cache, 'pnpm'), YARN_CACHE_FOLDER: path.join(cache, 'yarn'),
    PIP_CACHE_DIR: path.join(cache, 'pip'), UV_CACHE_DIR: path.join(cache, 'uv'),
  };
}

// Keeps the cache folder out of `git add -A` through the repository's own exclude file (not a tracked .gitignore).
function excludeCacheFromGit(workspace: string) {
  const exclude = path.join(workspace, '.git', 'info', 'exclude');
  const entry = `/${BUILD_CACHE_DIR}/`;
  try {
    if (existsSync(exclude) && lstatSync(exclude).isSymbolicLink()) return;
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (current.split('\n').includes(entry)) return;
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${entry}\n`);
  } catch {
    // Best effort: without it the agent is still told to keep the cache out of its commit.
  }
}

// What the agent is told about the environment it runs in; the policy above enforces the same.
function environmentBrief(mode: StudioBuildEnvironment['mode']) {
  const shared = '- 不能修改 .claude/、.codex/、.git/ 里的配置和钩子、.mcp.json、.vscode/ 这类 agent 或编辑器配置；WebFetch 和 WebSearch 不可用。';
  if (mode === 'sandbox') {
    return [
      '运行环境（由服务器强制执行）：',
      '- 命令在沙箱里运行：只能写当前目录，网络只通向软件包仓库（npm、PyPI），读不到家目录里的其他文件。',
      `- 依赖装在项目里（npm 本地依赖；Python 用 uv 或 .venv）。包管理器的缓存在 ${BUILD_CACHE_DIR}/，已被 git 忽略，不要提交它。`,
      shared,
    ].join('\n');
  }
  return [
    '运行环境（由服务器强制执行）：',
    '- 这台服务器没有可用的沙箱，所以这次是受限模式：用 Read、Write、Edit、Glob、Grep 读写当前目录里的文件；命令行只允许 pwd、ls、cat、head、tail、wc、mkdir、touch、rm、mv、cp，以及 git init / status / diff / log / add / commit。',
    '- 命令只能是最简单的形式：参数之间用空格分隔，不能有引号、$、通配符（* ?）、管道、重定向、&& 或分号。提交信息写成一个不含空格的词，例如 git commit -m first-version。',
    '- 不能安装依赖、不能运行代码或测试，也不能联网：把代码写完整，在 README 里写清楚怎样安装、运行和测试，提交到本地仓库，并在总结里说明哪些还没有运行验证过。',
    shared,
  ].join('\n');
}

//----------------- PATHS ------------

/**
 * The real path `candidate` names (relative to `base`), following every symlink of its existing part; the rest
 * does not exist yet (a file about to be written). Null for `~` paths, NUL bytes, and names that exist but cannot
 * be resolved (a dangling or looping link could point anywhere).
 */
function canonicalPath(candidate: string, base: string): string | null {
  if (!candidate || candidate.includes('\0') || candidate.startsWith('~')) return null;
  let current = path.resolve(base, candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      try {
        lstatSync(current);
        return null;
      } catch {
        // Really absent: resolve its parent instead.
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function realWorkspace(workspace: string) {
  try {
    return realpathSync.native(workspace);
  } catch {
    return path.resolve(workspace);
  }
}

type PathAccess = 'read' | 'write' | 'remove';

// Why `candidate` may not be used for `access` in the build folder `root` (a real path), or null when it may.
function pathRefusal(candidate: string, root: string, access: PathAccess): string | null {
  const real = canonicalPath(candidate, root);
  if (!real || (real !== root && !real.startsWith(`${root}${path.sep}`))) return `路径 ${candidate} 不在项目目录里`;
  if (access === 'read') return null;
  if (real === root) return access === 'remove' ? '不能删除项目目录本身' : '不能改写项目目录本身';
  const segments = path.relative(root, real).split(path.sep).map(segment => segment.toLowerCase());
  if (segments.some(segment => CONTROL_SEGMENTS.has(segment)) || CONTROL_FILES.has(segments[segments.length - 1])) {
    return `不能修改 agent、git 或编辑器的配置文件（${candidate}）`;
  }
  return null;
}

/**
 * Whether a glob pattern stays inside the folder it is matched in: no parent steps, home or backslash escapes, and
 * no brace alternative that starts over at the filesystem root. An absolute pattern is fine when its fixed leading
 * directories are inside the build folder.
 */
function globRefusal(pattern: string, root: string): string | null {
  const refusal = `匹配模式 ${pattern} 会超出项目目录`;
  if (pattern.includes('..') || pattern.includes('~') || pattern.includes('\\') || pattern.includes('\0') || /[{,]\s*\//.test(pattern)) return refusal;
  if (!pattern.startsWith('/')) return null;
  const firstMagic = pattern.search(/[*?[{]/);
  const fixed = firstMagic < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf('/', firstMagic) + 1);
  return pathRefusal(fixed || '/', root, 'read') ? refusal : null;
}

//----------------- TOOLS ------------

// Planning, checklist and background-task bookkeeping, and loading deferred tool schemas.
const BOOKKEEPING_TOOLS = new Set([
  'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'BashOutput',
  'KillShell', 'KillBash', 'ToolSearch',
]);
// Sub-agents: their own tool calls reach the same hook and the same policy.
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);
// File tools: the fields holding a path, the fields holding a glob, and whether they write.
const FILE_TOOLS: Record<string, { paths: string[]; globs: string[]; access: PathAccess }> = {
  Read: { paths: ['file_path'], globs: [], access: 'read' },
  NotebookRead: { paths: ['notebook_path'], globs: [], access: 'read' },
  LS: { paths: ['path'], globs: [], access: 'read' },
  Glob: { paths: ['path'], globs: ['pattern'], access: 'read' },
  Grep: { paths: ['path'], globs: ['glob'], access: 'read' },
  Write: { paths: ['file_path'], globs: [], access: 'write' },
  Edit: { paths: ['file_path'], globs: [], access: 'write' },
  MultiEdit: { paths: ['file_path'], globs: [], access: 'write' },
  NotebookEdit: { paths: ['notebook_path'], globs: [], access: 'write' },
};
// Any other string field whose name says it holds a path is checked like one (a newer tool version's extra field).
const PATH_LIKE_FIELD = /path|file|dir/i;

function fileToolRefusal(toolName: string, record: AnyRecord, root: string): string | null {
  const spec = FILE_TOOLS[toolName];
  for (const [field, value] of Object.entries(record)) {
    const isPath = spec.paths.includes(field) || (!spec.globs.includes(field) && PATH_LIKE_FIELD.test(field));
    if (!isPath && !spec.globs.includes(field)) continue;
    // An absent optional path means the build folder itself.
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') return `${field} 必须是路径`;
    const refusal = isPath ? pathRefusal(value, root, spec.access) : globRefusal(value, root);
    if (refusal) return refusal;
  }
  return null;
}

//----------------- RESTRICTED SHELL ------------

// The whole command must use only these characters: bash then splits it on spaces into exactly these words, with
// nothing quoted, expanded, globbed, redirected, chained or substituted.
const PLAIN_COMMAND = /^[\p{L}\p{N} ._\-/:=+,@%]+$/u;
const PLAIN_COMMAND_HINT = '受限模式只接受最简单的命令：参数用空格分隔，不能有引号、$、通配符、管道、重定向、&& 或分号';
const RESTRICTED_PROGRAM_LIST = 'pwd、ls、cat、head、tail、wc、mkdir、touch、rm、mv、cp、git init/status/diff/log/add/commit';

type CommandRule = (args: string[], check: (candidate: string, access: PathAccess) => string | null) => string | null;

/**
 * Checks `args` against allowed flags and treats every other word as a path. `values` are flags that take the next
 * word as a value (validated by its pattern) instead of a path.
 */
function argvRule(options: {
  flags?: RegExp;
  values?: Record<string, RegExp>;
  access: PathAccess;
  minOperands?: number;
  // The last operand of cp is written, the others only read.
  lastAccess?: PathAccess;
}): CommandRule {
  return (args, check) => {
    const operands: string[] = [];
    let flagsDone = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!flagsDone && arg === '--') { flagsDone = true; continue; }
      if (!flagsDone && arg.startsWith('-')) {
        const valuePattern = options.values?.[arg];
        if (valuePattern) {
          const value = args[index + 1];
          if (value === undefined || !valuePattern.test(value)) return `${arg} 的值无效`;
          index += 1;
          continue;
        }
        if (!options.flags?.test(arg)) return `受限模式不支持参数 ${arg}`;
        continue;
      }
      operands.push(arg);
    }
    if (operands.length < (options.minOperands ?? 0)) return '缺少要操作的文件';
    for (const [position, operand] of operands.entries()) {
      const access = position === operands.length - 1 && options.lastAccess ? options.lastAccess : options.access;
      const refusal = check(operand, access);
      if (refusal) return refusal;
    }
    return null;
  };
}

const COUNT = /^\d{1,7}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

// git subcommands that only inspect the repository or record the agent's own work, with the flags each may use.
const GIT_RULES: Record<string, CommandRule> = {
  init: (args, check) => {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-q' || arg === '--quiet') continue;
      if (arg === '-b' && BRANCH.test(args[index + 1] ?? '')) { index += 1; continue; }
      if (arg.startsWith('--initial-branch=') && BRANCH.test(arg.slice('--initial-branch='.length))) continue;
      if (arg === '.') continue;
      return arg.startsWith('-') ? `受限模式不支持参数 ${arg}` : check(arg, 'read') ?? 'git init 只能在项目目录本身运行';
    }
    return null;
  },
  status: argvRule({ flags: /^(-s|--short|-b|--branch|--porcelain|-u|-uno|-uall|--untracked-files=(no|normal|all)|--ignored|--long)$/, access: 'read' }),
  add: argvRule({ flags: /^(-A|--all|-u|--update|-v|--verbose|-N|--intent-to-add)$/, access: 'read', minOperands: 0 }),
  diff: (args, check) => argvRule({
    flags: /^(--stat|--shortstat|--numstat|--cached|--staged|--name-only|--name-status|--no-color|-U\d{1,3}|--unified=\d{1,3})$/,
    access: 'read',
  })(args.filter(arg => arg !== 'HEAD'), check),
  log: (args, check) => argvRule({
    flags: /^(--oneline|--stat|--shortstat|--graph|--decorate|--no-decorate|--no-color|-p|--patch|--reverse|--name-only|--name-status|-\d{1,7}|--max-count=\d{1,7}|--format=[\w%:,.+-]*|--pretty=[\w%:,.+-]*)$/,
    values: { '-n': COUNT },
    access: 'read',
  })(args.filter(arg => arg !== 'HEAD'), check),
  commit: args => {
    let message = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-m') {
        if (args[index + 1] === undefined) return '-m 后面要写提交信息';
        message = true;
        index += 1;
        continue;
      }
      if (arg.startsWith('--message=') && arg.length > '--message='.length) { message = true; continue; }
      if (['-a', '--all', '-q', '--quiet', '--allow-empty', '--no-verify'].includes(arg)) continue;
      return arg.startsWith('-') ? `受限模式不支持参数 ${arg}` : 'git commit 不能指定文件，请先 git add';
    }
    // Without a message git would open an editor.
    return message ? null : '请用 -m 写提交信息（一个不含空格的词，例如 git commit -m first-version）';
  },
};

// Programs that cannot run other code, with the arguments each may take.
const RESTRICTED_PROGRAMS: Record<string, CommandRule> = {
  pwd: args => (args.length ? 'pwd 不带参数' : null),
  ls: argvRule({ flags: /^-[alhRrtSAF1d]+$/, access: 'read' }),
  cat: argvRule({ flags: /^-n$/, access: 'read', minOperands: 1 }),
  head: argvRule({ flags: /^-\d{1,7}$/, values: { '-n': COUNT, '-c': COUNT }, access: 'read', minOperands: 1 }),
  tail: argvRule({ flags: /^-\d{1,7}$/, values: { '-n': COUNT, '-c': COUNT }, access: 'read', minOperands: 1 }),
  wc: argvRule({ flags: /^-[lwcm]+$/, access: 'read', minOperands: 1 }),
  mkdir: argvRule({ flags: /^-[pv]+$/, access: 'write', minOperands: 1 }),
  touch: argvRule({ access: 'write', minOperands: 1 }),
  rm: argvRule({ flags: /^-[rRfv]+$/, access: 'remove', minOperands: 1 }),
  mv: argvRule({ flags: /^-[fnv]+$/, access: 'remove', minOperands: 2, lastAccess: 'write' }),
  cp: argvRule({ flags: /^-[rRfnv]+$/, access: 'read', minOperands: 2, lastAccess: 'write' }),
  git: (args, check) => {
    const rule = GIT_RULES[args[0] ?? ''];
    return rule ? rule(args.slice(1), check) : '受限模式下 git 只能用 init、status、diff、log、add、commit';
  },
};

/**
 * Decides one shell command of a restricted build (no OS sandbox) in `workspace`: only a plain argument vector
 * naming an allowlisted program, with every path inside the folder and no control file written.
 *
 * Exported for the build runner's tests; the runner calls it through `evaluateBuildPermission`.
 */
export function evaluateRestrictedCommand(command: string, workspace: string): PermissionVerdict {
  const text = command.trim();
  if (!text) return deny('命令为空');
  if (text.length > 2000) return deny('命令过长');
  if (!PLAIN_COMMAND.test(text)) return deny(PLAIN_COMMAND_HINT);
  const [program, ...args] = text.split(/ +/);
  const rule = RESTRICTED_PROGRAMS[program];
  if (!rule) return deny(`受限模式只能运行 ${RESTRICTED_PROGRAM_LIST}；不能运行代码、安装依赖或跑测试`);
  const root = realWorkspace(workspace);
  const refusal = rule(args, (candidate, access) => pathRefusal(candidate, root, access));
  return refusal ? deny(refusal) : allow();
}

/**
 * Decides one tool call of an unattended build in `workspace` (see the policy at the top of this file): bookkeeping
 * and sub-agents pass, file tools must stay in the folder and off control files, Bash is sandboxed or restricted by
 * `mode`, questions and plan mode are refused with guidance, and everything else is refused.
 *
 * Exported for the build runner's tests.
 */
export function evaluateBuildPermission(toolName: string, input: unknown, workspace: string, mode: StudioBuildEnvironment['mode']): PermissionVerdict {
  const record = input && typeof input === 'object' ? input as AnyRecord : {};
  if (BOOKKEEPING_TOOLS.has(toolName)) return allow();
  if (AGENT_TOOLS.has(toolName)) return record.isolation ? deny('子任务不能另开 worktree，请在当前目录里工作') : allow();
  if (QUESTION_TOOLS.has(toolName)) return deny('这是无人值守的开发，没有人会回答问题或批准计划。请自己做出合理的选择，把假设写进 README，然后继续');
  if (toolName === 'Bash') {
    const command = typeof record.command === 'string' ? record.command : '';
    if (mode === 'sandbox') {
      if (record.dangerouslyDisableSandbox === true) return deny('命令必须在沙箱里运行');
      return command.trim() ? allow() : deny('命令为空');
    }
    return evaluateRestrictedCommand(command, workspace);
  }
  if (FILE_TOOLS[toolName]) {
    const refusal = fileToolRefusal(toolName, record, realWorkspace(workspace));
    return refusal ? deny(refusal) : allow();
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return deny('无人值守开发不能访问网页');
  return deny(`工具 ${toolName} 不在无人值守开发允许的列表中`);
}

// What the agent reads when the policy refuses a call.
const refusalMessage = (reason: string) => `无人值守开发策略拒绝了这个操作：${reason}。请换一种只在项目目录内完成的做法，不要重复同一个操作。`;

//----------------- CHECKLIST ------------

const CHECKLIST_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const MAX_TODOS = 60;

function readTodos(input: unknown): StudioBuildTodo[] | null {
  const todos = input && typeof input === 'object' ? (input as AnyRecord).todos : undefined;
  if (!Array.isArray(todos)) return null;
  return todos.slice(0, MAX_TODOS).flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const todo = entry as AnyRecord;
    const content = typeof todo.content === 'string' ? todo.content.trim().slice(0, 200) : '';
    if (!content) return [];
    const status = todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending';
    const activeForm = typeof todo.activeForm === 'string' && todo.activeForm.trim() ? todo.activeForm.trim().slice(0, 200) : undefined;
    return [{ content, status, ...(activeForm ? { activeForm } : {}) }];
  });
}

// The newest checklist among already-unified transcript rows (TodoWrite snapshots).
function latestTodos(messages: NormalizedMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind === 'tool_use' && message.toolName === 'TodoWrite' && !message.parentToolUseId) {
      const todos = readTodos(message.toolInput);
      if (todos) return todos;
    }
  }
  return null;
}

/**
 * Folds live checklist calls into the snapshot the transcript would show. Live `tool_result` rows carry their
 * result at the top level; they are attached to their call so TaskCreate ids resolve like they do on reload.
 */
function checklistFromEvents(events: NormalizedMessage[]) {
  const calls: NormalizedMessage[] = [];
  const callsById = new Map<string, NormalizedMessage>();
  for (const event of events) {
    if (event.kind === 'tool_use' && event.toolName && CHECKLIST_TOOLS.has(event.toolName) && !event.parentToolUseId) {
      // Copies, because the unification pass rewrites rows in place.
      const call: NormalizedMessage = { ...event, toolResult: event.toolResult ? { ...event.toolResult } : undefined };
      calls.push(call);
      if (event.toolId) callsById.set(event.toolId, call);
    } else if (event.kind === 'tool_result' && event.toolId && callsById.has(event.toolId)) {
      const call = callsById.get(event.toolId) as NormalizedMessage;
      call.toolResult = event.toolResult ? { ...event.toolResult } : {
        content: typeof event.content === 'string' ? event.content : undefined,
        isError: Boolean(event.isError),
        toolUseResult: event.toolUseResult,
      };
    }
  }
  return calls.length ? latestTodos(prepareTranscriptMessages(calls)) : null;
}

const isChecklistEvent = (event: NormalizedMessage) => (event.kind === 'tool_use' && Boolean(event.toolName && CHECKLIST_TOOLS.has(event.toolName)))
  || event.kind === 'tool_result';

//----------------- RUNNER ------------

// The shape of a chat-run-registry entry this runner reads.
type RegistryRun = { status: string; startedAt: number; events: NormalizedMessage[] };

type RunnerDependencies = {
  runtime: ProviderRuntimeGateway;
  // runDetachedChatTurn from the websocket module; injected so tests can drive a scripted provider stream.
  runTurn: (
    input: { sessionId: string; userId: number; content: string; options: AnyRecord },
    dependencies: { runtime: ProviderRuntimeGateway },
  ) => Promise<{ started: boolean; error: string | null }>;
  getRun: (sessionId: string) => RegistryRun | undefined;
  completeRun: (sessionId: string, options: { exitCode: number; aborted?: boolean }) => void;
  // The session's full, unified transcript (sessionsService.fetchHistory).
  readHistory: (sessionId: string) => Promise<NormalizedMessage[]>;
  // Optional overrides from STUDIO_BUILD_MODEL / STUDIO_BUILD_EFFORT.
  model?: string;
  effort?: string;
  // Sandbox or restricted, read at every turn (detectBuildEnvironment unless STUDIO_BUILD_SANDBOX=off).
  environment?: () => StudioBuildEnvironment;
  // The home directory whose contents sandboxed commands may not read (os.homedir()).
  home?: string;
  // Registries sandboxed commands may reach besides npm and PyPI (STUDIO_BUILD_EXTRA_DOMAINS).
  extraDomains?: string[];
};

// Checklist tools need no prompt at all; the policy hook would allow them anyway.
const BUILD_ALLOWED_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
// Removed from build turns entirely (the model never sees them), plus belt-and-braces deny rules.
const BUILD_DENIED_TOOLS = [
  'WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(sudo:*)', 'Bash(npm publish:*)', 'Bash(pnpm publish:*)', 'Bash(yarn publish:*)',
];
// How long to look for the runtime's pending approval after its prompt went out (it registers right after sending).
const APPROVAL_LOOKUPS = 40;
const APPROVAL_LOOKUP_MS = 25;

const shortError = (value: unknown) => {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return text.trim().slice(0, 300) || null;
};

function outcomeFromComplete(message: NormalizedMessage, lastError: string | null): StudioBuildOutcome {
  if (message.aborted) return { started: true, success: false, error: '开发已停止' };
  if (message.success === true) return { started: true, success: true, error: null };
  return { started: true, success: false, error: lastError ?? `AI 异常结束（退出码 ${String(message.exitCode ?? '未知')}）` };
}

function lastCompleteSince(run: RegistryRun | undefined, since: number) {
  if (!run || run.startedAt < since) return null;
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    if (run.events[index].kind === 'complete') return run.events[index];
  }
  return null;
}

/**
 * Wraps the run's writer so this runner sees every event the provider emits while everything else about the
 * writer (its audience, replay buffer and session-id capture) stays exactly as the registry made it.
 *
 * `muted` hides the writer's user while an automatically answered prompt goes out: the Claude runtime reads
 * `writer.userId` synchronously right after sending a permission prompt to decide whether to push an
 * "action required" notification, and a prompt this runner answers within milliseconds must not buzz the owner.
 */
function watchWriter(writer: ProviderRuntimeWriter, onSend: (data: unknown) => void, muted: () => boolean): ProviderRuntimeWriter {
  return new Proxy(writer, {
    get(target, property) {
      if (property === 'send') {
        return (data: unknown) => {
          target.send(data);
          onSend(data);
        };
      }
      if (property === 'userId' && muted()) return null;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Used by builds.module to run AI builds as unattended Claude Code turns; tests pass a scripted runtime instead. */
export function createClaudeBuildRunner(deps: RunnerDependencies): StudioBuildRunner {
  const environment = deps.environment ?? (() => detectBuildEnvironment());
  const home = deps.home ?? os.homedir();

  function answerPrompt(requestId: string, sessionId: string, verdict: PermissionVerdict, attempt = 0) {
    const decision: ProviderPermissionDecision = verdict.allow ? { allow: true } : { allow: false, message: refusalMessage(verdict.reason) };
    const timer = setTimeout(() => {
      const pending = deps.runtime.getPendingApprovalsForSession(sessionId) as { requestId?: unknown }[];
      if (pending.some(entry => entry?.requestId === requestId)) {
        deps.runtime.resolveToolApproval(requestId, decision);
        return;
      }
      if (attempt < APPROVAL_LOOKUPS) answerPrompt(requestId, sessionId, verdict, attempt + 1);
    }, attempt === 0 ? 0 : APPROVAL_LOOKUP_MS);
    timer.unref?.();
  }

  return {
    start(input) {
      return new Promise<StudioBuildOutcome>(resolve => {
        const turnStartedAt = Date.now();
        const { mode } = environment();
        const workspace = input.workspacePath;
        // Decides every tool call of this turn, first as the runtime's PreToolUse hook and again for any prompt.
        const review = (toolName: string, toolInput: unknown): PermissionVerdict => {
          const verdict = evaluateBuildPermission(toolName, toolInput, workspace, mode);
          if (!verdict.allow) console.info(`[studio-builds] refused ${toolName}: ${verdict.reason}`);
          return verdict;
        };
        const seen: NormalizedMessage[] = [];
        const checklistCallIds = new Set<string>();
        let settled = false;
        let muted = false;
        let lastError: string | null = null;
        let lastChecklist = '';
        const settle = (outcome: StudioBuildOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        const onSend = (data: unknown) => {
          if (!data || typeof data !== 'object') return;
          const message = data as NormalizedMessage;
          if (message.kind === 'permission_request' && typeof message.requestId === 'string') {
            const verdict = review(String(message.toolName ?? ''), message.input);
            muted = true;
            setImmediate(() => { muted = false; });
            answerPrompt(message.requestId, input.sessionId, verdict);
          } else if (message.kind === 'error') {
            lastError = shortError(message.content ?? message.text ?? message.error) ?? lastError;
          } else if (message.kind === 'complete') {
            settle(outcomeFromComplete(message, lastError));
          }
          // Only checklist calls and their own results are kept; other tool output can be large.
          const isCall = message.kind === 'tool_use' && Boolean(message.toolName && CHECKLIST_TOOLS.has(message.toolName)) && !message.parentToolUseId;
          const isResult = message.kind === 'tool_result' && typeof message.toolId === 'string' && checklistCallIds.has(message.toolId);
          if (isCall || isResult) {
            if (isCall && message.toolId) checklistCallIds.add(message.toolId);
            seen.push(message);
            const todos = checklistFromEvents(seen);
            const signature = todos ? JSON.stringify(todos) : '';
            if (todos && signature !== lastChecklist) {
              lastChecklist = signature;
              input.onChecklist(todos);
            }
          }
        };
        // A gateway for this turn only: identical to the real one except that the run's writer is watched.
        const runtime: ProviderRuntimeGateway = {
          hasRuntime: provider => deps.runtime.hasRuntime(provider),
          run: (provider, command, options, writer) => deps.runtime.run(provider, command, options, watchWriter(writer, onSend, () => muted)),
          abort: (provider, sessionId) => deps.runtime.abort(provider, sessionId),
          stopBackgroundTask: (provider, sessionId, taskId) => deps.runtime.stopBackgroundTask(provider, sessionId, taskId),
          hasBackgroundWork: sessionId => deps.runtime.hasBackgroundWork(sessionId),
          resolveToolApproval: (requestId, payload) => deps.runtime.resolveToolApproval(requestId, payload),
          getPendingApprovalsForSession: sessionId => deps.runtime.getPendingApprovalsForSession(sessionId),
        };
        if (mode === 'sandbox') excludeCacheFromGit(workspace);
        const options: AnyRecord = {
          // Not acceptEdits: should the hook ever be missing, edits still reach the prompt this runner answers.
          permissionMode: 'default',
          toolsSettings: { allowedTools: [...BUILD_ALLOWED_TOOLS], disallowedTools: [...BUILD_DENIED_TOOLS], skipPermissions: false },
          // Read by the Claude runtime (applyBuildIsolation): no settings files or MCP servers, the policy hook, and
          // in sandbox mode the OS sandbox with package caches inside the build folder.
          buildIsolation: {
            reviewToolUse: (toolName: string, toolInput: unknown) => {
              const verdict = review(toolName, toolInput);
              return verdict.allow ? verdict : { allow: false, reason: refusalMessage(verdict.reason) };
            },
            ...(mode === 'sandbox' ? { sandbox: sandboxSettings(workspace, home, deps.extraDomains ?? []), env: cacheEnvironment(workspace) } : {}),
          },
          ...(deps.model ? { model: deps.model } : {}),
          ...(deps.effort ? { effort: deps.effort } : {}),
        };
        const content = `${input.content}\n\n${environmentBrief(mode)}`;
        deps.runTurn({ sessionId: input.sessionId, userId: input.userId, content, options }, { runtime })
          .then(result => {
            if (!result.started) {
              settle({ started: false, success: false, error: shortError(result.error) ?? '无法启动开发' });
              return;
            }
            // An abort or a crashed runtime ends the run through the registry's own writer, past the watched one.
            const complete = lastCompleteSince(deps.getRun(input.sessionId), turnStartedAt);
            settle(complete
              ? outcomeFromComplete(complete, shortError(result.error) ?? lastError)
              : { started: true, success: false, error: shortError(result.error) ?? lastError ?? 'AI 没有正常结束' });
          })
          .catch(error => settle({ started: false, success: false, error: shortError(error) ?? '无法启动开发' }));
      });
    },
    async abort(sessionId) {
      // Same shape as the chat gateway's abort: stop the provider, then emit the terminal `complete` for it.
      const aborted = await deps.runtime.abort('claude', sessionId);
      deps.completeRun(sessionId, { exitCode: aborted ? 0 : 1, aborted: true });
      return aborted;
    },
    inspect(sessionId) {
      const run = deps.getRun(sessionId);
      if (!run) return null;
      const running = run.status === 'running';
      const complete = running ? null : lastCompleteSince(run, run.startedAt);
      return {
        running,
        startedAt: run.startedAt,
        success: running ? null : Boolean(complete && complete.success === true && !complete.aborted),
        todos: checklistFromEvents(run.events.filter(isChecklistEvent)),
      };
    },
    async readChecklist(sessionId) {
      return latestTodos(await deps.readHistory(sessionId));
    },
    environment,
  };
}
