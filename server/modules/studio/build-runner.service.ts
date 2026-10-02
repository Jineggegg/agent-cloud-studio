import path from 'node:path';

import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import type {
  AnyRecord,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
  StudioBuildOutcome,
  StudioBuildRunner,
  StudioBuildTodo,
} from '@/shared/types.js';

/*
 * Unattended Claude Code turns for App Store-style AI builds.
 *
 * Permission policy (documented here because this file enforces it):
 * - The turn runs with `permissionMode: 'acceptEdits'`: file edits inside the project directory are accepted by
 *   Claude Code itself. Plan mode and `bypassPermissions` are never used — plan mode would block forever on
 *   ExitPlanMode with nobody to approve it, and bypass would remove every guard.
 * - `toolsSettings.allowedTools` names only harmless tools (the checklist tools and WebSearch). Shell commands are
 *   deliberately NOT listed there: the runtime's own allow matcher compares prefixes, so `Bash(npm:*)` would also
 *   approve `npm test && rm -rf ~`. Every other tool call reaches the runtime's permission prompt, and this runner
 *   answers that prompt at once with `evaluateBuildPermission` below instead of letting it wait 55 seconds:
 *   project-local file tools, common dev commands (npm/npx/pnpm/yarn/node/python/pip/uv/pytest, git without push,
 *   mkdir/ls/cat …) whose every path stays inside the project, and curl/wget to localhost only. Compound commands
 *   are split and every part must pass; command substitution, heredocs, sudo, global installs, publishing,
 *   process killing and MCP tools are refused with a reason the agent can act on.
 * - `toolsSettings.disallowedTools` adds Claude Code deny rules for the things that must never happen even if the
 *   owner's own Claude settings allow them (git push, sudo, publishing).
 * - AskUserQuestion and ExitPlanMode are answered with a refusal that tells the agent to decide by itself, so an
 *   unattended turn can never hang on a question.
 * - WebSearch and WebFetch stay available for reading documentation, and subagents (Task/Agent) may run because
 *   their own tool calls reach the same prompt and the same policy. The agent's own reads stay inside the project,
 *   which limits (but, see below, cannot guarantee) what a fetched URL could carry away.
 * This is a guard rail against accidents, not a sandbox: a project's own scripts still run with the owner's rights.
 */

//----------------- PERMISSION POLICY ------------

type PermissionVerdict = { allow: true } | { allow: false; reason: string };

const allow = (): PermissionVerdict => ({ allow: true });
const deny = (reason: string): PermissionVerdict => ({ allow: false, reason });

// Tools that only plan, search or report on background work.
const HARMLESS_TOOLS = new Set([
  'TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop',
  'WebSearch', 'WebFetch', 'Task', 'Agent', 'BashOutput', 'KillShell', 'KillBash',
]);
// File tools and the input fields that name what they touch; an absent optional path means the project root.
const PATH_TOOLS: Record<string, string> = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
  NotebookRead: 'notebook_path', Glob: 'path', Grep: 'path', LS: 'path',
};
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);

// Shared device files and the scratch directory are fine to read and write; everything else must be in the project.
const SHARED_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/tmp']);

