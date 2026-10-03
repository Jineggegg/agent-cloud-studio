import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioGhExecFile, StudioGhResult, StudioGhRun } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createGhRunner, resolveGhPath } from '../github/github-cli.adapter.js';
import { createGitHubBranchService, parseWorkbenchProjectId } from '../github/github-branch.service.js';
import {
  createGitHubService, parseGitHubApproveRunsRequest, parseGitHubMergeRequest, parseGitHubPullRef, parseGitHubUpdateBranchRequest,
} from '../github/github.service.js';
import { createLocalRepoReader } from '../github/git-local.adapter.js';

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

type GhKind = 'status' | 'inbox' | 'detail' | 'merge' | 'ready' | 'branch' | 'runs' | 'deployments' | 'write';

// Which gh command an argv is, as the fake below answers it.
function kindOf(args: string[]): GhKind | null {
  if (args[0] === 'auth') return 'status';
  if (args[0] === 'pr') return args[1] === 'merge' ? 'merge' : args[1] === 'ready' ? 'ready' : args[1] === 'list' ? 'branch' : null;
  if (args[0] !== 'api') return null;
  if (args[1] === '-X') return 'write';
  if (args[1] === 'graphql') return (args[3] ?? '').includes('search(') ? 'inbox' : (args[3] ?? '').includes('pullRequest(number') ? 'detail' : null;
  if (args[1].endsWith('/pending_deployments')) return 'deployments';
  if (args[1].includes('/actions/runs?')) return 'runs';
  return null;
}

const NO_RUNS = ok({ total_count: 0, workflow_runs: [] });

function fakeGh(responders: Partial<Record<GhKind, Responder>>) {
  const calls: Call[] = [];
  const defaults: Record<GhKind, Responder> = {
    status: () => STATUS_OK,
    inbox: () => ok({ data: { authored: { issueCount: 0, nodes: [] }, review: { issueCount: 0, nodes: [] }, owned: { issueCount: 0, nodes: [] } } }),
    detail: () => ok(detailData()),
    merge: () => ok(''),
    ready: () => ok(''),
    branch: () => ok([]),
    runs: () => NO_RUNS,
    deployments: () => ok([]),
    write: () => ok('{}'),
  };
  const run: StudioGhRun = async (args, options) => {
    calls.push({ args, timeoutMs: options.timeoutMs });
    const kind = kindOf(args);
    if (!kind) throw new Error(`unexpected gh call ${args.join(' ')}`);
    return (responders[kind] ?? defaults[kind])(args);
  };
  const of = (kind: GhKind) => calls.filter(call => kindOf(call.args) === kind);
  return { calls, run, of };
}

function setup(responders: Partial<Record<GhKind, Responder>> = {}) {
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
    detail: () => ok(detailData({ repository: { deleteBranchOnMerge: false }, pull: merged ? { state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } } : {} })),
    inbox: () => ok({ data: { authored: { issueCount: 1, nodes: [pullNode()] }, review: { issueCount: 0, nodes: [] }, owned: { issueCount: 0, nodes: [] } } }),
  });
  assert.deepEqual((await service.pulls()).pulls.map(pull => pull.id), ['Jineggegg/super-professor#114']);
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
  // The merged PR leaves the cached inbox at once, without another search.
  assert.deepEqual((await service.pulls()).pulls, []);
  assert.equal(gh.of('inbox').length, 1);
  assert.equal((database.prepare('SELECT COUNT(*) AS total FROM studio_github_merges').get() as { total: number }).total, 1);
});

// ------------------------------------------------------------------ review fixes: merge refusals, merge state, caches

const ADVICE_AUTO = 'To have the pull request merged after all the requirements have been met, add the `--auto` flag.';
const ADVICE_ADMIN = 'To use administrator privileges to immediately merge the pull request, add the `--admin` flag.';
// What gh 2.101 prints to stderr when its own mergeStateStatus check refuses (BLOCKED, BEHIND, DIRTY).
const ghRefusal = (reason: string, ...advice: string[]) =>
  failed([`\u001b[31mX\u001b[0m Pull request Jineggegg/super-professor#114 is not mergeable: ${reason}.`, ...advice].join('\n'));

