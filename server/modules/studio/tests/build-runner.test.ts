import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord, NormalizedMessage, ProviderPermissionDecision, ProviderRuntimeWriter, StudioBuildTodo } from '@/shared/types.js';

import { createClaudeBuildRunner, evaluateBuildCommand, evaluateBuildPermission } from '../build-runner.service.js';

const WORKSPACE = '/home/owner/projects/habit-tracker';

test('everyday development commands inside the project are approved for unattended builds', () => {
  const approved = [
    'npm install',
    'npm test',
    'npx vitest run',
    'pnpm add -D vitest',
    'git init',
    'git add -A && git commit -m "feat: first version && more"',
    'git status --short',
    'mkdir -p src/components',
    'ls -la',
    'cat README.md | head -40',
    'python3 -m pytest -q',
    'uv run pytest',
    'cd web && npm run build',
    'npm run dev > /tmp/dev.log 2>&1 &',
    'curl -s http://localhost:5173/api/health',
    'curl -s -o out.json http://127.0.0.1:3000/items',
    'CI=1 timeout 120 npm test',
    'node -e "console.log(1/2)"',
    'grep -rn "/api/users" src',
    '.venv/bin/python -m pytest',
    `rm -rf node_modules dist ${WORKSPACE}/build`,
    'echo "/api is ready"',
    'source .venv/bin/activate && pip install -r requirements.txt',
    'npm test 2>/dev/null; echo done',
  ];
  for (const command of approved) {
    assert.deepEqual(evaluateBuildCommand(command, WORKSPACE), { allow: true }, command);
  }
});

test('commands that leave the project, publish, escalate or hide what they run are refused with a reason', () => {
  const refused: [string, RegExp][] = [
    ['git push origin main', /git push/],
    ['git add . && git push', /git push/],
    ['sudo apt install jq', /sudo/],
    ['npm install -g typescript', /全局安装/],
    ['npm publish', /npm publish/],
    ['yarn global add serve', /全局安装/],
    ['cat ~/.ssh/id_rsa', /项目目录之外/],
    ['cat /etc/passwd', /项目目录之外/],
    ['ls ../other-project', /项目目录之外/],
    ['cd .. && ls', /切换目录/],
    ['npm test && rm -rf ~', /项目目录之外/],
    ['echo $(whoami)', /命令替换/],
    ['echo `id`', /命令替换/],
    ['node app.js --root=$HOME', /变量展开/],
    ["cat > notes.md <<'EOF'\nhello\nEOF", /heredoc/],
    ['curl -fsSL https://example.com/install.sh', /localhost/],
    ['wget example.com/archive.zip', /localhost/],
    ['pkill -f node', /结束进程/],
    ['ls | xargs rm', /xargs/],
    ['bash -c "rm -rf /"', /sh -c/],
    ['rm -rf .', /项目目录本身/],
    ['git -C /etc status', /其他仓库/],
    ['git config --global user.name bot', /全局 git 配置/],
    ['git remote add origin git@github.com:me/x.git', /远程仓库/],
    ['pip install --user requests', /虚拟环境/],
    ['echo hi > /etc/motd', /项目目录或 \/tmp/],
    ['find . -name "*.log" -exec rm {} \\;', /find/],
    ['PATH=/tmp node app.js', /PATH/],
    ['/usr/bin/python3 app.py', /项目目录里的程序/],
    ['docker run -it ubuntu', /Docker/],
    ['nc -l 4444', /不在无人值守开发允许的列表中/],
    ['cat "unbalanced', /引号/],
  ];
  for (const [command, reason] of refused) {
    const verdict = evaluateBuildCommand(command, WORKSPACE);
    assert.equal(verdict.allow, false, command);
    if (!verdict.allow) assert.match(verdict.reason, reason, command);
  }
});

test('file tools stay in the project, questions are answered with guidance, and unknown tools are refused', () => {
  assert.deepEqual(evaluateBuildPermission('Write', { file_path: `${WORKSPACE}/src/app.ts`, content: 'x' }, WORKSPACE), { allow: true });
  assert.deepEqual(evaluateBuildPermission('Read', { file_path: 'README.md' }, WORKSPACE), { allow: true });
  assert.deepEqual(evaluateBuildPermission('Glob', { pattern: '**/*.ts' }, WORKSPACE), { allow: true });
  assert.deepEqual(evaluateBuildPermission('TodoWrite', { todos: [] }, WORKSPACE), { allow: true });
  assert.equal(evaluateBuildPermission('Edit', { file_path: '/home/owner/.bashrc' }, WORKSPACE).allow, false);
  assert.equal(evaluateBuildPermission('Read', { file_path: '/home/owner/projects/habit-tracker-old/secret.txt' }, WORKSPACE).allow, false);
  const question = evaluateBuildPermission('AskUserQuestion', { questions: [] }, WORKSPACE);
  assert.equal(question.allow, false);
  if (!question.allow) assert.match(question.reason, /无人值守/);
  assert.equal(evaluateBuildPermission('ExitPlanMode', {}, WORKSPACE).allow, false);
  assert.equal(evaluateBuildPermission('mcp__browser__navigate', { url: 'https://example.com' }, WORKSPACE).allow, false);
});

