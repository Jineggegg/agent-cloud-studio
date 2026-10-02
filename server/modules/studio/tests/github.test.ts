import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioGhExecFile, StudioGhResult, StudioGhRun } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createGhRunner, resolveGhPath } from '../github/github-cli.adapter.js';
import { createGitHubService, parseGitHubMergeRequest, parseGitHubPullRef } from '../github/github.service.js';

const HEAD = '6a86614f929c0d67be9d4124b066832715d7d698';
const MOVED = '1111111111111111111111111111111111111111';
const TOKEN = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';
const STATUS_ARGS = ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'];

type Call = { args: string[]; timeoutMs: number };
type Responder = (args: string[]) => StudioGhResult | Promise<StudioGhResult>;

const ok = (value: unknown): StudioGhResult => ({ ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value) });
const failed = (stderr: string, stdout = ''): StudioGhResult => ({ ok: false, reason: 'failed', stdout, stderr, exitCode: 1 });

const STATUS_OK = ok({
  hosts: { 'github.com': [{ active: true, host: 'github.com', login: 'Jineggegg', scopes: 'gist, read:org, repo, workflow', state: 'success', tokenSource: '/home/me/.config/gh/hosts.yml', token: TOKEN }] },
});

function pullNode(overrides: Record<string, unknown> = {}) {
  return {
    number: 114, title: 'Make Lotus Bun a baking space', url: 'https://github.com/Jineggegg/super-professor/pull/114', isDraft: false,
    updatedAt: '2026-09-30T16:13:39Z', headRefName: 'feat/lotus', baseRefName: 'main', headRefOid: HEAD,
    additions: 20, deletions: 3, changedFiles: 2, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
    author: { login: 'nm2064' }, repository: { nameWithOwner: 'Jineggegg/super-professor' },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
      checkRunCountsByState: [{ state: 'SUCCESS', count: 2 }, { state: 'FAILURE', count: 1 }, { state: 'IN_PROGRESS', count: 0 }],
      statusContextCountsByState: [{ state: 'PENDING', count: 1 }],
    } } } }] },
    ...overrides,
  };
}

type Check = { name: string; conclusion?: string | null; status?: string; required?: boolean; url?: string };

function detailData({ pull = {}, repository = {}, checks = [] as Check[] }: { pull?: Record<string, unknown>; repository?: Record<string, unknown>; checks?: Check[] } = {}) {
  return {
    data: { repository: {
      nameWithOwner: 'Jineggegg/super-professor', viewerPermission: 'ADMIN', mergeCommitAllowed: true, squashMergeAllowed: true,
      rebaseMergeAllowed: false, deleteBranchOnMerge: true, ...repository,
      pullRequest: {
        ...pullNode(), state: 'OPEN', body: 'Line one\r\nLine two\u0007', createdAt: '2026-09-29T10:00:00Z', isCrossRepository: false, mergeCommit: null,
        files: { totalCount: 2, nodes: [{ path: 'app/ai.py', additions: 18, deletions: 3, changeType: 'MODIFIED' }, { path: 'docs/new.md', additions: 2, deletions: 0, changeType: 'ADDED' }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: checks.length, nodes: checks.map(check => ({
          __typename: 'CheckRun', name: check.name, status: check.status ?? 'COMPLETED', conclusion: check.conclusion === undefined ? 'SUCCESS' : check.conclusion,
          detailsUrl: check.url ?? 'https://github.com/Jineggegg/super-professor/actions/runs/1', isRequired: check.required === true,
          checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
        })) } } } }] },
        ...pull,
      },
    } },
  };
}