test('gh merge refusals give the real reason in Chinese and never surface the --admin or --auto advice', async () => {
  const cases: Array<{ name: string; result: StudioGhResult; code: string; message: RegExp }> = [
    { name: 'blocked', result: ghRefusal('the base branch policy prohibits the merge', ADVICE_AUTO, ADVICE_ADMIN), code: 'MERGE_BLOCKED', message: /^分支保护规则不允许合并：可能还缺少必需的审查或检查$/ },
    { name: 'behind', result: ghRefusal('the head branch is not up to date with the base branch', ADVICE_AUTO, ADVICE_ADMIN), code: 'HEAD_BEHIND', message: /分支落后于目标分支/ },
    {
      name: 'dirty',
      result: ghRefusal('the merge commit cannot be cleanly created', ADVICE_AUTO, 'Run the following to resolve the merge conflicts locally:', '  gh pr checkout 114 && git fetch origin main && git merge origin/main'),
      code: 'MERGE_CONFLICT', message: /^有合并冲突/,
    },
    { name: 'required check', result: failed('GraphQL: Required status check "build" is expected. (mergePullRequest)'), code: 'MERGE_BLOCKED', message: /^必需检查「build」还没有结果，分支保护不允许合并$/ },
    { name: 'review', result: failed('GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)'), code: 'MERGE_BLOCKED', message: /^分支保护要求先通过审查/ },
    { name: 'rules', result: failed('GraphQL: Repository rule violations found\n\nCommits must have verified signatures. (mergePullRequest)'), code: 'MERGE_BLOCKED', message: /签名提交/ },
    { name: 'base moved', result: failed('GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)'), code: 'BASE_MOVED', message: /目标分支刚刚有了新提交/ },
    { name: 'generic', result: failed('GraphQL: Pull Request is not mergeable (mergePullRequest)'), code: 'MERGE_BLOCKED', message: /^GitHub 认为这个 PR 现在不能合并/ },
    { name: 'queue', result: failed('Cannot use `-d` or `--delete-branch` when merge queue enabled'), code: 'DELETE_BRANCH_UNSUPPORTED', message: /合并队列/ },
    { name: 'old gh', result: failed('unknown flag: --match-head-commit\n\nUsage:  gh pr merge [<number> | <url> | <branch>] [flags]'), code: 'GH_OUTDATED', message: /gh 版本过旧/ },
  ];
  for (const item of cases) {
    const { service } = setup({ merge: () => item.result });
    await assert.rejects(service.merge(3, REF, MERGE), (error: unknown) => {
      assert.ok(error instanceof AppError, item.name);
      assert.equal(error.code, item.code, item.name);
      assert.match(error.message, item.message, `${item.name}: ${error.message}`);
      assert.doesNotMatch(error.message, /--admin|--auto|administrator|To use|gh pr checkout|\u001b/, item.name);
      return true;
    });
    const [record] = service.merges(3);
    assert.equal(record.code, item.code, item.name);
    assert.doesNotMatch(record.message ?? '', /--admin|--auto/, item.name);
  }
});

test('mergeStateStatus BEHIND, BLOCKED and DIRTY block before gh runs, and UNSTABLE needs an acknowledgement', async () => {
  const blocked: Array<{ name: string; pull: Record<string, unknown>; checks?: Check[]; blockers: string[]; message?: RegExp }> = [
    { name: 'behind', pull: { mergeStateStatus: 'BEHIND' }, blockers: ['HEAD_BEHIND'], message: /^feat\/lotus 落后于 main，仓库要求先更新分支/ },
    { name: 'blocked by review', pull: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, blockers: ['MERGE_BLOCKED'], message: /^分支保护要求先通过审查才能合并$/ },
    { name: 'blocked by changes', pull: { mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }, blockers: ['MERGE_BLOCKED'], message: /审查者要求修改/ },
    { name: 'blocked otherwise', pull: { mergeStateStatus: 'BLOCKED' }, blockers: ['MERGE_BLOCKED'], message: /^分支保护规则不允许合并/ },
    // A required check already explains BLOCKED, so it is not listed twice.
    { name: 'blocked by a check', pull: { mergeStateStatus: 'BLOCKED' }, checks: [{ name: 'unit', status: 'QUEUED', conclusion: null, required: true }], blockers: ['REQUIRED_CHECKS_PENDING'] },
    { name: 'dirty', pull: { mergeStateStatus: 'DIRTY' }, blockers: ['MERGE_CONFLICT'] },
  ];
  for (const item of blocked) {
    const { gh, service } = setup({ detail: () => ok(detailData({ pull: item.pull, checks: item.checks })) });
    const detail = await service.pull(REF);
    assert.deepEqual(detail.blockers.map(blocker => blocker.code), item.blockers, item.name);
    if (item.message) assert.match(detail.blockers[0].message, item.message, item.name);
    await rejectsWith(service.merge(3, REF, { ...MERGE, acknowledgeFailing: true }), item.blockers[0], 409);
    assert.equal(gh.of('merge').length, 0, item.name);
    assert.equal(service.merges(3)[0].outcome, 'refused', item.name);
  }

  const unstable = setup({ detail: () => ok(detailData({ pull: { mergeStateStatus: 'UNSTABLE' } })) });
  assert.deepEqual((await unstable.service.pull(REF)).blockers, []);
  await rejectsWith(unstable.service.merge(3, REF, MERGE), 'CHECKS_FAILING', 409);
  assert.equal(unstable.gh.of('merge').length, 0);
  assert.match(unstable.service.merges(3)[0].message ?? '', /GitHub 报告有检查没有通过/);
  await unstable.service.merge(3, REF, { ...MERGE, acknowledgeFailing: true });
  assert.equal(unstable.gh.of('merge').length, 1);
});

