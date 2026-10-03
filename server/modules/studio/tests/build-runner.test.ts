import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord, NormalizedMessage, ProviderPermissionDecision, ProviderRuntimeWriter, StudioBuildEnvironment, StudioBuildTodo } from '@/shared/types.js';

import { createClaudeBuildRunner, detectBuildEnvironment, evaluateBuildPermission, evaluateRestrictedCommand } from '../build-runner.service.js';

// A real folder, because the policy resolves symlinks.
const SCRATCH = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'build-policy-')));
const WORKSPACE = path.join(SCRATCH, 'habit-tracker');
mkdirSync(path.join(WORKSPACE, '.git', 'hooks'), { recursive: true });
mkdirSync(path.join(WORKSPACE, 'src'));
writeFileSync(path.join(WORKSPACE, 'README.md'), '# Habit tracker\n');
writeFileSync(path.join(WORKSPACE, '.git', 'config'), '[core]\n');
mkdirSync(path.join(SCRATCH, 'outside'));
writeFileSync(path.join(SCRATCH, 'outside', 'secret.txt'), 'secret');
// Links planted inside the folder that point out of it.
symlinkSync(path.join(SCRATCH, 'outside'), path.join(WORKSPACE, 'escape'));
symlinkSync(path.join(SCRATCH, 'outside', 'secret.txt'), path.join(WORKSPACE, 'secret-link.txt'));
symlinkSync(path.join(SCRATCH, 'outside', 'not-there-yet.txt'), path.join(WORKSPACE, 'dangling.txt'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const HOME = os.homedir();
const restricted = (command: string) => evaluateRestrictedCommand(command, WORKSPACE);
const tool = (name: string, input: AnyRecord, mode: StudioBuildEnvironment['mode'] = 'restricted') => evaluateBuildPermission(name, input, WORKSPACE, mode);

function assertRefused(verdict: ReturnType<typeof restricted>, reason: RegExp, label: string) {
  assert.equal(verdict.allow, false, label);
  if (!verdict.allow) assert.match(verdict.reason, reason, label);
}

test('restricted builds approve plain commands that only look at, arrange or record files in the folder', () => {
  const approved = [
    'pwd',
    'ls',
    'ls -la src',
    'cat README.md',
    'head -n 20 README.md',
    'tail -5 README.md',
    'wc -l README.md src',
    'mkdir -p src/components',
    'touch src/app.ts',
    'cp README.md docs.md',
    'cp -r src lib',
    'mv docs.md NOTES.md',
    'rm -rf src/old',
    `rm ${WORKSPACE}/NOTES.md`,
    'git init',
    'git init -b main',
    'git status --short',
    'git diff --stat',
    'git diff HEAD',
    'git log --oneline -n 5',
    'git add -A',
    'git add README.md src',
    'git commit -m first-version',
    'git commit -m 第一版',
    'git commit -a --message=feat:add-readme',
  ];
  for (const command of approved) assert.deepEqual(restricted(command), { allow: true }, command);
});

test('restricted builds refuse every shell construct instead of trying to read it (review high: parser bypasses)', () => {
  // Each of these slipped past the old hand-written parser or could; none survives the plain-word character set.
  const bypasses = [
    "cat $'\\x2fetc\\x2fpasswd'",
    'cat $"/etc/passwd"',
    'cat {/etc/passwd,README.md}',
    'cat {..,.}/../outside/secret.txt',
    'git pu{s,}h origin main',
    'cp README.md {/tmp,.}/copy',
    'ls ${HOME}',
    'ls $HOME',
    'ls `id`',
    'ls $(id)',
    'ls > /tmp/out',
    'cat < /etc/passwd',
    'ls; id',
    'ls && id',
    'ls | head',
    'ls &',
    'ls\nid',
    'ls *',
    'ls ?',
    'ls [ab]',
    'cat ~/.ssh/id_rsa',
    'cat "README.md"',
    "cat 'README.md'",
    'cat README\\.md',
    'ls # comment',
    'ls !',
    'ls\tsrc',
  ];
  for (const command of bypasses) assertRefused(restricted(command), /受限模式只接受最简单的命令/, command);
});

test('restricted builds refuse every way to run code, reach the network or reconfigure git (review high: code execution)', () => {
  const refused: [string, RegExp][] = [
    ['node -e process.exit', /不能运行代码/],
    ['python3 -c print', /不能运行代码/],
    ['npm install', /不能运行代码/],
    ['npm run test', /不能运行代码/],
    ['npx vitest', /不能运行代码/],
    ['bash build.sh', /不能运行代码/],
    ['sh -c ls', /不能运行代码/],
    ['awk BEGIN{system} x', /受限模式只接受最简单的命令/],
    ['awk -f prog.awk README.md', /不能运行代码/],
    ['sed -n 1p README.md', /不能运行代码/],
    ['tar -xf a.tar --to-command=sh', /不能运行代码/],
    ['find . -delete', /不能运行代码/],
    ['curl http://localhost:3000', /不能运行代码/],
    ['env -i bash x.sh', /不能运行代码/],
    ['timeout 5 ls', /不能运行代码/],
    ['./node_modules/.bin/vite', /不能运行代码/],
    ['git push origin main', /git 只能用/],
    ['git config core.hooksPath hooks', /git 只能用/],
    ['git -c core.pager=sh log', /git 只能用/],
    ['git remote add origin git@github.com:me/x.git', /git 只能用/],
    ['git commit', /-m/],
    ['git commit -m', /提交信息/],
    ['git commit --template=x -m y', /不支持参数 --template=x/],
    ['git diff --output=/tmp/x', /不支持参数/],
    ['git diff --ext-diff', /不支持参数/],
    ['git log --output=/tmp/x', /不支持参数/],
    ['git init --template=/tmp/hooks', /不支持参数/],
    ['git init ../other', /不在项目目录里/],
    ['git status --porcelain=v2 -z', /不支持参数/],
    ['tail -f server.log', /不支持参数 -f/],
    ['cp -s README.md link', /不支持参数 -s/],
  ];
  for (const [command, reason] of refused) assertRefused(restricted(command), reason, command);
});

test('restricted paths refuse symlinks and never touch control files (review medium: control files)', () => {
  const refused: [string, RegExp][] = [
    ['cat /etc/passwd', /不在项目目录里/],
    ['ls ..', /不在项目目录里/],
    ['cat escape/secret.txt', /符号链接/],
    ['cat secret-link.txt', /符号链接/],
    ['cp secret-link.txt copy.txt', /符号链接/],
    ['cp README.md escape/README.md', /符号链接/],
    ['touch dangling.txt', /符号链接/],
    ['rm -rf .', /项目目录本身/],
    [`rm -rf ${WORKSPACE}`, /项目目录本身/],
    ['touch .git/hooks/pre-commit', /配置文件/],
    ['cp README.md .git/hooks/pre-commit', /配置文件/],
    ['rm .git/config', /配置文件/],
    ['mkdir -p .claude', /配置文件/],
    ['cp README.md .mcp.json', /配置文件/],
    ['mv README.md .vscode/tasks.json', /配置文件/],
    ['mkdir -p web/.claude/commands', /配置文件/],
    ['mv .git old-git', /配置文件/],
  ];
  for (const [command, reason] of refused) assertRefused(restricted(command), reason, command);
});

test('file tools must resolve inside the folder, may not write control files, and globs cannot escape (review mediums)', () => {
  const approvedFile: [string, AnyRecord][] = [
    ['Write', { file_path: path.join(WORKSPACE, 'src/app.ts'), content: 'x' }],
    ['Write', { file_path: path.join(WORKSPACE, 'src/new/deep/file.ts'), content: 'x' }],
    ['Edit', { file_path: path.join(WORKSPACE, 'README.md'), old_string: 'a', new_string: 'b' }],
    ['Read', { file_path: 'README.md' }],
    ['Read', { file_path: path.join(WORKSPACE, '.git/config') }],
    ['Glob', { pattern: '**/*.{ts,tsx}' }],
    ['Glob', { pattern: `${WORKSPACE}/src/**/*.ts` }],
    ['Glob', { pattern: 'src/*.ts', path: path.join(WORKSPACE, 'src') }],
    ['Grep', { pattern: '/api/users|\\.\\./', path: WORKSPACE, glob: '*.ts' }],
    ['TodoWrite', { todos: [] }],
    ['ToolSearch', { query: 'select:TaskCreate' }],
    ['Task', { prompt: 'write tests', subagent_type: 'general-purpose' }],
  ];
  for (const [name, input] of approvedFile) assert.deepEqual(tool(name, input), { allow: true }, `${name} ${JSON.stringify(input)}`);

  const refusedFile: [string, AnyRecord, RegExp][] = [
    ['Edit', { file_path: path.join(HOME, '.bashrc'), old_string: 'a', new_string: 'b' }, /不在项目目录里/],
    ['Read', { file_path: path.join(SCRATCH, 'outside/secret.txt') }, /不在项目目录里/],
    ['Read', { file_path: path.join(WORKSPACE, 'escape/secret.txt') }, /符号链接/],
    ['Read', { file_path: path.join(WORKSPACE, 'secret-link.txt') }, /符号链接/],
    ['Write', { file_path: path.join(WORKSPACE, 'dangling.txt'), content: 'x' }, /符号链接/],
    ['Read', { file_path: '~/.ssh/id_rsa' }, /不在项目目录里/],
    ['Write', { file_path: path.join(WORKSPACE, '.claude/settings.local.json'), content: '{}' }, /配置文件/],
    ['Write', { file_path: path.join(WORKSPACE, '.claude/settings.json'), content: '{}' }, /配置文件/],
    ['Write', { file_path: path.join(WORKSPACE, '.mcp.json'), content: '{}' }, /配置文件/],
    ['Write', { file_path: path.join(WORKSPACE, '.git/hooks/pre-commit'), content: '#!/bin/sh' }, /配置文件/],
    ['Edit', { file_path: path.join(WORKSPACE, '.git/config'), old_string: 'a', new_string: 'b' }, /配置文件/],
    ['Write', { file_path: path.join(WORKSPACE, '.vscode/tasks.json'), content: '{}' }, /配置文件/],
    ['Write', { file_path: path.join(WORKSPACE, 'web/.CLAUDE/agents/x.md'), content: '' }, /配置文件/],
    ['NotebookEdit', { notebook_path: path.join(WORKSPACE, '.codex/x.ipynb'), new_source: '' }, /配置文件/],
    ['Glob', { pattern: `${HOME}/**` }, /匹配模式/],
    ['Glob', { pattern: '../**/*.env' }, /匹配模式/],
    ['Glob', { pattern: '{/etc,src}/**' }, /匹配模式/],
    ['Glob', { pattern: 'src/{a,/etc}/*' }, /匹配模式/],
    ['Glob', { pattern: '~/.ssh/*' }, /匹配模式/],
    ['Glob', { pattern: '*.ts', path: path.join(SCRATCH, 'outside') }, /不在项目目录里/],
    ['Grep', { pattern: 'password', glob: `${HOME}/*` }, /匹配模式/],
    ['Grep', { pattern: 'password', path: HOME }, /不在项目目录里/],
    ['Read', { file_path: 'README.md', extra_path: '/etc/passwd' }, /不在项目目录里/],
  ];
  for (const [name, input, reason] of refusedFile) assertRefused(tool(name, input), reason, `${name} ${JSON.stringify(input)}`);
});

test('the web, MCP, skills, worktrees, questions and unknown tools are refused in both modes', () => {
  for (const mode of ['restricted', 'sandbox'] as const) {
    assertRefused(tool('WebFetch', { url: 'https://example.com', prompt: 'x' }, mode), /网页/, `WebFetch ${mode}`);
    assertRefused(tool('WebSearch', { query: 'x' }, mode), /网页/, `WebSearch ${mode}`);
    assertRefused(tool('mcp__browser__navigate', { url: 'https://example.com' }, mode), /不在无人值守开发允许的列表中/, `MCP ${mode}`);
    assertRefused(tool('Skill', { skill: 'deploy' }, mode), /不在无人值守开发允许的列表中/, `Skill ${mode}`);
    assertRefused(tool('Monitor', { command: 'tail -f x' }, mode), /不在无人值守开发允许的列表中/, `Monitor ${mode}`);
    assertRefused(tool('Agent', { prompt: 'x', isolation: 'worktree' }, mode), /worktree/, `Agent worktree ${mode}`);
    assertRefused(tool('AskUserQuestion', { questions: [] }, mode), /无人值守/, `question ${mode}`);
    assertRefused(tool('ExitPlanMode', {}, mode), /无人值守/, `plan ${mode}`);
  }
});

test('sandboxed builds leave Bash to the OS sandbox but never let a command opt out of it', () => {
  assert.deepEqual(tool('Bash', { command: 'npm install && npm test' }, 'sandbox'), { allow: true });
  assert.deepEqual(tool('Bash', { command: 'cat ~/.ssh/id_rsa' }, 'sandbox'), { allow: true }, 'the sandbox, not the policy, hides the home directory');
  assertRefused(tool('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }, 'sandbox'), /沙箱/, 'opt out');
  assertRefused(tool('Bash', { command: '  ' }, 'sandbox'), /为空/, 'empty');
  // File tools keep the same rules in sandbox mode.
  assertRefused(tool('Write', { file_path: path.join(WORKSPACE, '.claude/settings.json'), content: '{}' }, 'sandbox'), /配置文件/, 'control file');
});

test('the sandbox counts as available only with bubblewrap and socat on Linux, or on macOS', () => {
  const bin = path.join(SCRATCH, 'bin');
  mkdirSync(bin);
  assert.deepEqual(detectBuildEnvironment(true, 'linux', bin), { mode: 'restricted', missing: ['bubblewrap', 'socat'], available: false });
  for (const program of ['bwrap', 'socat']) {
    writeFileSync(path.join(bin, program), '#!/bin/sh\n');
    chmodSync(path.join(bin, program), 0o755);
  }
  assert.deepEqual(detectBuildEnvironment(true, 'linux', `relative/bin${path.delimiter}${bin}`), { mode: 'sandbox', missing: [], available: true });
  chmodSync(path.join(bin, 'socat'), 0o644);
  assert.deepEqual(detectBuildEnvironment(true, 'linux', bin), { mode: 'restricted', missing: ['socat'], available: false });
  assert.deepEqual(detectBuildEnvironment(true, 'darwin', ''), { mode: 'sandbox', missing: [], available: true });
  assert.deepEqual(detectBuildEnvironment(true, 'win32', bin), { mode: 'restricted', missing: [], available: false });
});

test('the sandbox is strictly opt-in: bubblewrap and socat on PATH are not enough (review: unverified sandbox)', () => {
  const bin = path.join(SCRATCH, 'bin-opt-in');
  mkdirSync(bin);
  for (const program of ['bwrap', 'socat']) {
    writeFileSync(path.join(bin, program), '#!/bin/sh\n');
    chmodSync(path.join(bin, program), 0o755);
  }
  assert.deepEqual(detectBuildEnvironment(false, 'linux', bin), { mode: 'restricted', missing: [], available: true });
  assert.deepEqual(detectBuildEnvironment(false, 'darwin', ''), { mode: 'restricted', missing: [], available: true });
  assert.equal(detectBuildEnvironment(true, 'linux', bin).mode, 'sandbox');
  // A runner given no environment at all runs every turn restricted.
  const runner = createClaudeBuildRunner({
    runtime: {} as ProviderRuntimeGateway, runTurn: async () => ({ started: false, error: null }), getRun: () => undefined,
    completeRun: () => {}, readHistory: async () => [],
  });
  assert.equal(runner.environment().mode, 'restricted');
});

test('file tools and restricted commands refuse any symlink component, even one pointing inside the folder (review: TOCTOU)', () => {
  // A link inside the folder that points inside it is still refused: a link can be re-pointed after the check.
  mkdirSync(path.join(WORKSPACE, 'lib', 'nested'), { recursive: true });
  writeFileSync(path.join(WORKSPACE, 'lib', 'nested', 'index.ts'), 'export {};\n');
  symlinkSync(path.join(WORKSPACE, 'lib'), path.join(WORKSPACE, 'lib-link'));
  symlinkSync(path.join(WORKSPACE, 'README.md'), path.join(WORKSPACE, 'readme-link.md'));
  symlinkSync('nested', path.join(WORKSPACE, 'lib', 'nested-link'));
  for (const mode of ['restricted', 'sandbox'] as const) {
    const refused: [string, AnyRecord][] = [
      ['Read', { file_path: path.join(WORKSPACE, 'lib-link/nested/index.ts') }],
      ['Read', { file_path: 'readme-link.md' }],
      ['Write', { file_path: path.join(WORKSPACE, 'lib/nested-link/new.ts'), content: 'x' }],
      ['Edit', { file_path: 'lib/nested-link/index.ts', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: 'readme-link.md', edits: [] }],
      ['NotebookEdit', { notebook_path: 'lib-link/x.ipynb', new_source: '' }],
      ['Glob', { pattern: '*.ts', path: 'lib-link' }],
      ['Grep', { pattern: 'x', path: path.join(WORKSPACE, 'lib', 'nested-link') }],
      ['Glob', { pattern: `${WORKSPACE}/lib-link/**/*.ts` }],
    ];
    for (const [name, input] of refused) assert.equal(tool(name, input, mode).allow, false, `${mode} ${name} ${JSON.stringify(input)}`);
    // The same files, named without the links, are fine.
    assert.deepEqual(tool('Read', { file_path: path.join(WORKSPACE, 'lib/nested/index.ts') }, mode), { allow: true });
    assert.deepEqual(tool('Write', { file_path: 'lib/nested/new/deep.ts', content: 'x' }, mode), { allow: true });
  }
  assertRefused(tool('Read', { file_path: 'lib-link/nested/index.ts' }), /符号链接/, 'reason');
  assertRefused(restricted('cat lib-link/nested/index.ts'), /符号链接/, 'cat through a link');
  assertRefused(restricted('cp README.md lib/nested-link/copy.md'), /符号链接/, 'cp into a link');
  // Lexical parent steps cannot climb out either.
  assertRefused(tool('Read', { file_path: 'lib/nested/../../../outside/secret.txt' }), /不在项目目录里/, 'parent steps');
});

test('a build folder reached through a symlinked parent is still recognised by either spelling', () => {
  const alias = path.join(SCRATCH, 'projects-alias');
  symlinkSync(SCRATCH, alias);
  const aliased = path.join(alias, 'habit-tracker');
  assert.deepEqual(evaluateBuildPermission('Read', { file_path: path.join(aliased, 'README.md') }, aliased, 'restricted'), { allow: true });
  assert.deepEqual(evaluateBuildPermission('Read', { file_path: path.join(WORKSPACE, 'README.md') }, aliased, 'restricted'), { allow: true });
  assert.deepEqual(evaluateRestrictedCommand(`cat ${path.join(aliased, 'README.md')}`, aliased), { allow: true });
  assert.equal(evaluateBuildPermission('Read', { file_path: path.join(aliased, 'secret-link.txt') }, aliased, 'restricted').allow, false);
});

test('restricted commands are checked as written: only ASCII spaces are stripped, never tabs or newlines (review: trim)', () => {
  assert.deepEqual(restricted('  ls  '), { allow: true });
  for (const command of ['\nls', 'ls\n', '\tls', 'ls\t', 'git status\r', '\u00a0ls', 'ls\u2028', '\vls', '\fls']) {
    assertRefused(restricted(command), /受限模式只接受最简单的命令/, JSON.stringify(command));
    assert.equal(tool('Bash', { command }).allow, false, JSON.stringify(command));
  }
  assertRefused(restricted('   '), /为空/, 'spaces only');
});

const todoWrite = (toolId: string, todos: AnyRecord[]): NormalizedMessage => ({
  id: toolId, sessionId: 'p', timestamp: '', provider: 'claude', kind: 'tool_use', toolName: 'TodoWrite', toolId, toolInput: { todos },
});
type PolicyHook = { reviewToolUse: (toolName: string, input: unknown) => { allow: boolean; reason?: string }; sandbox?: AnyRecord; env?: Record<string, string> };
/** A scripted Claude runtime behind a fake runDetachedChatTurn, recording what the runner asks of it. */
function harness(
  script: (writer: ProviderRuntimeWriter, runtime: { prompt: (requestId: string, toolName: string, input: unknown) => Promise<ProviderPermissionDecision> }) => Promise<void>,
  environment: StudioBuildEnvironment = { mode: 'restricted', missing: ['socat'], available: false },
  gitIdentity: { name: string; email: string } | null = null,
) {
  const pending = new Map<string, (decision: ProviderPermissionDecision) => void>();
  const notifiedUsers: unknown[] = [];
  const turns: { content: string; options: AnyRecord; userId: number }[] = [];
  const realWriterEvents: NormalizedMessage[] = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: provider => provider === 'claude',
    async run(_provider, _command, _options, writer) {
      await script(writer, {
        prompt(requestId, toolName, input) {
          return new Promise(resolve => {
            writer.send({ id: requestId, sessionId: 'app-session', timestamp: '', provider: 'claude', kind: 'permission_request', requestId, toolName, input });
            // The Claude runtime decides about a push notification right after sending the prompt.
            notifiedUsers.push(writer.userId);
            pending.set(requestId, resolve);
          });
        },
      });
    },
    abort: async () => true,
    stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false,
    resolveToolApproval(requestId, decision) {
      pending.get(requestId)?.(decision);
      pending.delete(requestId);
    },
    getPendingApprovalsForSession: () => [...pending.keys()].map(requestId => ({ requestId })),
  };
  const runner = createClaudeBuildRunner({
    runtime,
    async runTurn(input, dependencies) {
      turns.push({ content: input.content, options: input.options, userId: input.userId });
      const writer: ProviderRuntimeWriter = { userId: input.userId, send: data => realWriterEvents.push(data as NormalizedMessage) };
      await dependencies.runtime.run('claude', input.content, { sessionId: input.sessionId }, writer);
      return { started: true, error: null };
    },
    getRun: () => undefined,
    completeRun: () => {},
    readHistory: async () => [],
    environment: () => environment,
    gitIdentity,
    home: '/home/owner',
    extraDomains: ['registry.npmmirror.com'],
  });
  return { runner, turns, notifiedUsers, realWriterEvents };
}

const complete = (writer: ProviderRuntimeWriter) => writer.send({ id: 'c', sessionId: 'app-session', timestamp: '', provider: 'claude', kind: 'complete', exitCode: 0, success: true, aborted: false });

test('a restricted build turn is isolated, decides every tool through the policy hook and follows the checklist', async () => {
  const decisions: ProviderPermissionDecision[] = [];
  const h = harness(async (writer, runtime) => {
    writer.send(todoWrite('t1', [{ content: '搭建项目', status: 'in_progress', activeForm: '正在搭建项目' }, { content: '写测试', status: 'pending' }]));
    // A prompt that still reaches the runtime is answered at once by the same policy, without a notification.
    decisions.push(await runtime.prompt('r1', 'Bash', { command: 'git status' }));
    decisions.push(await runtime.prompt('r2', 'Bash', { command: 'git push origin main' }));
    writer.send(todoWrite('t2', [{ content: '搭建项目', status: 'completed' }, { content: '写测试', status: 'completed' }]));
    complete(writer);
  });
  const checklists: StudioBuildTodo[][] = [];
  const outcome = await h.runner.start({ sessionId: 'app-session', userId: 7, content: '做一个习惯打卡应用', workspacePath: WORKSPACE, onChecklist: todos => checklists.push(todos) });

  assert.deepEqual(outcome, { started: true, success: true, error: null });
  const { options, content } = h.turns[0];
  assert.equal(options.permissionMode, 'default', 'never acceptEdits, plan or bypass');
  const settings = options.toolsSettings as { allowedTools: string[]; disallowedTools: string[]; skipPermissions: boolean };
  assert.equal(settings.skipPermissions, false);
  assert.ok(settings.allowedTools.every(entry => !entry.startsWith('Bash') && !entry.startsWith('Web')));
  assert.ok(settings.disallowedTools.includes('WebFetch') && settings.disallowedTools.includes('WebSearch'));
  // Restricted: the policy hook, and no sandbox.
  const isolation = options.buildIsolation as PolicyHook;
  assert.equal(isolation.sandbox, undefined);
  assert.equal(isolation.env, undefined);
  assert.deepEqual(isolation.reviewToolUse('Bash', { command: 'git commit -m done' }), { allow: true });
  const refused = isolation.reviewToolUse('Bash', { command: 'npm test' });
  assert.equal(refused.allow, false);
  assert.match(String(refused.reason), /无人值守开发策略拒绝了这个操作：受限模式只能运行/);
  assert.equal(isolation.reviewToolUse('Write', { file_path: path.join(WORKSPACE, '.claude/settings.local.json'), content: '{}' }).allow, false);
  // The agent is told what it can do here.
  assert.match(content, /^做一个习惯打卡应用/);
  assert.match(content, /受限模式/);
  assert.match(content, /git commit -m first-version/);

  assert.deepEqual(decisions[0], { allow: true });
  assert.equal(decisions[1].allow, false);
  assert.match(String(decisions[1].message), /git 只能用/);
  assert.deepEqual(h.notifiedUsers, [null, null], 'automatically answered prompts never push a notification');
  assert.deepEqual(checklists.map(list => list.map(todo => todo.status)), [['in_progress', 'pending'], ['completed', 'completed']]);
  assert.equal(checklists[0][0].activeForm, '正在搭建项目');
  // The registry's own writer still saw every event, so watchers and replay are unaffected.
  assert.equal(h.realWriterEvents.filter(event => event.kind === 'permission_request').length, 2);
  assert.deepEqual(h.runner.environment(), { mode: 'restricted', missing: ['socat'], available: false });
});

test('a sandboxed build turn runs Bash in the OS sandbox: folder-only writes, registries-only network, no home (review high)', async () => {
  const h = harness(async writer => { complete(writer); }, { mode: 'sandbox', missing: [], available: true }, { name: 'Owner Name', email: 'owner@example.test' });
  await h.runner.start({ sessionId: 'app-session', userId: 7, content: '做一个习惯打卡应用', workspacePath: WORKSPACE, onChecklist: () => {} });
  const { options, content } = h.turns[0];
  const isolation = options.buildIsolation as PolicyHook;
  const sandbox = isolation.sandbox as {
    enabled: boolean; failIfUnavailable: boolean; autoAllowBashIfSandboxed: boolean; allowUnsandboxedCommands: boolean;
    network: { allowedDomains: string[] }; filesystem: { denyWrite: string[]; denyRead: string[]; allowRead: string[] };
  };
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.failIfUnavailable, true, 'a sandbox that cannot start fails the turn');
  assert.equal(sandbox.allowUnsandboxedCommands, false, 'no dangerouslyDisableSandbox escape hatch');
  assert.equal(sandbox.autoAllowBashIfSandboxed, false, 'Bash still goes through the policy hook');
  assert.deepEqual(sandbox.network.allowedDomains, ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'registry.npmmirror.com']);
  assert.deepEqual(sandbox.filesystem.denyRead, ['/home/owner']);
  assert.equal(sandbox.filesystem.allowRead[0], WORKSPACE);
  assert.ok(sandbox.filesystem.allowRead.includes('/home/owner/.local/bin'));
  assert.ok(!sandbox.filesystem.allowRead.some(entry => /\.ssh|\.aws|\.config|\.claude|\.npmrc|\.cloudcli|\.gitconfig/.test(entry)),
    'no configuration under the home directory is readable: not ~/.gitconfig, not the shell snapshots');
  assert.deepEqual(sandbox.filesystem.allowRead.slice(1), [
    '.local/bin', '.local/lib', '.local/share/uv/python', '.local/share/pnpm', '.local/share/fnm', '.nvm', '.volta', '.bun', '.deno', '.pyenv',
  ].map(entry => path.join('/home/owner', entry)));
  // git commits with the owner's identity instead of reading ~/.gitconfig.
  assert.equal(isolation.env?.GIT_AUTHOR_NAME, 'Owner Name');
  assert.equal(isolation.env?.GIT_AUTHOR_EMAIL, 'owner@example.test');
  assert.equal(isolation.env?.GIT_COMMITTER_NAME, 'Owner Name');
  assert.equal(isolation.env?.GIT_COMMITTER_EMAIL, 'owner@example.test');
  for (const control of ['.claude', '.mcp.json', '.git/hooks', '.git/config', '.vscode']) {
    assert.ok(sandbox.filesystem.denyWrite.includes(path.join(WORKSPACE, control)), control);
  }
  assert.equal(isolation.env?.npm_config_cache, path.join(WORKSPACE, '.studio-cache', 'npm'));
  assert.equal(isolation.env?.UV_CACHE_DIR, path.join(WORKSPACE, '.studio-cache', 'uv'));
  assert.deepEqual(isolation.reviewToolUse('Bash', { command: 'npm install && npm test' }), { allow: true });
  assert.equal(isolation.reviewToolUse('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }).allow, false);
  assert.match(content, /沙箱/);
  // The package caches stay out of the agent's commit.
  assert.match(readFileSync(path.join(WORKSPACE, '.git', 'info', 'exclude'), 'utf8'), /^\/\.studio-cache\/$/m);
});

test('incremental TaskCreate / TaskUpdate calls are folded into one checklist', async () => {
  const h = harness(async writer => {
    writer.send({ id: 'a', sessionId: 's', timestamp: '', provider: 'claude', kind: 'tool_use', toolName: 'TaskCreate', toolId: 'call-1', toolInput: { subject: '写 README', activeForm: '正在写 README' } });
    writer.send({ id: 'b', sessionId: 's', timestamp: '', provider: 'claude', kind: 'tool_result', toolId: 'call-1', content: 'Task #1 created', toolUseResult: { task: { id: '1', subject: '写 README' } } });
    writer.send({ id: 'c', sessionId: 's', timestamp: '', provider: 'claude', kind: 'tool_use', toolName: 'TaskUpdate', toolId: 'call-2', toolInput: { taskId: '1', status: 'completed' } });
    writer.send({ id: 'd', sessionId: 's', timestamp: '', provider: 'claude', kind: 'complete', exitCode: 0, success: true });
  });
  const checklists: StudioBuildTodo[][] = [];
  await h.runner.start({ sessionId: 's', userId: 1, content: 'x', workspacePath: WORKSPACE, onChecklist: todos => checklists.push(todos) });
  assert.deepEqual(checklists.at(-1), [{ content: '写 README', status: 'completed', activeForm: '正在写 README' }]);
});

test('turns that never start, are stopped, or fail report why; inspect and readChecklist only read', async () => {
  const silent: ProviderRuntimeGateway = {
    hasRuntime: () => true, run: async () => undefined, abort: async () => true, stopBackgroundTask: async () => false,
    hasBackgroundWork: () => false, resolveToolApproval: () => {}, getPendingApprovalsForSession: () => [],
  };
  const aborted = { status: 'completed', startedAt: Date.now() + 1000, events: [{ id: 'x', sessionId: 's', timestamp: '', provider: 'claude', kind: 'complete', exitCode: 0, success: false, aborted: true } as NormalizedMessage] };
  let runCalls = 0;
  const completed: unknown[] = [];
  const base = {
    runtime: silent, completeRun: (sessionId: string, options: unknown) => { completed.push([sessionId, options]); },
    readHistory: async () => [todoWrite('h', [{ content: '完成', status: 'completed' }, { content: '收尾', status: 'pending' }])],
    environment: (): StudioBuildEnvironment => ({ mode: 'restricted', missing: [], available: false }),
  };
  const busy = createClaudeBuildRunner({ ...base, getRun: () => undefined, runTurn: async () => ({ started: false, error: 'A run was already in progress for this session.' }) });
  assert.deepEqual(await busy.start({ sessionId: 's', userId: 1, content: 'x', workspacePath: WORKSPACE, onChecklist: () => {} }),
    { started: false, success: false, error: 'A run was already in progress for this session.' });

  const stopped = createClaudeBuildRunner({ ...base, getRun: () => aborted, runTurn: async () => { runCalls += 1; return { started: true, error: null }; } });
  assert.deepEqual(await stopped.start({ sessionId: 's', userId: 1, content: 'x', workspacePath: WORKSPACE, onChecklist: () => {} }),
    { started: true, success: false, error: '开发已停止' });
  assert.equal(runCalls, 1);
  assert.equal(await stopped.abort('s'), true);
  assert.deepEqual(completed, [['s', { exitCode: 0, aborted: true }]]);

  const crashed = createClaudeBuildRunner({ ...base, getRun: () => undefined, runTurn: async () => ({ started: true, error: 'Claude Code process exited with code 1' }) });
  assert.deepEqual(await crashed.start({ sessionId: 's', userId: 1, content: 'x', workspacePath: WORKSPACE, onChecklist: () => {} }),
    { started: true, success: false, error: 'Claude Code process exited with code 1' });

  const running = { status: 'running', startedAt: 5, events: [todoWrite('t', [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }])] };
  const watcher = createClaudeBuildRunner({ ...base, getRun: () => running, runTurn: async () => ({ started: true, error: null }) });
  assert.deepEqual(watcher.inspect('s'), { running: true, startedAt: 5, success: null, todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] });
  assert.deepEqual((await watcher.readChecklist('s'))?.map(todo => todo.status), ['completed', 'pending']);
  assert.equal(createClaudeBuildRunner({ ...base, getRun: () => undefined, runTurn: async () => ({ started: true, error: null }) }).inspect('s'), null);
});

test('a prompt the owner already answered elsewhere is left alone', async () => {
  let resolved = 0;
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    async run(_provider, _command, _options, writer) {
      writer.send({ id: 'p', sessionId: 's', timestamp: '', provider: 'claude', kind: 'permission_request', requestId: 'gone', toolName: 'Bash', input: { command: 'git status' } });
      writer.send({ id: 'c', sessionId: 's', timestamp: '', provider: 'claude', kind: 'complete', exitCode: 0, success: true });
    },
    abort: async () => true, stopBackgroundTask: async () => false, hasBackgroundWork: () => false,
    resolveToolApproval: () => { resolved += 1; }, getPendingApprovalsForSession: () => [],
  };
  const runner = createClaudeBuildRunner({
    runtime, getRun: () => undefined, completeRun: () => {}, readHistory: async () => [],
    environment: () => ({ mode: 'restricted', missing: [], available: false }),
    async runTurn(input, dependencies) {
      await dependencies.runtime.run('claude', input.content, {}, { send: () => {} });
      return { started: true, error: null };
    },
  });
  await runner.start({ sessionId: 's', userId: 1, content: 'x', workspacePath: WORKSPACE, onChecklist: () => {} });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(resolved, 0);
});