function isInside(candidate: string, cwd: string, workspace: string) {
  if (candidate.startsWith('~')) return false;
  const resolved = path.resolve(cwd, candidate);
  if (SHARED_PATHS.has(resolved) || resolved.startsWith('/tmp/')) return true;
  const relative = path.relative(workspace, resolved);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

type ShellSegment = { words: string[]; redirects: string[] };

/**
 * Splits a shell command into simple commands, honouring quotes and escapes. Returns a reason instead when the
 * command uses constructs whose effect cannot be read off the text: command or process substitution, variable
 * expansion, heredocs, or unbalanced quotes.
 */
function parseShell(command: string): ShellSegment[] | string {
  const segments: ShellSegment[] = [];
  let current: ShellSegment = { words: [], redirects: [] };
  let word = '';
  // A quoted empty string is still a word, so "is there a word" cannot be read from `word` alone.
  let inWord = false;
  let redirectPending = false;
  const endWord = () => {
    if (!inWord) return;
    if (redirectPending) current.redirects.push(word); else current.words.push(word);
    redirectPending = false;
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (redirectPending) return false;
    if (current.words.length || current.redirects.length) segments.push(current);
    current = { words: [], redirects: [] };
    return true;
  };
  const expands = (next: string | undefined) => Boolean(next && /[A-Za-z_{(]/.test(next));
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close < 0) return '引号不完整';
      word += command.slice(index + 1, close);
      inWord = true;
      index = close;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      for (; cursor < command.length && command[cursor] !== '"'; cursor += 1) {
        const inner = command[cursor];
        if (inner === '\\' && cursor + 1 < command.length) { word += command[cursor + 1]; cursor += 1; continue; }
        if (inner === '`' || (inner === '$' && expands(command[cursor + 1]))) return '不允许命令替换或变量展开';
        word += inner;
      }
      if (cursor >= command.length) return '引号不完整';
      inWord = true;
      index = cursor;
      continue;
    }
    if (char === '\\') {
      if (next === '\n') { index += 1; continue; }
      word += next ?? '';
      inWord = true;
      index += 1;
      continue;
    }
    if (char === '`' || (char === '$' && expands(next))) return '不允许命令替换或变量展开';
    if ((char === '<' || char === '>') && next === '(') return '不允许进程替换';
    if (char === ' ' || char === '\t') { endWord(); continue; }
    if (char === '\n' || char === ';' || char === '|' || (char === '&' && next !== '>')) {
      if (!endSegment()) return '重定向缺少目标';
      // `&&`, `||` and `|&` are one operator.
      if ((char === '&' || char === '|') && (next === char || (char === '|' && next === '&'))) index += 1;
      continue;
    }
    if (char === '>' || char === '<' || char === '&') {
      if (char === '<' && next === '<') return '不允许 heredoc，请用 Write 工具写文件';
      // A word of digits written right against the operator is a file descriptor (`2>`), not an argument.
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; } else endWord();
      let cursor = char === '&' ? index + 2 : index + 1;
      if (command[cursor] === '>') cursor += 1;
      if (command[cursor] === '&') {
        // `>&2`, `2>&1`, `>&-`: duplicating a descriptor touches no file.
        cursor += 1;
        while (/[\d-]/.test(command[cursor] ?? '')) cursor += 1;
        index = cursor - 1;
        continue;
      }
      if (command[cursor] === '|') cursor += 1;
      redirectPending = true;
      index = cursor - 1;
      continue;
    }
    word += char;
    inWord = true;
  }
  if (!endSegment()) return '重定向缺少目标';
  return segments;
}

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
// Programs that run inside the project or only read and arrange files there.
const PROJECT_PROGRAMS = new Set([
  'node', 'npx', 'tsx', 'ts-node', 'tsc', 'vite', 'vitest', 'jest', 'eslint', 'prettier', 'npm', 'pnpm', 'yarn', 'bun',
  'corepack', 'deno', 'python', 'python3', 'pytest', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'make', 'cargo', 'rustc',
  'go', 'git', 'curl', 'wget', 'rm', 'rmdir', 'bash', 'sh', 'source', '.', 'export', 'ls', 'cat', 'head', 'tail', 'wc',
  'pwd', 'touch', 'mkdir', 'cp', 'mv', 'ln', 'chmod', 'sort', 'uniq', 'diff', 'tree', 'which', 'true', 'false', 'test',
  '[', 'sed', 'awk', 'cut', 'tr', 'du', 'file', 'stat', 'basename', 'dirname', 'date', 'sleep', 'grep', 'egrep',
  'fgrep', 'rg', 'find', 'ps', 'jq', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'realpath', 'readlink', 'nl', 'tee',
  'seq', 'echo', 'printf', 'column', 'md5sum', 'sha256sum', 'lsof',
]);
// Refused outright, with the reason the agent is given.
const REFUSED_PROGRAMS: Record<string, string> = {
  sudo: '不允许 sudo', su: '不允许切换用户', doas: '不允许切换用户',
  kill: '不允许结束进程（会误伤 Studio 自己），请用后台任务的停止功能', pkill: '不允许结束进程（会误伤 Studio 自己）',
  killall: '不允许结束进程（会误伤 Studio 自己）', xargs: '不允许 xargs，请直接写出要运行的命令',
  eval: '不允许 eval', exec: '不允许 exec', gh: '不允许操作 GitHub', ssh: '不允许连接其他主机', scp: '不允许连接其他主机',
  rsync: '不允许同步到其他位置', docker: '不允许操作 Docker', systemctl: '不允许管理系统服务', service: '不允许管理系统服务',
  crontab: '不允许修改定时任务', chown: '不允许修改文件所有者', apt: '不允许安装系统软件包', 'apt-get': '不允许安装系统软件包',
  brew: '不允许安装系统软件包', shutdown: '不允许关机', reboot: '不允许重启',
};
// Shell variables whose value changes how every later program loads or which repository git uses.
const PROTECTED_VARIABLES = new Set(['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'NODE_OPTIONS']);
const PACKAGE_REFUSED = new Set([
  'publish', 'unpublish', 'login', 'logout', 'adduser', 'add-user', 'token', 'owner', 'deprecate', 'dist-tag', 'access',
  'star', 'unstar', 'team', 'org', 'profile', 'link', 'hook',
]);
const GIT_REFUSED = new Set(['push', 'send-email', 'credential', 'daemon', 'request-pull', 'filter-branch', 'svn', 'p4']);

const firstOperand = (args: string[]) => args.find(arg => !arg.startsWith('-'));

function packageRule(program: string, args: string[]) {
  if (args.some(arg => arg === '-g' || arg === '--global' || arg === '--location=global')) return '不允许全局安装，请把依赖装在项目里';
  const subcommand = firstOperand(args);
  if (program === 'yarn' && subcommand === 'global') return '不允许全局安装，请把依赖装在项目里';
  if (subcommand && PACKAGE_REFUSED.has(subcommand)) return `不允许 ${program} ${subcommand}`;
  if (subcommand === 'config' && args.some(arg => ['set', 'delete', 'edit'].includes(arg))) return `不允许修改 ${program} 配置`;
  return null;
}

function gitRule(args: string[]) {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const flag = args[index];
    if (['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace'].some(name => flag === name || flag.startsWith(`${name}=`))) {
      return 'git 不能指定其他仓库目录或临时配置';
    }
    index += 1;
  }
  const subcommand = args[index];
  if (!subcommand) return null;
  if (GIT_REFUSED.has(subcommand)) return subcommand === 'push' ? '不允许 git push：成果只提交到本地仓库' : `不允许 git ${subcommand}`;
  const rest = args.slice(index + 1);
  if (subcommand === 'remote' && rest.some(arg => ['add', 'set-url', 'rename', 'remove', 'rm'].includes(arg))) return '不允许修改 git 远程仓库';
  if (subcommand === 'config' && rest.some(arg => ['--global', '--system', '--file', '-f'].includes(arg) || arg.startsWith('--file='))) {
    return '不允许修改全局 git 配置';
  }
  return null;
}

// curl/wget options whose next argument is a value (a file, header, method …) rather than a URL.
const NETWORK_VALUE_FLAGS: Record<string, Set<string>> = {
  curl: new Set([
    '-o', '--output', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-H', '--header', '-X', '--request',
    '-w', '--write-out', '-u', '--user', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar',
    '-m', '--max-time', '--connect-timeout', '-F', '--form', '-T', '--upload-file', '--retry', '-r', '--range',
  ]),
  wget: new Set([
    '-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '--header', '-U', '--user-agent',
    '-t', '--tries', '-T', '--timeout', '--post-data', '--post-file',
  ]),
};

// Every URL curl or wget would fetch (bare words count: both treat them as URLs) must be on this machine.
function localOnlyRule(program: string, args: string[]) {
  const valueFlags = NETWORK_VALUE_FLAGS[program];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('-')) {
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    try {
      const url = new URL(URL_PATTERN.test(arg) ? arg : `http://${arg}`);
      if (!LOCAL_HOSTS.has(url.hostname)) return '网络请求只允许访问本机服务（localhost）';
    } catch {
      return '网络请求只允许访问本机服务（localhost）';
    }
  }
  return null;
}