test('with a merge queue, BLOCKED and BEHIND do not block, --delete-branch is never sent and the PR is queued', async () => {
  const { gh, service } = setup({
    detail: () => ok(detailData({ repository: { deleteBranchOnMerge: false }, pull: { mergeStateStatus: 'BLOCKED', isMergeQueueEnabled: true } })),
  });
  assert.deepEqual((await service.pull(REF)).blockers, []);
  assert.equal((await service.pull(REF)).mergeQueue, true);
  const result = await service.merge(3, REF, { ...MERGE, deleteBranch: true });
  assert.equal(result.outcome, 'queued');
  assert.ok(!gh.of('merge')[0].args.includes('--delete-branch'));
  assert.equal(service.merges(3)[0].deleteBranch, false);
});

test('--delete-branch is only sent when it changes something: not with auto-delete or for a fork', async () => {
  for (const item of [
    { name: 'auto-delete', detail: detailData() },
    { name: 'fork', detail: detailData({ repository: { deleteBranchOnMerge: false }, pull: { isCrossRepository: true } }) },
  ]) {
    const { gh, service } = setup({ detail: () => ok(item.detail) });
    await service.merge(3, REF, { ...MERGE, deleteBranch: true });
    assert.ok(!gh.of('merge')[0].args.includes('--delete-branch'), item.name);
  }
});

test('a merged PR leaves the inbox at once, even when an older search lands later or the search index lags', async () => {
  let merged = false;
  let hold = false;
  let release: () => void = () => {};
  const listed = () => ok({ data: {
    authored: { issueCount: 2, nodes: [pullNode(), pullNode({ number: 9, updatedAt: '2026-10-01T08:00:00Z' })] },
    review: { issueCount: 0, nodes: [] }, owned: { issueCount: 0, nodes: [] },
  } });
  const { gh, service, advance } = setup({
    // GitHub's search keeps listing #114 as open for a while after the merge.
    inbox: () => hold ? new Promise(resolve => { release = () => resolve(listed()); }) : listed(),
    merge: () => { merged = true; return ok(''); },
    detail: () => ok(detailData({ pull: merged ? { state: 'MERGED' } : {} })),
  });
  const ids = (inbox: { pulls: Array<{ id: string }> }) => inbox.pulls.map(pull => pull.id);
  assert.deepEqual(ids(await service.pulls()), ['Jineggegg/super-professor#9', 'Jineggegg/super-professor#114']);
  advance(6_000);
  // A widget poll or another device starts a search that is still running when the merge finishes.
  hold = true;
  const older = service.pulls(true);
  await new Promise(resolve => setImmediate(resolve));
  hold = false;
  assert.equal((await service.merge(3, REF, MERGE)).outcome, 'merged');
  release();
  assert.deepEqual(ids(await older), ['Jineggegg/super-professor#9'], 'the older search answers without the merged PR');
  // The sheet's refresh right after the merge searches again; the index still lists #114.
  advance(1_000);
  assert.deepEqual(ids(await service.pulls(true)), ['Jineggegg/super-professor#9']);
  assert.equal(gh.of('inbox').length, 3);
  // The widget's next poll reads the cache, which the older search never overwrote.
  advance(31_000);
  assert.deepEqual(ids(await service.pulls()), ['Jineggegg/super-professor#9']);
  assert.equal(gh.of('inbox').length, 3);
  advance(60_000);
  assert.deepEqual(ids(await service.pulls()), ['Jineggegg/super-professor#9']);
  assert.equal(gh.of('inbox').length, 4);

  // A merge GitHub refused drops the cache instead, so the next read searches again.
  const refused = setup({ merge: () => failed('GraphQL: Pull Request is not mergeable (mergePullRequest)') });
  await refused.service.pulls();
  await assert.rejects(refused.service.merge(3, REF, MERGE));
  await refused.service.pulls();
  assert.equal(refused.gh.of('inbox').length, 2);
});