const todoWrite = (toolId: string, todos: AnyRecord[]): NormalizedMessage => ({
  id: toolId, sessionId: 'p', timestamp: '', provider: 'claude', kind: 'tool_use', toolName: 'TodoWrite', toolId, toolInput: { todos },
});
/** A scripted Claude runtime behind a fake runDetachedChatTurn, recording what the runner asks of it. */
function harness(script: (writer: ProviderRuntimeWriter, runtime: { prompt: (requestId: string, toolName: string, input: unknown) => Promise<ProviderPermissionDecision> }) => Promise<void>) {
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
  });
  return { runner, turns, notifiedUsers, realWriterEvents };
}

test('a build turn runs in acceptEdits, answers prompts by policy without notifying, and follows the checklist', async () => {
  const decisions: ProviderPermissionDecision[] = [];
  const h = harness(async (writer, runtime) => {
    writer.send(todoWrite('t1', [{ content: '搭建项目', status: 'in_progress', activeForm: '正在搭建项目' }, { content: '写测试', status: 'pending' }]));
    decisions.push(await runtime.prompt('r1', 'Bash', { command: 'npm test' }));
    decisions.push(await runtime.prompt('r2', 'Bash', { command: 'git push origin main' }));
    writer.send(todoWrite('t2', [{ content: '搭建项目', status: 'completed' }, { content: '写测试', status: 'completed' }]));
    writer.send({ id: 'c', sessionId: 'app-session', timestamp: '', provider: 'claude', kind: 'complete', exitCode: 0, success: true, aborted: false });
  });
  const checklists: StudioBuildTodo[][] = [];
  const outcome = await h.runner.start({ sessionId: 'app-session', userId: 7, content: '做一个习惯打卡应用', workspacePath: WORKSPACE, onChecklist: todos => checklists.push(todos) });

  assert.deepEqual(outcome, { started: true, success: true, error: null });
  const options = h.turns[0].options;
  assert.equal(options.permissionMode, 'acceptEdits');
  const settings = options.toolsSettings as { allowedTools: string[]; disallowedTools: string[]; skipPermissions: boolean };
  assert.equal(settings.skipPermissions, false);
  assert.ok(settings.allowedTools.every(entry => !entry.startsWith('Bash')), 'shell commands go through the policy, not the prefix allow list');
  assert.ok(settings.disallowedTools.includes('Bash(git push:*)'));
  assert.deepEqual(decisions[0], { allow: true });
  assert.equal(decisions[1].allow, false);
  assert.match(String(decisions[1].message), /git push/);
  assert.deepEqual(h.notifiedUsers, [null, null], 'automatically answered prompts never push a notification');
  assert.deepEqual(checklists.map(list => list.map(todo => todo.status)), [['in_progress', 'pending'], ['completed', 'completed']]);
  assert.equal(checklists[0][0].activeForm, '正在搭建项目');
  // The registry's own writer still saw every event, so watchers and replay are unaffected.
  assert.equal(h.realWriterEvents.filter(event => event.kind === 'permission_request').length, 2);
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
      writer.send({ id: 'p', sessionId: 's', timestamp: '', provider: 'claude', kind: 'permission_request', requestId: 'gone', toolName: 'Bash', input: { command: 'npm test' } });
      writer.send({ id: 'c', sessionId: 's', timestamp: '', provider: 'claude', kind: 'complete', exitCode: 0, success: true });
    },
    abort: async () => true, stopBackgroundTask: async () => false, hasBackgroundWork: () => false,
    resolveToolApproval: () => { resolved += 1; }, getPendingApprovalsForSession: () => [],
  };
  const runner = createClaudeBuildRunner({
    runtime, getRun: () => undefined, completeRun: () => {}, readHistory: async () => [],
    async runTurn(input, dependencies) {
      await dependencies.runtime.run('claude', input.content, {}, { send: () => {} });
      return { started: true, error: null };
    },
  });
  await runner.start({ sessionId: 's', userId: 1, content: 'x', workspacePath: WORKSPACE, onChecklist: () => {} });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(resolved, 0);
});