function fakeGh(responders: Record<string, Responder>) {
  const calls: Call[] = [];
  const run: StudioGhRun = async (args, options) => {
    calls.push({ args, timeoutMs: options.timeoutMs });
    if (args[0] === 'auth') return (responders.status ?? (() => STATUS_OK))(args);
    if (args[0] === 'pr' && args[1] === 'merge') return (responders.merge ?? (() => ok('')))(args);
    const query = args[3] ?? '';
    if (query.includes('search(')) return (responders.inbox ?? (() => ok({ data: { authored: { issueCount: 0, nodes: [] }, review: { issueCount: 0, nodes: [] }, owned: { issueCount: 0, nodes: [] } } })))(args);
    if (query.includes('pullRequest(number')) return (responders.detail ?? (() => ok(detailData())))(args);
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  const of = (kind: 'status' | 'inbox' | 'detail' | 'merge') => calls.filter(call =>
    kind === 'status' ? call.args[0] === 'auth'
      : kind === 'merge' ? call.args[0] === 'pr'
        : call.args[0] === 'api' && call.args[3].includes(kind === 'inbox' ? 'search(' : 'pullRequest(number'));
  return { calls, run, of };
}

function setup(responders: Record<string, Responder> = {}) {
  const gh = fakeGh(responders);
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const database = new Database(':memory:');
  const service = createGitHubService({ database, run: gh.run, now: () => clock });
  return { gh, service, database, advance: (ms: number) => { clock += ms; } };
}

const REF = { owner: 'Jineggegg', repo: 'super-professor', number: 114 };
const MERGE = { method: 'squash' as const, expectedHeadSha: HEAD, deleteBranch: false, acknowledgeFailing: false };

async function rejectsWith(promise: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status) assert.equal(error.statusCode, status);
    return true;
  });
}

test('status runs gh auth status with exact args, keeps only safe fields and never returns the token', async () => {
  const { gh, service } = setup();
  const status = await service.status();
  assert.deepEqual(gh.calls[0].args, STATUS_ARGS);
  assert.deepEqual(status, {
    installed: true, authenticated: true, login: 'Jineggegg', scopes: ['gist', 'read:org', 'repo', 'workflow'], canMerge: true, message: null,
    checkedAt: '2026-10-02T12:00:00.000Z',
  });
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.ok(!JSON.stringify(status).includes('hosts.yml'));
});

test('status reports a missing gh, a signed-out gh and a token without the repo scope', async () => {
  const missing = setup({ status: () => ({ ok: false, reason: 'missing', stdout: '', stderr: '', exitCode: null }) });
  const absent = await missing.service.status();
  assert.equal(absent.installed, false);
  assert.equal(absent.authenticated, false);
  assert.match(absent.message ?? '', /STUDIO_GH_PATH/);

  const signedOut = setup({ status: () => ok({ hosts: {} }) });
  assert.deepEqual({ ...(await signedOut.service.status()), checkedAt: '' }, {
    installed: true, authenticated: false, login: null, scopes: [], canMerge: false, message: 'gh 还没有登录 GitHub：请在服务器上运行 gh auth login', checkedAt: '',
  });

  const expired = setup({ status: () => ok({ hosts: { 'github.com': [{ active: true, login: 'Jineggegg', scopes: 'repo', state: 'error' }] } }) });
  const stale = await expired.service.status();
  assert.equal(stale.authenticated, false);
  assert.equal(stale.login, 'Jineggegg');

  const narrow = setup({ status: () => ok({ hosts: { 'github.com': [{ active: true, login: 'Jineggegg', scopes: 'read:org, gist', state: 'success' }] } }) });
  const limited = await narrow.service.status();
  assert.equal(limited.authenticated, true);
  assert.equal(limited.canMerge, false);
  assert.match(limited.message ?? '', /gh auth refresh -s repo/);
});