test('the merge-time read rejects partial GraphQL data, while the detail sheet keeps it', async () => {
  const partial = detailData({ checks: [{ name: 'unit', conclusion: 'FAILURE', required: true }] });
  const rollup = partial.data.repository.pullRequest.commits.nodes[0].commit;
  (rollup as { statusCheckRollup: unknown }).statusCheckRollup = null;
  const withErrors = failed('gh: Something went wrong while executing your query.', JSON.stringify({ ...partial, errors: [{ message: 'Something went wrong while executing your query.' }] }));
  const { gh, service } = setup({ detail: () => withErrors });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual((await service.pull(REF)).checkItems, [], 'the sheet shows what GitHub returned');
  } finally {
    console.warn = warn;
  }
  await rejectsWith(service.merge(3, REF, { ...MERGE, acknowledgeFailing: true }), 'GH_PARTIAL_RESPONSE', 502);
  assert.equal(gh.of('merge').length, 0);

  const nullCheck = detailData({ checks: [{ name: 'unit' }] });
  (nullCheck.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes as unknown[]).push(null);
  const holes = setup({ detail: () => ok(nullCheck) });
  await rejectsWith(holes.service.merge(3, REF, MERGE), 'GH_PARTIAL_RESPONSE', 502);
  assert.equal(holes.gh.of('merge').length, 0);
});

