import assert from 'node:assert/strict';
import type { ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createRemoteHostsService } from '../remote-hosts.service.js';

const AJ = { name: 'aj', label: 'AJ 服务器', target: 'sp-remote', dir: '~/projects/super-professor' };

type ExecCall = { file: string; args: string[]; timeout: number; done: (error: ExecFileException | null, stdout: string, stderr: string) => void };

function fakeExec() {
  const calls: ExecCall[] = [];
  const execFile = (file: string, args: string[], options: { timeout: number }, done: ExecCall['done']) => {
    calls.push({ file, args, timeout: options.timeout, done });
  };
  return { calls, execFile };
}

function failure(fields: Partial<ExecFileException>) {
  return Object.assign(new Error('Command failed'), fields) as ExecFileException;
}

/**
 * POSIX word splitting for the local command line, supporting the only quoting the builder may use (single quotes,
 * including the '\'' idiom). Any unquoted character that bash would treat as syntax or expansion fails the test,
 * which proves the line runs exactly one ssh process with exactly these arguments.
 */
function shellWords(line: string) {
  const words: string[] = [];
  let word: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw new Error('unterminated single quote');
      word = (word ?? '') + line.slice(index + 1, end);
      index = end;
    } else if (char === '\\') {
      word = (word ?? '') + line[++index];
    } else if (char === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[\s;&|<>()$`"*?[\]{}~#!]/.test(char)) {
      throw new Error(`unquoted shell syntax ${JSON.stringify(char)} at ${index}`);
    } else {
      word = (word ?? '') + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const SSH_PREFIX = ['ssh', '-tt', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '--'];
const PATH_EXPORT = 'export PATH="$HOME/.local/bin:$PATH"';
const sessionHash = (dir: string) => createHash('sha256').update(dir).digest('hex').slice(0, 8);

test('registry keeps valid hosts and skips malicious or malformed entries without throwing', () => {
  const logs: string[] = [];
  const service = createRemoteHostsService({
    log: message => logs.push(message),
    hostsConfig: JSON.stringify([
      AJ,
      { name: 'lab', target: 'ops@lab.example-1.net' },
      { name: 'p1', target: '-oProxyCommand=x' },
      { name: 'p2', target: 'a b' },
      { name: 'p3', target: 'x;rm' },
      { name: 'p4', target: 'user@-oProxyCommand=x' },
      { name: 'p5', target: '$(id)' },
      { name: 'p6', target: 'host\n-oProxyCommand=x' },
      { name: 'p7', target: '' },
      { name: 'p8', target: 42 },
      { name: 'AJ', target: 'sp-remote' },
      { name: '-x', target: 'sp-remote' },
      { name: 'a'.repeat(33), target: 'sp-remote' },
      { name: 'aj', target: 'other' },
      { name: 'd1', target: 'sp-remote', dir: '~/../etc' },
      { name: 'd2', target: 'sp-remote', dir: '~/a b' },
      { name: 'd3', target: 'sp-remote', dir: 'relative/path' },
      { name: 'd4', target: 'sp-remote', dir: '~/x;rm -rf ~' },
      { name: 'd5', target: 'sp-remote', dir: '/srv/$(id)' },
      { name: 'l1', target: 'sp-remote', label: '' },
      { name: 'l2', target: 'sp-remote', label: 'x'.repeat(41) },
      'aj',
      null,
    ]),
  });
  assert.deepEqual(service.hosts(), [
    { name: 'aj', label: 'AJ 服务器', target: 'sp-remote' },
    { name: 'lab', label: 'lab', target: 'ops@lab.example-1.net' },
  ]);
  assert.deepEqual(service.names(), ['aj', 'lab']);
  assert.deepEqual(service.seeds(), [{ host: 'aj', label: 'AJ 服务器', dir: '~/projects/super-professor' }]);
  assert.equal(logs.length, 21);
  assert.ok(logs.every(line => line.startsWith('STUDIO_SSH_HOSTS entry #')));
  // Unvalidated values are never echoed into the server log.
  assert.ok(!logs.some(line => line.includes('ProxyCommand') || line.includes('rm')));
});

test('a missing, non-JSON or non-array registry yields no hosts', () => {
  const logs: string[] = [];
  for (const hostsConfig of [undefined, '', '{not json', '{"name":"aj"}']) {
    const service = createRemoteHostsService({ hostsConfig, log: message => logs.push(message) });
    assert.deepEqual(service.hosts(), []);
    assert.deepEqual(service.seeds(), []);
  }
  assert.equal(logs.length, 2);
});

test('status runs one fixed, shell-free ssh probe and parses the installed tools', async () => {
  let clock = 1_000;
  const exec = fakeExec();
  const service = createRemoteHostsService({ hostsConfig: JSON.stringify([AJ]), execFile: exec.execFile, now: () => clock });
  const first = service.status('aj');
  const concurrent = service.status('aj');
  assert.equal(exec.calls.length, 1, 'concurrent checks share one SSH login');
  const [call] = exec.calls;
  assert.equal(call.file, 'ssh');
  assert.equal(call.timeout, 12_000);
  assert.deepEqual(call.args, [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '--', 'sp-remote',
    `${PATH_EXPORT}; for t in claude codex tmux; do command -v "$t" >/dev/null && echo "$t=1" || echo "$t=0"; done`,
  ]);
  clock += 340;
  call.done(null, 'claude=0\r\ncodex=1\ntmux=0\n', '');
  const status = await first;
  assert.deepEqual(status, {
    name: 'aj', online: true, latencyMs: 340, checkedAt: new Date(1_340).toISOString(),
    tools: { claude: false, codex: true, tmux: false },
  });
  assert.equal(await concurrent, status);

  clock += 59_000;
  assert.equal(await service.status('aj'), status);
  assert.equal(exec.calls.length, 1, 'results are cached for a minute');
  clock += 2_000;
  const refreshed = service.status('aj');
  assert.equal(exec.calls.length, 2);
  exec.calls[1].done(null, 'claude=1\ncodex=1\ntmux=1\n', '');
  assert.deepEqual((await refreshed).tools, { claude: true, codex: true, tmux: true });
});

test('status maps connection failures to short offline messages', async () => {
  const cases: [Partial<ExecFileException>, string, RegExp][] = [
    [{ code: 255 }, 'aryan@host: Permission denied (publickey).\r\n', /认证失败/],
    [{ code: 255 }, 'Host key verification failed.\n', /主机密钥/],
    [{ code: 255 }, 'ssh: Could not resolve hostname nope: Name or service not known\n', /无法解析/],
    [{ code: 255 }, 'ssh: connect to host 10.0.0.1 port 22: Connection refused\n', /连接被拒绝/],
    [{ code: 255 }, 'ssh: connect to host 10.0.0.1 port 22: Connection timed out\n', /连接超时/],
    [{ killed: true, signal: 'SIGTERM', code: null }, '', /连接超时/],
    [{ code: 'ENOENT' }, '', /没有可用的 ssh/],
    [{ code: 255 }, `\u001b[31m${'kex_exchange_identification: '.repeat(20)}\u0007\n`, /^SSH 连接失败：kex_exchange_identification/],
  ];
  for (const [error, stderr, expected] of cases) {
    const exec = fakeExec();
    const service = createRemoteHostsService({ hostsConfig: JSON.stringify([AJ]), execFile: exec.execFile });
    const pending = service.status('aj');
    exec.calls[0].done(failure(error), '', stderr);
    const status = await pending;
    assert.equal(status.online, false);
    assert.equal(status.latencyMs, null);
    assert.deepEqual(status.tools, { claude: false, codex: false, tmux: false });
    assert.match(status.error ?? '', expected);
    assert.ok((status.error ?? '').length <= 120);
    assert.doesNotMatch(status.error ?? '', /[\u0000-\u001f\u007f]/);
  }
});

test('status reports a reachable host whose probe misbehaves, a throwing spawn, and unknown hosts', async () => {
  const exec = fakeExec();
  const service = createRemoteHostsService({ hostsConfig: JSON.stringify([AJ, { name: 'lab', target: 'lab' }, { name: 'odd', target: 'odd' }]), execFile: exec.execFile });
  const lab = service.status('lab');
  exec.calls[0].done(failure({ code: 127 }), '', 'fish: Unknown command\n');
  const labStatus = await lab;
  assert.equal(labStatus.online, true);
  assert.match(labStatus.error ?? '', /POSIX/);
  const odd = service.status('odd');
  exec.calls[1].done(null, 'Welcome!\n', '');
  assert.match((await odd).error ?? '', /无法识别/);

  const throwing = createRemoteHostsService({
    hostsConfig: JSON.stringify([AJ]),
    execFile: () => { throw failure({ code: 'EAGAIN' }); },
  });
  assert.equal((await throwing.status('aj')).online, false);

  await assert.rejects(service.status('nope'), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  await assert.rejects(service.status('aj; rm -rf ~'), (error: unknown) => error instanceof AppError && error.statusCode === 404);
  assert.equal(exec.calls.length, 2);
});

test('command builds exact ssh lines for every agent, with a tmux branch and a direct fallback', () => {
  const service = createRemoteHostsService({ hostsConfig: JSON.stringify([AJ]) });
  const dir = AJ.dir;
  const hash = sessionHash(dir);
  const expected = {
    claude: {
      title: 'Claude Code · AJ 服务器',
      remote: `${PATH_EXPORT}; cd ${dir} || exit 1; mkdir -p "$HOME/.studio/claude"; `
        + 'command -v claude >/dev/null 2>&1 || { echo "远程主机上找不到 claude，请先安装" >&2; exit 127; }; '
        + `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s studio-claude-${hash} -c "$PWD" `
        + `'${PATH_EXPORT}; CLAUDE_CONFIG_DIR="$HOME/.studio/claude" exec claude'; `
        + 'else CLAUDE_CONFIG_DIR="$HOME/.studio/claude" exec claude; fi',
    },
    codex: {
      title: 'Codex · AJ 服务器',
      remote: `${PATH_EXPORT}; cd ${dir} || exit 1; mkdir -p "$HOME/.studio/codex"; `
        + 'command -v codex >/dev/null 2>&1 || { echo "远程主机上找不到 codex，请先安装" >&2; exit 127; }; '
        + `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s studio-codex-${hash} -c "$PWD" `
        + `'${PATH_EXPORT}; CODEX_HOME="$HOME/.studio/codex" exec codex'; `
        + 'else CODEX_HOME="$HOME/.studio/codex" exec codex; fi',
    },
    shell: {
      title: '终端 · AJ 服务器',
      remote: `${PATH_EXPORT}; cd ${dir} || exit 1; `
        + `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s studio-shell-${hash} -c "$PWD" `
        + `'${PATH_EXPORT}; exec "$SHELL" -l'; `
        + 'else exec "$SHELL" -l; fi',
    },
  };
  for (const agent of ['claude', 'codex', 'shell'] as const) {
    const launch = service.command('aj', dir, agent);
    assert.equal(launch.title, expected[agent].title);
    // The remote script reaches ssh as one argument, so the local bash runs nothing but ssh.
    assert.deepEqual(shellWords(launch.command), [...SSH_PREFIX, 'sp-remote', expected[agent].remote]);
    // The exact text bash receives: the nested tmux quotes use the '\'' idiom inside the outer single quotes.
    assert.equal(launch.command, `${SSH_PREFIX.join(' ')} sp-remote '${expected[agent].remote.replaceAll("'", `'\\''`)}'`);
  }
});