function programRule(program: string, args: string[], cwd: string, workspace: string): string | null {
  if (REFUSED_PROGRAMS[program]) return REFUSED_PROGRAMS[program];
  if (!PROJECT_PROGRAMS.has(program)) return `命令 ${program} 不在无人值守开发允许的列表中`;
  if (['npm', 'pnpm', 'yarn', 'bun', 'corepack'].includes(program)) return packageRule(program, args);
  if (program === 'git') return gitRule(args);
  if (program === 'curl' || program === 'wget') return localOnlyRule(program, args);
  if (program === 'pip' || program === 'pip3') {
    return args.some(arg => arg === '--user' || arg === '--break-system-packages') ? '请把 Python 依赖装在项目的虚拟环境里' : null;
  }
  if (program === 'uv') {
    if (args[0] === 'tool' && ['install', 'uninstall'].includes(args[1] ?? '')) return '不允许全局安装工具，请用 uvx 或项目依赖';
    return args.includes('--system') ? '请把 Python 依赖装在项目的虚拟环境里' : null;
  }
  if (program === 'find' && args.some(arg => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))) return 'find 不能执行其他命令';
  if (program === 'bash' || program === 'sh') {
    if (args.some(arg => /^-[a-z]*c[a-z]*$/i.test(arg))) return 'sh -c 无法审查，请直接运行命令';
    if (!firstOperand(args)) return '请运行项目里的脚本文件';
  }
  if ((program === 'source' || program === '.') && !firstOperand(args)) return '请指定项目里的脚本文件';
  if (program === 'rm' || program === 'rmdir') {
    const targets = args.filter(arg => !arg.startsWith('-'));
    if (!targets.length) return '请指定要删除的文件';
    if (targets.some(target => path.resolve(cwd, target) === workspace)) return '不能删除项目目录本身';
  }
  return null;
}