test('the inbox runs one GraphQL search per reason with exact args, dedupes, sorts and skips unusable nodes', async () => {
  const { gh, service } = setup({
    inbox: () => ok({ data: {
      authored: { issueCount: 1, nodes: [pullNode()] },
      review: { issueCount: 3, nodes: [
        pullNode({ number: 9, title: 'Fix\u0000 the\nbuild', updatedAt: '2026-10-01T08:00:00Z', repository: { nameWithOwner: 'acme/api' }, url: 'javascript:alert(1)', reviewDecision: 'REVIEW_REQUIRED', commits: { nodes: [] } }),
        pullNode({ number: 10, repository: { nameWithOwner: '-x/evil' } }),
      ] },
      owned: { issueCount: 2, nodes: [pullNode(), pullNode({ number: 12, headRefOid: 'not-a-sha' })] },
    } }),
  });
  const inbox = await service.pulls();
  const search = gh.of('inbox')[0];
  assert.equal(search.args.length, 10);
  assert.deepEqual([search.args[0], search.args[1], search.args[2]], ['api', 'graphql', '-f']);
  assert.match(search.args[3], /^query=query\(\$authored: String!, \$review: String!, \$owned: String!\)/);
  assert.deepEqual(search.args.slice(4), [
    '-f', 'authored=is:pr is:open archived:false author:@me sort:updated-desc',
    '-f', 'review=is:pr is:open archived:false review-requested:@me sort:updated-desc',
    '-f', 'owned=is:pr is:open archived:false user:@me sort:updated-desc',
  ]);
  assert.equal(search.timeoutMs, 20_000);
  assert.equal(inbox.login, 'Jineggegg');
  assert.equal(inbox.truncated, true);
  assert.deepEqual(inbox.pulls.map(pull => pull.id), ['acme/api#9', 'Jineggegg/super-professor#114']);
  const [review, mine] = inbox.pulls;
  assert.equal(review.title, 'Fix the build');
  assert.equal(review.url, 'https://github.com/acme/api/pull/9');
  assert.equal(review.reviewDecision, 'review_required');
  assert.deepEqual(review.checks, { state: 'none', passing: 0, failing: 0, pending: 0, total: 0 });
  assert.deepEqual(mine.reasons, ['authored', 'owned']);
  assert.deepEqual(mine.checks, { state: 'failing', passing: 2, failing: 1, pending: 1, total: 4 });
  assert.equal(mine.mergeable, 'mergeable');
  assert.equal(mine.mergeState, 'clean');
  assert.equal(mine.headSha, HEAD);
});

test('the inbox is cached for 45 s, single-flight, and a forced refresh only refetches after 5 s', async () => {
  const { gh, service, advance } = setup();
  await Promise.all([service.pulls(), service.pulls()]);
  assert.equal(gh.of('inbox').length, 1);
  advance(30_000);
  await service.pulls();
  assert.equal(gh.of('inbox').length, 1);
  advance(16_000);
  await service.pulls();
  assert.equal(gh.of('inbox').length, 2);
  advance(2_000);
  await service.pulls(true);
  assert.equal(gh.of('inbox').length, 2, 'a forced refresh right after a fetch reuses it');
  advance(4_000);
  await service.pulls(true);
  assert.equal(gh.of('inbox').length, 3);
  // The account check has its own minute-long cache.
  assert.equal(gh.of('status').length, 1);
});

test('the inbox explains a signed-out gh with the account check rather than the search failure', async () => {
  const { service } = setup({
    status: () => ok({ hosts: {} }),
    inbox: () => failed('To get started with GitHub CLI, please run:  gh auth login'),
  });
  await rejectsWith(service.pulls(), 'GH_NOT_AUTHENTICATED', 409);
  const offline = setup({ inbox: () => failed('error connecting to api.github.com: dial tcp: lookup api.github.com: no such host') });
  await rejectsWith(offline.service.pulls(), 'GH_OFFLINE', 502);
});

test('gh failures never leak raw output or token-shaped strings', async () => {
  const { service } = setup({ inbox: () => failed(`\u001b[31mHTTP 500: boom for ${TOKEN}\u001b[0m\nsecond line ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZ`) });
  await assert.rejects(service.pulls(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'GH_FAILED');
    assert.ok(!error.message.includes('ghp_'), error.message);
    assert.ok(!error.message.includes('\u001b'));
    assert.equal(error.message, 'gh 执行失败：second line [已隐藏]');
    return true;
  });
});