test('command keeps every allowed directory inert and rejects anything outside the registry and rules', () => {
  const service = createRemoteHostsService({ hostsConfig: JSON.stringify([AJ, { name: 'lab', target: 'ops@lab.internal' }]) });
  for (const dir of ['~', '~/', '/srv/app-1', '~/a.b_c/d-e', '/opt/x/y.z']) {
    const words = shellWords(service.command('lab', dir, 'codex').command);
    assert.deepEqual(words.slice(0, -1), [...SSH_PREFIX, 'ops@lab.internal']);
    assert.ok(words.at(-1)?.includes(`; cd ${dir} || exit 1; `));
    assert.ok(words.at(-1)?.includes(`studio-codex-${sessionHash(dir)} `));
  }
  const rejects = (run: () => unknown, status: number) => assert.throws(run, (error: unknown) => error instanceof AppError && error.statusCode === status);
  rejects(() => service.command('nope', '~/x', 'claude'), 404);
  rejects(() => service.command('sp-remote', '~/x', 'claude'), 404);
  for (const dir of ['~/x; rm -rf ~', '~/../etc', '../x', 'x', '', '~/a b', "~/a'b", '~/$(id)', '-rf', `~/${'a'.repeat(300)}`]) {
    rejects(() => service.command('aj', dir, 'claude'), 400);
  }
  rejects(() => service.command('aj', '~/x', 'bash' as never), 400);
  rejects(() => service.command('aj', '~/x', '__proto__' as never), 400);
});