// Arguments that are text rather than paths: echoed words, commit messages, search patterns, inline code.
function textArgumentIndexes(program: string, args: string[]) {
  const skipped = new Set<number>();
  if (program === 'echo' || program === 'printf') args.forEach((_, index) => skipped.add(index));
  args.forEach((arg, index) => {
    const valueFlags = program === 'git' ? ['-m', '--message'] : ['node', 'python', 'python3', 'deno', 'bun'].includes(program)
      ? ['-e', '-c', '-p', '--eval', '--print'] : ['grep', 'egrep', 'fgrep', 'rg'].includes(program) ? ['-e', '--regexp'] : [];
    if (valueFlags.includes(arg)) skipped.add(index + 1);
    if (valueFlags.some(flag => flag.startsWith('--') && arg.startsWith(`${flag}=`))) skipped.add(index);
  });
  if (['grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk'].includes(program) && !args.some(arg => arg === '-e' || arg === '--regexp')) {
    const pattern = args.findIndex(arg => !arg.startsWith('-'));
    if (pattern >= 0) skipped.add(pattern);
  }
  return skipped;
}

function pathsStayInside(words: string[], cwd: string, workspace: string) {
  return words.every(word => URL_PATTERN.test(word) || word.split(/[=,:]/).every(part => !part || isInside(part, cwd, workspace)));
}

/**
 * Decides one shell command for an unattended build in `workspace` (an absolute, canonical directory).
 *
 * Exported for the build runner's tests; the runner calls it through `evaluateBuildPermission`.
 */