test('pull detail uses exact GraphQL args and maps checks, files, body and blockers', async () => {
  const { gh, service } = setup({
    detail: () => ok(detailData({ checks: [
      { name: 'lint' },
      { name: 'unit', conclusion: 'FAILURE', required: true },
      { name: 'e2e', status: 'IN_PROGRESS', conclusion: null },
      { name: 'docs', conclusion: 'SKIPPED', url: 'http://insecure.example/run' },
    ] })),
  });
  const detail = await service.pull(REF);
  const call = gh.of('detail')[0];
  assert.deepEqual([...call.args.slice(0, 3), ...call.args.slice(4)], ['api', 'graphql', '-f', '-f', 'owner=Jineggegg', '-f', 'repo=super-professor', '-F', 'number=114']);
  assert.match(call.args[3], /isRequired\(pullRequestNumber: \$number\)/);
  assert.deepEqual(detail.checkItems.map(check => [check.name, check.state, check.required]), [
    ['unit', 'failing', true], ['e2e', 'pending', false], ['lint', 'passing', false], ['docs', 'skipped', false],
  ]);
  assert.equal(detail.checkItems[3].url, null);
  assert.deepEqual(detail.checks, { state: 'failing', passing: 2, failing: 1, pending: 1, total: 4 });
  assert.equal(detail.body, 'Line one\nLine two');
  assert.deepEqual(detail.files.map(file => [file.path, file.change]), [['app/ai.py', 'modified'], ['docs/new.md', 'added']]);
  assert.deepEqual(detail.mergeMethods, ['squash', 'merge']);
  assert.equal(detail.deleteBranchOnMerge, true);
  assert.deepEqual(detail.blockers, [{ code: 'REQUIRED_CHECKS_FAILED', message: '必需检查未通过：unit' }]);
  await service.pull(REF);
  assert.equal(gh.of('detail').length, 1, 'cached');

  const missing = setup({ detail: () => ok({ data: { repository: null } }) });
  await rejectsWith(missing.service.pull(REF), 'GITHUB_NOT_FOUND', 404);
});

test('merge passes --match-head-commit with exact args and records the merged attempt', async () => {
  let merged = false;
  const { gh, service, database } = setup({
    merge: () => { merged = true; return ok(''); },
    detail: () => ok(detailData({ pull: merged ? { state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } } : {} })),
  });
  await service.pulls();
  const result = await service.merge(7, REF, { ...MERGE, deleteBranch: true });
  assert.deepEqual(gh.of('merge')[0].args, ['pr', 'merge', '114', '--repo', 'Jineggegg/super-professor', '--squash', '--match-head-commit', HEAD, '--delete-branch']);
  assert.equal(gh.of('merge')[0].timeoutMs, 60_000);
  assert.deepEqual(result, { outcome: 'merged', mergeCommitSha: 'a'.repeat(40), message: '已压缩合并 #114 到 main' });
  // Fresh read before the merge, confirmation read after it.
  assert.equal(gh.of('detail').length, 2);
  const [record] = service.merges(7);
  assert.equal(record.outcome, 'merged');
  assert.equal(record.headSha, HEAD);
  assert.equal(record.deleteBranch, true);
  assert.ok(record.finishedAt);
  assert.deepEqual(service.merges(8), []);
  // The inbox cache was dropped, so the merged PR disappears on the next read.
  await service.pulls();
  assert.equal(gh.of('inbox').length, 2);
  assert.equal((database.prepare('SELECT COUNT(*) AS total FROM studio_github_merges').get() as { total: number }).total, 1);
});