test('every attempt is audited: a second tap, a request the router rejected, and a timed-out merge settled later', async () => {
  const { service } = setup();
  service.recordInvalidMerge(3, REF, new AppError('缺少有效的头提交 SHA', { statusCode: 400, code: 'INVALID_SHA' }));
  assert.deepEqual({ ...service.merges(3)[0], createdAt: '', finishedAt: '' }, {
    id: 1, owner: 'Jineggegg', repo: 'super-professor', number: 114, method: null, headSha: '', deleteBranch: false,
    outcome: 'invalid', code: 'INVALID_SHA', message: '缺少有效的头提交 SHA', createdAt: '', finishedAt: '',
  });

  let merged = false;
  const slow = setup({
    merge: () => ({ ok: false, reason: 'timeout', stdout: '', stderr: '', exitCode: null }),
    detail: () => ok(detailData({ pull: merged ? { state: 'MERGED' } : {} })),
  });
  await rejectsWith(slow.service.merge(3, { ...REF, owner: 'jineggegg' }, MERGE), 'MERGE_OUTCOME_UNKNOWN', 504);
  assert.equal(slow.service.merges(3)[0].outcome, 'unknown');
  // GitHub did merge it; the next read of the PR (the sheet's 重新载入) settles the row.
  merged = true;
  await slow.service.pull(REF, true);
  assert.equal(slow.service.merges(3)[0].outcome, 'merged');
  assert.match(slow.service.merges(3)[0].message ?? '', /已合并/);
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
  // The refused second tap is in the audit log too.
  assert.deepEqual(service.merges(3).map(record => [record.outcome, record.code]), [['refused', 'MERGE_IN_PROGRESS'], ['queued', null]]);
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

// ------------------------------------------------------------------ one-tap fixes: update branch, mark ready, approve runs

type ActionRow = { user_id: number; action: string; subject: string; outcome: string; code: string | null; message: string | null; finished_at: string | null };
const actionRows = (database: Database.Database) => database.prepare('SELECT * FROM studio_github_actions ORDER BY id').all() as ActionRow[];

const RUNS_PATH = `repos/Jineggegg/super-professor/actions/runs?head_sha=${HEAD}&per_page=50`;
const workflowRun = (id: number, status: string, overrides: Record<string, unknown> = {}) => ({ id, name: `Run ${id}`, status, head_sha: HEAD, ...overrides });
const RUNS_WAITING = ok({ total_count: 4, workflow_runs: [
  workflowRun(501, 'action_required', { name: 'CI\u0007' }),
  workflowRun(502, 'waiting', { name: 'Deploy' }),
  workflowRun(503, 'completed'),
  workflowRun(504, 'action_required', { head_sha: MOVED }),
  workflowRun(-5, 'action_required'),
] });
const DEPLOYMENTS = ok([
  { environment: { id: 77, name: 'production' }, current_user_can_approve: true },
  { environment: { id: 78, name: 'staging' }, current_user_can_approve: false },
]);

test('the detail lists runs waiting for approval, from exact Actions reads, and never fails because of them', async () => {
  const { gh, service } = setup({ runs: () => RUNS_WAITING, deployments: () => DEPLOYMENTS });
  const detail = await service.pull(REF);
  assert.deepEqual(gh.of('runs')[0].args, ['api', RUNS_PATH]);
  assert.deepEqual(gh.of('deployments')[0].args, ['api', 'repos/Jineggegg/super-professor/actions/runs/502/pending_deployments']);
  assert.deepEqual(detail.pendingRuns, [
    { id: 501, name: 'CI', kind: 'contributor', environments: [] },
    { id: 502, name: 'Deploy', kind: 'deployment', environments: ['production'] },
  ]);
  assert.ok(!JSON.stringify(detail).includes('environmentIds'));

  // Read-only access cannot approve a contributor's run; a deployment nobody here may approve is left out.
  const readOnly = setup({ runs: () => RUNS_WAITING, deployments: () => ok([{ environment: { id: 78, name: 'staging' }, current_user_can_approve: false }]), detail: () => ok(detailData({ repository: { viewerPermission: 'READ' } })) });
  assert.deepEqual((await readOnly.service.pull(REF)).pendingRuns, []);

  const broken = setup({ runs: () => failed('HTTP 500: boom') });
  const fallback = await broken.service.pull(REF);
  assert.deepEqual(fallback.pendingRuns, []);
  assert.equal(fallback.number, 114);

  const lookupFails = setup({ runs: () => RUNS_WAITING, deployments: () => failed('HTTP 502') });
  assert.deepEqual((await lookupFails.service.pull(REF)).pendingRuns.map(run => run.id), [501]);

  const closed = setup({ runs: () => RUNS_WAITING, detail: () => ok(detailData({ pull: { state: 'MERGED' } })) });
  assert.deepEqual((await closed.service.pull(REF)).pendingRuns, []);
  assert.equal(closed.gh.of('runs').length, 0);
});

test('update branch calls GitHub with the SHA the user saw, then drops the caches and re-reads, all audited', async () => {
  let updated = false;
  const { gh, service, database } = setup({
    detail: () => ok(detailData({ pull: updated ? {} : { mergeStateStatus: 'BEHIND' } })),
    write: () => { updated = true; return ok({ message: 'Updating pull request branch.', url: 'https://github.com/x' }); },
  });
  await service.pull(REF);
  const result = await service.updateBranch(7, REF, { expectedHeadSha: HEAD });
  assert.deepEqual(gh.of('write')[0].args, ['api', '-X', 'PUT', 'repos/Jineggegg/super-professor/pulls/114/update-branch', '-f', `expected_head_sha=${HEAD}`]);
  assert.equal(gh.of('write')[0].timeoutMs, 30_000);
  assert.equal(result.message, '已把 main 的最新提交合并进 feat/lotus，检查会重新运行');
  assert.equal(result.pull?.mergeState, 'clean');
  // The sheet's read, the strict read the decision is made on, and the read after the update.
  assert.equal(gh.of('detail').length, 3);
  assert.deepEqual(actionRows(database).map(row => [row.user_id, row.action, row.subject, row.outcome]), [[7, 'update-branch', HEAD, 'done']]);
  assert.ok(actionRows(database)[0].finished_at);
  for (const args of gh.calls.map(call => call.args)) assert.ok(!args.some(arg => /--admin|--auto/.test(arg)), args.join(' '));
});

test('update branch refuses a moved head or a branch that is not behind without calling GitHub', async () => {
  const cases = [
    { name: 'moved', pull: { mergeStateStatus: 'BEHIND', headRefOid: MOVED }, code: 'HEAD_MOVED', message: /现在是 1111111/ },
    { name: 'not behind', pull: {}, code: 'NOT_BEHIND', message: /不需要更新分支/ },
    { name: 'closed', pull: { mergeStateStatus: 'BEHIND', state: 'CLOSED' }, code: 'PR_NOT_OPEN', message: /已关闭/ },
  ];
  for (const item of cases) {
    const { gh, service, database } = setup({ detail: () => ok(detailData({ pull: item.pull })) });
    await assert.rejects(service.updateBranch(3, REF, { expectedHeadSha: HEAD }), (error: unknown) => {
      assert.ok(error instanceof AppError, item.name);
      assert.equal(error.code, item.code, item.name);
      assert.match(error.message, item.message, item.name);
      return true;
    });
    assert.equal(gh.of('write').length, 0, item.name);
    assert.deepEqual(actionRows(database).map(row => [row.outcome, row.code]), [['refused', item.code]], item.name);
  }
});

test('GitHub refusing a fix is classified in Chinese, never leaks tokens, and a timeout is recorded as unknown', async () => {
  const behind = () => ok(detailData({ pull: { mergeStateStatus: 'BEHIND' } }));
  const cases: Array<{ name: string; result: StudioGhResult; code: string; status: number }> = [
    { name: 'moved', result: failed('gh: expected head sha didn\'t match current head ref. (HTTP 422)', JSON.stringify({ message: "expected head sha didn't match current head ref." })), code: 'HEAD_MOVED', status: 409 },
    { name: 'conflict', result: failed('gh: merge conflict between base and head (HTTP 422)'), code: 'MERGE_CONFLICT', status: 409 },
    { name: 'permission', result: failed('gh: Resource not accessible by integration (HTTP 403)'), code: 'NO_PERMISSION', status: 403 },
    { name: 'signed out', result: failed('HTTP 401: Bad credentials (https://api.github.com/)'), code: 'GH_NOT_AUTHENTICATED', status: 409 },
    { name: 'generic', result: failed(`gh: something odd ${TOKEN} (HTTP 500)`), code: 'GH_FAILED', status: 502 },
    { name: 'timeout', result: { ok: false, reason: 'timeout', stdout: '', stderr: '', exitCode: null }, code: 'ACTION_OUTCOME_UNKNOWN', status: 504 },
  ];
  for (const item of cases) {
    const { service, database } = setup({ detail: behind, write: () => item.result });
    await assert.rejects(service.updateBranch(3, REF, { expectedHeadSha: HEAD }), (error: unknown) => {
      assert.ok(error instanceof AppError, item.name);
      assert.equal(error.code, item.code, item.name);
      assert.equal(error.statusCode, item.status, item.name);
      assert.ok(!error.message.includes(TOKEN), item.name);
      return true;
    });
    const [row] = actionRows(database);
    assert.equal(row.outcome, item.code === 'ACTION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed', item.name);
    assert.equal(row.code, item.code, item.name);
  }
});

test('mark ready runs gh pr ready with exact args and refuses a pull request that is not a draft', async () => {
  let ready = false;
  const { gh, service, database } = setup({
    detail: () => ok(detailData({ pull: { isDraft: !ready } })),
    ready: () => { ready = true; return ok(''); },
  });
  const result = await service.markReady(7, REF);
  assert.deepEqual(gh.of('ready')[0].args, ['pr', 'ready', '114', '--repo', 'Jineggegg/super-professor']);
  assert.equal(result.message, '#114 已标记为可审查');
  assert.equal(result.pull?.isDraft, false);
  await assert.rejects(service.markReady(7, REF), /已经是可审查状态/);
  assert.equal(gh.of('ready').length, 1);
  assert.deepEqual(actionRows(database).map(row => [row.action, row.outcome, row.code]), [['ready', 'done', null], ['ready', 'refused', 'NOT_DRAFT']]);
});

test('approve runs accepts only runs a fresh read lists as pending, with exact API calls for each kind', async () => {
  const { gh, service, database } = setup({ runs: () => RUNS_WAITING, deployments: () => DEPLOYMENTS });
  const result = await service.approveRuns(7, REF, { runIds: [502, 501] });
  assert.deepEqual(gh.of('write').map(call => call.args), [
    ['api', '-X', 'POST', 'repos/Jineggegg/super-professor/actions/runs/502/pending_deployments', '-F', 'environment_ids[]=77', '-f', 'state=approved', '-f', 'comment=Approved from Studio'],
    ['api', '-X', 'POST', 'repos/Jineggegg/super-professor/actions/runs/501/approve'],
  ]);
  assert.equal(result.message, '已批准 2 个运行');
  assert.deepEqual(actionRows(database).map(row => [row.action, row.subject, row.outcome]), [['approve-runs', '502,501', 'done']]);

  // A completed run, another commit's run or an unknown id is refused before anything is approved.
  for (const runIds of [[503], [504], [501, 999]]) {
    const other = setup({ runs: () => RUNS_WAITING, deployments: () => DEPLOYMENTS });
    await assert.rejects(other.service.approveRuns(7, REF, { runIds }), (error: unknown) => error instanceof AppError && error.code === 'RUN_NOT_PENDING');
    assert.equal(other.gh.of('write').length, 0, JSON.stringify(runIds));
  }

  // A failure after one approval says which went through.
  let writes = 0;
  const partial = setup({ runs: () => RUNS_WAITING, deployments: () => DEPLOYMENTS, write: () => (writes++ ? failed('gh: Resource not accessible by integration (HTTP 403)') : ok('{}')) });
  await assert.rejects(partial.service.approveRuns(7, REF, { runIds: [501, 502] }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'NO_PERMISSION');
    assert.equal(error.message, '已批准「CI」，「Deploy」没有批准：当前 gh 账号没有权限执行这个操作');
    return true;
  });
  assert.equal(actionRows(partial.database)[0].outcome, 'failed');
});

test('fixes and merges on one pull request never overlap, and nothing runs without an audit row', async () => {
  let release: () => void = () => {};
  const { gh, service, database } = setup({
    detail: () => ok(detailData({ pull: { mergeStateStatus: 'BEHIND' } })),
    write: () => new Promise(resolve => { release = () => resolve(ok('{}')); }),
  });
  const first = service.updateBranch(3, REF, { expectedHeadSha: HEAD });
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await rejectsWith(service.markReady(3, REF), 'ACTION_IN_PROGRESS', 409);
  await rejectsWith(service.merge(3, REF, MERGE), 'ACTION_IN_PROGRESS', 409);
  release();
  await first;
  assert.equal(gh.of('merge').length, 0);
  assert.deepEqual(actionRows(database).map(row => [row.action, row.outcome]), [['update-branch', 'done'], ['ready', 'refused']]);

  service.recordInvalidAction(3, REF, 'approve-runs', new AppError('runIds 无效', { statusCode: 400, code: 'INVALID_RUN_IDS' }));
  const last = actionRows(database).at(-1);
  assert.deepEqual([last?.action, last?.outcome, last?.code], ['approve-runs', 'invalid', 'INVALID_RUN_IDS']);

  database.close();
  await rejectsWith(service.markReady(3, REF), 'AUDIT_FAILED', 500);
  assert.equal(gh.of('ready').length, 0);
});

test('fix bodies are validated before anything reaches gh', () => {
  assert.deepEqual(parseGitHubUpdateBranchRequest({ expectedHeadSha: HEAD }), { expectedHeadSha: HEAD });
  for (const body of [null, {}, { expectedHeadSha: HEAD.toUpperCase() }, { expectedHeadSha: `-${HEAD.slice(1)}` }]) {
    assert.throws(() => parseGitHubUpdateBranchRequest(body), AppError, JSON.stringify(body));
  }
  assert.deepEqual(parseGitHubApproveRunsRequest({ runIds: [5, 5, 9] }), { runIds: [5, 9] });
  for (const body of [null, { runIds: [] }, { runIds: '5' }, { runIds: [0] }, { runIds: [-1] }, { runIds: [1.5] }, { runIds: ['5'] },
    { runIds: [Number.MAX_SAFE_INTEGER + 1] }, { runIds: Array.from({ length: 21 }, (_, index) => index + 1) }]) {
    assert.throws(() => parseGitHubApproveRunsRequest(body), AppError, JSON.stringify(body));
  }
});

// ------------------------------------------------------------------ the open PR of a workbench project's branch

function branchSetup({ local = { branch: 'feat/lotus', remoteUrl: 'git@github.com:Jineggegg/super-professor.git' } as { branch: string | null; remoteUrl: string | null },
  responders = {} as Partial<Record<GhKind, Responder>>, directory = '/home/me/projects/super-professor' as string | null } = {}) {
  const base = setup({ branch: () => ok([{ number: 9, isCrossRepository: true }, { number: 114, isCrossRepository: false }]), ...responders });
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const reads: string[] = [];
  const branches = createGitHubBranchService({
    github: base.service,
    projectDirectory: id => (id === 'p-1' ? directory : null),
    readLocalRepo: async dir => { reads.push(dir); return local; },
    now: () => clock,
  });
  return { ...base, branches, reads, tick: (ms: number) => { clock += ms; base.advance(ms); } };
}

test('the branch PR comes from the project directory, its github.com origin and gh pr list, skipping forks', async () => {
  const { gh, branches, reads } = branchSetup();
  const found = await branches.branchPull('p-1');
  assert.deepEqual(reads, ['/home/me/projects/super-professor']);
  assert.deepEqual(gh.of('branch')[0].args, ['pr', 'list', '--repo', 'Jineggegg/super-professor', '--head=feat/lotus', '--state', 'open', '--json', 'number,isCrossRepository', '--limit', '5']);
  assert.equal(found?.branch, 'feat/lotus');
  assert.equal(found?.canMerge, true);
  assert.equal(found?.pull.number, 114);
  assert.deepEqual(found?.pull.blockers, []);
  assert.ok(found && !('files' in found.pull) && !('body' in found.pull));
  await rejectsWith(branches.branchPull('nope'), 'PROJECT_NOT_FOUND', 404);
});

test('the branch PR is cached for 30 s per project, and a forced refresh only looks again after 5 s', async () => {
  const { gh, branches, tick } = branchSetup();
  await Promise.all([branches.branchPull('p-1'), branches.branchPull('p-1')]);
  assert.equal(gh.of('branch').length, 1);
  tick(2_000);
  await branches.branchPull('p-1', true);
  assert.equal(gh.of('branch').length, 1);
  tick(4_000);
  await branches.branchPull('p-1', true);
  assert.equal(gh.of('branch').length, 2);
  tick(31_000);
  await branches.branchPull('p-1');
  assert.equal(gh.of('branch').length, 3);
});

test('no chip: other hosts, odd remotes, detached HEAD, unsafe branch names, signed-out gh, no PR or a closed one', async () => {
  for (const remoteUrl of ['https://gitlab.com/Jineggegg/super-professor.git', 'git@github.com:-x/evil.git', 'https://github.com.evil.io/a/b', 'https://github.com/a/b/c', '/srv/git/repo.git']) {
    const { gh, branches } = branchSetup({ local: { branch: 'main', remoteUrl } });
    assert.equal(await branches.branchPull('p-1'), null, remoteUrl);
    assert.equal(gh.of('branch').length, 0, remoteUrl);
  }
  for (const remoteUrl of ['https://github.com/Jineggegg/super-professor', 'https://x-access:secret@github.com/Jineggegg/super-professor.git', 'ssh://git@github.com/Jineggegg/super-professor.git']) {
    const { branches } = branchSetup({ local: { branch: 'feat/lotus', remoteUrl } });
    assert.equal((await branches.branchPull('p-1'))?.pull.number, 114, remoteUrl);
  }
  for (const branch of [null, '-x', 'a..b', 'feat/x.lock', 'bad name']) {
    const { gh, branches } = branchSetup({ local: { branch, remoteUrl: 'git@github.com:Jineggegg/super-professor.git' } });
    assert.equal(await branches.branchPull('p-1'), null, String(branch));
    assert.equal(gh.of('branch').length, 0, String(branch));
  }
  const signedOut = branchSetup({ responders: { status: () => ok({ hosts: {} }) } });
  assert.equal(await signedOut.branches.branchPull('p-1'), null);
  assert.equal(signedOut.gh.of('branch').length, 0);
  const none = branchSetup({ responders: { branch: () => ok([]) } });
  assert.equal(await none.branches.branchPull('p-1'), null);
  const closed = branchSetup({ responders: { detail: () => ok(detailData({ pull: { state: 'CLOSED' } })) } });
  assert.equal(await closed.branches.branchPull('p-1'), null);
  assert.throws(() => parseWorkbenchProjectId('../x'), AppError);
  assert.throws(() => parseWorkbenchProjectId(undefined), AppError);
  assert.equal(parseWorkbenchProjectId('0f9b6c1e-1b0f-4b8e-9f0a-1c2d3e4f5a6b'), '0f9b6c1e-1b0f-4b8e-9f0a-1c2d3e4f5a6b');
});

test('the local repo reader runs git with an exact argv and no shell, and never rejects', async () => {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const read = createLocalRepoReader({
    env: { HOME: '/home/me' },
    execFile: (file, args, options, done) => {
      calls.push({ file, args, options });
      if (args[0] === 'symbolic-ref') done(null, 'feat/lotus\n', '');
      else done(Object.assign(new Error('no origin'), { code: 2 }), '', 'error: No such remote');
    },
  });
  assert.deepEqual(await read('/srv/project'), { branch: 'feat/lotus', remoteUrl: null });
  assert.deepEqual(calls.map(call => [call.file, ...call.args]), [['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], ['git', 'remote', 'get-url', 'origin']]);
  assert.equal(calls[0].options.cwd, '/srv/project');
  assert.equal((calls[0].options.env as Record<string, string>).GIT_TERMINAL_PROMPT, '0');
  assert.ok(!('shell' in calls[0].options));
  const throwing = createLocalRepoReader({ execFile: () => { throw new Error('spawn EAGAIN'); } });
  assert.deepEqual(await throwing('/srv/project'), { branch: null, remoteUrl: null });
});