export function evaluateBuildCommand(command: string, workspace: string): PermissionVerdict {
  if (!command.trim()) return deny('命令为空');
  if (command.length > 8000) return deny('命令过长');
  const parsed = parseShell(command);
  if (typeof parsed === 'string') return deny(parsed);
  let cwd = workspace;
  for (const segment of parsed) {
    if (!segment.redirects.every(target => isInside(target, cwd, workspace))) return deny('只能把输出写进项目目录或 /tmp');
    const words = segment.words;
    let index = 0;
    // Leading assignments and transparent wrappers (`CI=1 timeout 60 npm test`) do not change which program runs.
    while (index < words.length) {
      const word = words[index];
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
      if (assignment) {
        if (PROTECTED_VARIABLES.has(assignment[1])) return deny(`不允许修改 ${assignment[1]}`);
        index += 1;
        continue;
      }
      if (['env', 'nohup', 'time', 'command'].includes(word)) { index += 1; continue; }
      if (word === 'timeout') {
        index += 1;
        while (words[index]?.startsWith('-')) index += 1;
        index += 1;
        continue;
      }
      break;
    }
    if (!pathsStayInside(words.slice(0, index), cwd, workspace)) return deny('命令中的路径在项目目录之外');
    const program = words[index];
    if (program === undefined) continue;
    const args = words.slice(index + 1);
    if (program === 'cd') {
      const target = args[0];
      if (!target || target === '-' || !isInside(target, cwd, workspace)) return deny('只能在项目目录内切换目录');
      cwd = path.resolve(cwd, target);
      continue;
    }
    if (program.includes('/')) {
      // A project-local executable (`./node_modules/.bin/vite`, `.venv/bin/python`).
      if (!isInside(program, cwd, workspace)) return deny('只能运行项目目录里的程序');
    } else {
      const refusal = programRule(program, args, cwd, workspace);
      if (refusal) return deny(refusal);
    }
    const text = textArgumentIndexes(program, args);
    if (!pathsStayInside(args.filter((_, position) => !text.has(position)), cwd, workspace)) return deny('命令中的路径在项目目录之外');
  }
  return allow();
}

/**
 * Decides one tool call of an unattended build: harmless tools pass, file tools must stay in `workspace`, shell
 * commands go through `evaluateBuildCommand`, questions and plan mode are refused with guidance, and anything
 * else (MCP tools included) is refused.
 *
 * Exported for the build runner's tests.
 */
export function evaluateBuildPermission(toolName: string, input: unknown, workspace: string): PermissionVerdict {
  const record = input && typeof input === 'object' ? input as AnyRecord : {};
  if (HARMLESS_TOOLS.has(toolName)) return allow();
  if (QUESTION_TOOLS.has(toolName)) return deny('这是无人值守的开发，没有人会回答问题或批准计划。请自己做出合理的选择，把假设写进 README，然后继续');
  if (toolName === 'Bash') return evaluateBuildCommand(typeof record.command === 'string' ? record.command : '', workspace);
  const field = PATH_TOOLS[toolName];
  if (field) {
    const target = record[field];
    if (target === undefined || target === null || target === '') return allow();
    return typeof target === 'string' && isInside(target, workspace, workspace) ? allow() : deny('只能读写项目目录里的文件');
  }
  return deny(`工具 ${toolName} 不在无人值守开发允许的列表中`);
}

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
};

const BUILD_ALLOWED_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'WebSearch'];
const BUILD_DENIED_TOOLS = ['Bash(git push:*)', 'Bash(sudo:*)', 'Bash(npm publish:*)', 'Bash(pnpm publish:*)', 'Bash(yarn publish:*)'];
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

/** Used by studio.module to run AI builds as unattended Claude Code turns; tests pass a scripted runtime instead. */
export function createClaudeBuildRunner(deps: RunnerDependencies): StudioBuildRunner {
  function answerPrompt(requestId: string, sessionId: string, verdict: PermissionVerdict, attempt = 0) {
    const decision: ProviderPermissionDecision = verdict.allow ? { allow: true } : {
      allow: false,
      message: `无人值守开发策略拒绝了这个操作：${verdict.reason}。请换一种只在项目目录内完成的做法，不要重复同一个命令。`,
    };
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
            const verdict = evaluateBuildPermission(String(message.toolName ?? ''), message.input, input.workspacePath);
            if (!verdict.allow) console.info(`[studio-builds] refused ${String(message.toolName)}: ${verdict.reason}`);
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
        const options: AnyRecord = {
          permissionMode: 'acceptEdits',
          toolsSettings: { allowedTools: [...BUILD_ALLOWED_TOOLS], disallowedTools: [...BUILD_DENIED_TOOLS], skipPermissions: false },
          ...(deps.model ? { model: deps.model } : {}),
          ...(deps.effort ? { effort: deps.effort } : {}),
        };
        deps.runTurn({ sessionId: input.sessionId, userId: input.userId, content: input.content, options }, { runtime })
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
  };
}