test('merge refuses a moved head, failing required checks, drafts, conflicts and disabled methods without calling gh pr merge', async () => {
  const cases: Array<{ name: string; detail: ReturnType<typeof detailData>; request?: Partial<typeof MERGE>; code: string; status: number }> = [
    { name: 'moved head', detail: detailData({ pull: { headRefOid: MOVED } }), code: 'HEAD_MOVED', status: 409 },
    { name: 'required failing', detail: detailData({ checks: [{ name: 'unit', conclusion: 'FAILURE', required: true }] }), request: { acknowledgeFailing: true }, code: 'REQUIRED_CHECKS_FAILED', status: 409 },
    { name: 'required pending', detail: detailData({ checks: [{ name: 'unit', status: 'QUEUED', conclusion: null, required: true }] }), code: 'REQUIRED_CHECKS_PENDING', status: 409 },
    { name: 'draft', detail: detailData({ pull: { isDraft: true } }), code: 'PR_DRAFT', status: 409 },
    { name: 'conflict', detail: detailData({ pull: { mergeable: 'CONFLICTING' } }), code: 'MERGE_CONFLICT', status: 409 },
    { name: 'closed', detail: detailData({ pull: { state: 'MERGED' } }), code: 'PR_NOT_OPEN', status: 409 },
    { name: 'read only', detail: detailData({ repository: { viewerPermission: 'READ' } }), code: 'NO_PERMISSION', status: 403 },
    { name: 'method off', detail: detailData(), request: { method: 'rebase' as never }, code: 'METHOD_NOT_ALLOWED', status: 400 },
    { name: 'optional failing', detail: detailData({ checks: [{ name: 'e2e', conclusion: 'FAILURE' }] }), code: 'CHECKS_FAILING', status: 409 },
  ];
  for (const item of cases) {
    const { gh, service } = setup({ detail: () => ok(item.detail) });
    await rejectsWith(service.merge(3, REF, { ...MERGE, ...item.request }), item.code, item.status);
    assert.equal(gh.of('merge').length, 0, item.name);
    const [record] = service.merges(3);
    assert.equal(record.outcome, 'refused', item.name);
    assert.equal(record.code, item.code, item.name);
  }
  const moved = setup({ detail: () => ok(detailData({ pull: { headRefOid: MOVED } })) });
  await assert.rejects(moved.service.merge(3, REF, MERGE), /现在是 1111111/);
});

test('an acknowledged optional failure merges; GitHub refusals and timeouts are classified and audited', async () => {
  const optional = setup({ detail: () => ok(detailData({ checks: [{ name: 'e2e', conclusion: 'FAILURE' }] })) });
  const queued = await optional.service.merge(3, REF, { ...MERGE, method: 'merge', acknowledgeFailing: true });
  assert.equal(optional.gh.of('merge')[0].args[5], '--merge');
  assert.equal(queued.outcome, 'queued', 'still open after gh succeeded: a merge queue took it');

  const raced = setup({ merge: () => failed('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)') });
  await rejectsWith(raced.service.merge(3, REF, MERGE), 'HEAD_MOVED', 409);
  assert.equal(raced.service.merges(3)[0].outcome, 'failed');

  const protectedBranch = setup({ merge: () => failed('X Pull request Jineggegg/super-professor#114 is not mergeable: the base branch policy prohibits the merge.') });
  await rejectsWith(protectedBranch.service.merge(3, REF, MERGE), 'MERGE_BLOCKED', 409);
  const conflicted = setup({ merge: () => failed('X Pull request Jineggegg/super-professor#114 is not mergeable: the merge commit cannot be cleanly created.') });
  await rejectsWith(conflicted.service.merge(3, REF, MERGE), 'MERGE_CONFLICT', 409);

  const slow = setup({ merge: () => ({ ok: false, reason: 'timeout', stdout: '', stderr: '', exitCode: null }) });
  await rejectsWith(slow.service.merge(3, REF, MERGE), 'MERGE_OUTCOME_UNKNOWN', 504);
  assert.equal(slow.service.merges(3)[0].outcome, 'unknown');

  const offline = setup({ detail: () => failed('dial tcp: lookup api.github.com: no such host') });
  await rejectsWith(offline.service.merge(3, REF, MERGE), 'GH_OFFLINE', 502);
  assert.equal(offline.service.merges(3)[0].outcome, 'failed');
});

test('merge re-reads a pull request the sheet fetched a moment ago, and never merges without an audit row', async () => {
  let head = HEAD;
  const { gh, service, database } = setup({ detail: () => ok(detailData({ pull: { headRefOid: head } })) });
  await service.pull(REF);
  // The head moves right after the sheet loaded; the cached copy must not hide it.
  head = MOVED;
  await rejectsWith(service.merge(3, REF, MERGE), 'HEAD_MOVED', 409);
  assert.equal(gh.of('detail').length, 2);
  assert.equal(gh.of('merge').length, 0);

  database.close();
  await rejectsWith(service.merge(3, REF, { ...MERGE, expectedHeadSha: MOVED }), 'AUDIT_FAILED', 500);
  assert.equal(gh.of('merge').length, 0);
});

test('a second merge of the same pull request while one runs is refused', async () => {
  let release: () => void = () => {};
  const { service } = setup({ merge: () => new Promise(resolve => { release = () => resolve(ok('')); }) });
  const first = service.merge(3, REF, MERGE);
  // Let the first merge reach gh pr merge.
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await rejectsWith(service.merge(3, REF, MERGE), 'MERGE_IN_PROGRESS', 409);
  release();
  assert.equal((await first).outcome, 'queued');
});

test('path and body validation reject anything that could become a gh flag or a bad value', () => {
  assert.deepEqual(parseGitHubPullRef({ owner: 'Jineggegg', repo: '.github', number: '114' }), { owner: 'Jineggegg', repo: '.github', number: 114 });
  for (const params of [
    { owner: '-x', repo: 'r', number: '1' }, { owner: 'a b', repo: 'r', number: '1' }, { owner: 'a'.repeat(40), repo: 'r', number: '1' },
    { owner: 'o', repo: '..', number: '1' }, { owner: 'o', repo: 'r/x', number: '1' }, { owner: 'o', repo: 'r;rm', number: '1' },
    { owner: 'o', repo: 'r', number: '0' }, { owner: 'o', repo: 'r', number: '01' }, { owner: 'o', repo: 'r', number: '-1' },
    { owner: 'o', repo: 'r', number: '2147483648' }, { owner: 'o', repo: 'r', number: '1e3' }, { owner: 'o', repo: 'r', number: 7 },
  ]) assert.throws(() => parseGitHubPullRef(params), AppError, JSON.stringify(params));

  assert.deepEqual(parseGitHubMergeRequest({ method: 'rebase', expectedHeadSha: HEAD, deleteBranch: true }), { method: 'rebase', expectedHeadSha: HEAD, deleteBranch: true, acknowledgeFailing: false });
  for (const body of [
    null, [], 'squash', { method: 'fast-forward', expectedHeadSha: HEAD }, { method: 'squash' }, { method: 'squash', expectedHeadSha: HEAD.toUpperCase() },
    { method: 'squash', expectedHeadSha: HEAD.slice(0, 7) }, { method: 'squash', expectedHeadSha: `--admin${HEAD.slice(7)}` },
    { method: 'squash', expectedHeadSha: HEAD, deleteBranch: 'yes' }, { method: 'squash', expectedHeadSha: HEAD, acknowledgeFailing: 1 },
  ]) assert.throws(() => parseGitHubMergeRequest(body), AppError, JSON.stringify(body));
});

// ------------------------------------------------------------------ gh runner

type ExecCall = { file: string; args: string[]; options: Parameters<StudioGhExecFile>[2]; done: Parameters<StudioGhExecFile>[3] };

function fakeExec() {
  const calls: ExecCall[] = [];
  const execFile: StudioGhExecFile = (file, args, options, done) => { calls.push({ file, args, options, done }); };
  return { calls, execFile };
}

test('the runner calls execFile with the exact argv, no shell, a neutral cwd and a non-interactive environment', async () => {
  const exec = fakeExec();
  const run = createGhRunner({ execFile: exec.execFile, ghPath: '/home/me/.local/bin/gh', cwd: '/tmp', env: { HOME: '/home/me', PATH: '/usr/bin', GH_DEBUG: 'api', DEBUG: '1' } });
  const pending = run(['pr', 'merge', '114', '--repo', 'o/r', '--squash'], { timeoutMs: 1234 });
  const [call] = exec.calls;
  assert.equal(call.file, '/home/me/.local/bin/gh');
  assert.deepEqual(call.args, ['pr', 'merge', '114', '--repo', 'o/r', '--squash']);
  assert.equal(call.options.cwd, '/tmp');
  assert.equal(call.options.timeout, 1234);
  assert.equal(call.options.maxBuffer, 8 * 1024 * 1024);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.encoding, 'utf8');
  assert.equal(call.options.env.HOME, '/home/me');
  assert.equal(call.options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(call.options.env.NO_COLOR, '1');
  assert.equal(call.options.env.GH_DEBUG, undefined);
  assert.equal(call.options.env.DEBUG, undefined);
  assert.ok(!('shell' in call.options));
  call.done(null, 'done', '');
  assert.deepEqual(await pending, { ok: true, stdout: 'done' });
});

test('the runner classifies a missing binary, a timeout and a non-zero exit', async () => {
  const exec = fakeExec();
  const run = createGhRunner({ execFile: exec.execFile });
  const missing = run(['auth', 'status'], { timeoutMs: 10 });
  exec.calls[0].done(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), '', '');
  assert.equal((await missing as { reason: string }).reason, 'missing');
  const slow = run(['api', 'graphql'], { timeoutMs: 10 });
  exec.calls[1].done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' as const }), '', '');
  assert.equal((await slow as { reason: string }).reason, 'timeout');
  const broken = run(['api', 'graphql'], { timeoutMs: 10 });
  exec.calls[2].done(Object.assign(new Error('exit 1'), { code: 1 }), '{"errors":[]}', 'boom');
  assert.deepEqual(await broken, { ok: false, reason: 'failed', stdout: '{"errors":[]}', stderr: 'boom', exitCode: 1 });
  const thrown = createGhRunner({ execFile: () => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); } });
  assert.equal((await thrown(['x'], { timeoutMs: 10 }) as { reason: string }).reason, 'failed');
});

test('the runner keeps at most maxConcurrent gh processes and refuses when the queue is full', async () => {
  const exec = fakeExec();
  const run = createGhRunner({ execFile: exec.execFile, maxConcurrent: 2 });
  const results = Array.from({ length: 4 }, (_, index) => run([`c${index}`], { timeoutMs: 10 }));
  await Promise.resolve();
  assert.deepEqual(exec.calls.map(call => call.args[0]), ['c0', 'c1']);
  exec.calls[0].done(null, '0', '');
  await results[0];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exec.calls.map(call => call.args[0]), ['c0', 'c1', 'c2']);
  // A newcomer while the slot is handed over still waits its turn.
  const late = run(['c4'], { timeoutMs: 10 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exec.calls.length, 3);
  for (const call of exec.calls.slice(1)) call.done(null, '', '');
  await new Promise(resolve => setImmediate(resolve));
  for (const call of exec.calls.slice(3)) call.done(null, '', '');
  await Promise.all([...results, late]);
  assert.deepEqual(exec.calls.map(call => call.args[0]), ['c0', 'c1', 'c2', 'c3', 'c4']);

  const single = fakeExec();
  const narrow = createGhRunner({ execFile: single.execFile, maxConcurrent: 1 });
  const queued = Array.from({ length: 25 }, () => narrow(['wait'], { timeoutMs: 10 }));
  assert.deepEqual(await narrow(['overflow'], { timeoutMs: 10 }), { ok: false, reason: 'busy', stdout: '', stderr: '', exitCode: null });
  // Drain the line so nothing outlives the test.
  for (let index = 0; index < 25; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
    single.calls[index].done(null, '', '');
  }
  await Promise.all(queued);
});

test('gh is found through STUDIO_GH_PATH, the usual install locations, then PATH', () => {
  const logs: string[] = [];
  const options = { home: '/home/me', exists: (file: string) => file === '/usr/bin/gh', log: (message: string) => logs.push(message) };
  assert.equal(resolveGhPath('/opt/gh/bin/gh', options), '/opt/gh/bin/gh');
  assert.equal(resolveGhPath('bin/gh', options), '/usr/bin/gh');
  assert.equal(logs.length, 1);
  assert.equal(resolveGhPath(undefined, { ...options, exists: file => file === '/home/me/.local/bin/gh' }), '/home/me/.local/bin/gh');
  assert.equal(resolveGhPath('  ', { ...options, exists: () => false }), 'gh');
});
