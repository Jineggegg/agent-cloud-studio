import type Database from 'better-sqlite3';

import type { StudioGhResult, StudioGhRun } from '@/shared/types.js';
import { AppError, stripAnsiSequences } from '@/shared/utils.js';

type MergeMethod = 'merge' | 'squash' | 'rebase';
type CheckState = 'passing' | 'failing' | 'pending' | 'skipped';
// Why a pull request is in the inbox: opened by the account, waiting on its review, or in a repository it owns.
type InboxReason = 'authored' | 'review' | 'owned';
type GhFailure = Extract<StudioGhResult, { ok: false }>;

/** A pull request address after the router validated it; only these values ever reach gh's argv. */
type PullRef = { owner: string; repo: string; number: number };
/** A validated merge request body. */
type MergeRequest = { method: MergeMethod; expectedHeadSha: string; deleteBranch: boolean; acknowledgeFailing: boolean };

type GitHubStatus = {
  installed: boolean; authenticated: boolean; login: string | null; scopes: string[];
  // Whether the token can merge at all: OAuth tokens need the `repo` scope (fine-grained tokens list no scopes).
  canMerge: boolean;
  message: string | null; checkedAt: string;
};
type ChecksSummary = { state: 'passing' | 'failing' | 'pending' | 'none'; passing: number; failing: number; pending: number; total: number };
type PullSummary = {
  id: string; owner: string; repo: string; number: number; title: string; author: string; url: string; isDraft: boolean;
  headRef: string; baseRef: string; headSha: string; additions: number; deletions: number; changedFiles: number;
  mergeable: 'mergeable' | 'conflicting' | 'unknown'; mergeState: string;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: ChecksSummary; updatedAt: string; reasons: InboxReason[];
};
type CheckItem = { name: string; workflow: string | null; state: CheckState; required: boolean; url: string | null };
type FileItem = { path: string; additions: number; deletions: number; change: string };
type Blocker = { code: string; message: string };
type PullDetail = PullSummary & {
  state: 'open' | 'closed' | 'merged'; body: string; bodyTruncated: boolean; createdAt: string;
  checkItems: CheckItem[]; checksTruncated: boolean; files: FileItem[]; filesTotal: number;
  mergeMethods: MergeMethod[]; deleteBranchOnMerge: boolean; isCrossRepository: boolean; viewerCanMerge: boolean;
  blockers: Blocker[]; mergeCommitSha: string | null;
};
type MergeOutcome = 'pending' | 'merged' | 'queued' | 'refused' | 'failed' | 'unknown';
type MergeRow = {
  id: number; owner: string; repo: string; number: number; method: MergeMethod; head_sha: string; delete_branch: number;
  outcome: MergeOutcome; code: string | null; message: string | null; created_at: string; finished_at: string | null;
};
type Refusal = Blocker & { status: number };
type CacheEntry<T> = { at: number; value: T };
type Inbox = { login: string; pulls: PullSummary[]; fetchedAt: string; truncated: boolean };

const HOST = 'github.com';
const STATUS_TTL_MS = 60_000;
const CACHE_TTL_MS = 45_000;
// A forced refresh within this long of the last fetch reuses it, so repeated taps cannot hammer the API.
const FORCE_MIN_INTERVAL_MS = 5_000;
const READ_TIMEOUT_MS = 20_000;
// gh pr merge waits for GitHub to finish the merge, which can take a while on large repositories.
const MERGE_TIMEOUT_MS = 60_000;
const MAX_DETAIL_CACHE = 64;
const BODY_EXCERPT_LENGTH = 1600;
const MAX_ERROR_LENGTH = 160;

// GitHub logins and organisation names never start with "-", so no owner can be read as a gh flag.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,9}$/;
// GraphQL Int is 32-bit.
const MAX_NUMBER = 2_147_483_647;
const SHA = /^[0-9a-f]{40}$/;
const SCOPE = /^[a-z][a-z0-9:_-]{0,40}$/;
const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];
const METHOD_LABEL: Record<MergeMethod, string> = { merge: '合并提交', squash: '压缩合并', rebase: '变基合并' };
// The repository settings that turn each method on.
const METHOD_SETTING: Record<MergeMethod, string> = { merge: 'mergeCommitAllowed', squash: 'squashMergeAllowed', rebase: 'rebaseMergeAllowed' };
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

// CheckRun conclusions and StatusContext states, as GitHub's GraphQL enums spell them.
const FAILING_STATES = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR']);
const PENDING_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']);
const SKIPPED_STATES = new Set(['NEUTRAL', 'SKIPPED']);

// One search per inbox reason; issueCount above the 50 returned marks the inbox as truncated.
const INBOX_QUERY = `query($authored: String!, $review: String!, $owned: String!) {
  authored: search(type: ISSUE, query: $authored, first: 50) { issueCount nodes { ...pull } }
  review: search(type: ISSUE, query: $review, first: 50) { issueCount nodes { ...pull } }
  owned: search(type: ISSUE, query: $owned, first: 50) { issueCount nodes { ...pull } }
}
fragment pull on PullRequest {
  number title url isDraft updatedAt headRefName baseRefName headRefOid additions deletions changedFiles
  mergeable mergeStateStatus reviewDecision
  author { login }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) {
    checkRunCountsByState { state count } statusContextCountsByState { state count }
  } } } } }
}`;

// isRequired needs the pull request number because branch protection is evaluated against its base branch.
const DETAIL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequest(number: $number) {
      number title url state isDraft body createdAt updatedAt headRefName baseRefName headRefOid
      additions deletions changedFiles mergeable mergeStateStatus reviewDecision isCrossRepository
      author { login }
      mergeCommit { oid }
      files(first: 100) { totalCount nodes { path additions deletions changeType } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
const shortSha = (sha: string) => sha.slice(0, 7);

// One line of untrusted text from GitHub: control characters become spaces and it is capped.
function line(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The description as plain text with its line breaks; the browser renders it as text, never as HTML or Markdown.
function excerpt(value: unknown) {
  if (typeof value !== 'string') return { body: '', truncated: false };
  const normalized = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (normalized.length <= BODY_EXCERPT_LENGTH) return { body: normalized, truncated: false };
  const cut = normalized.slice(0, BODY_EXCERPT_LENGTH);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'), cut.lastIndexOf('. '));
  return { body: `${(boundary > BODY_EXCERPT_LENGTH * 0.6 ? cut.slice(0, boundary + 1) : cut).trimEnd()}…`, truncated: true };
}

function httpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}

function isoDate(value: unknown) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : '';
}

// What gh printed, made safe to show: no ANSI styling, no token-shaped strings, one short line.
function redact(value: string) {
  const lines = stripAnsiSequences(value).replace(TOKEN_PATTERN, '[已隐藏]').split(/\r?\n/)
    .map(item => item.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  return last.length > MAX_ERROR_LENGTH ? `${last.slice(0, MAX_ERROR_LENGTH - 1)}…` : last;
}

// `gh api graphql` prints GitHub's JSON error body on stdout when a query fails.
function graphqlMessages(stdout: string) {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return '';
    return parsed.errors.map(error => isRecord(error) && typeof error.message === 'string' ? error.message : '').filter(Boolean).join('\n');
  } catch { return ''; }
}

function fail(message: string, statusCode: number, code: string): never {
  throw new AppError(message, { statusCode, code });
}

// A gh failure as a short Chinese message with a machine-readable code; raw output never reaches the client.
function describeFailure(result: GhFailure) {
  if (result.reason === 'missing') return new AppError('服务器上没有找到 gh（GitHub CLI）', { statusCode: 503, code: 'GH_MISSING' });
  if (result.reason === 'timeout') return new AppError('GitHub 响应超时，请稍后再试', { statusCode: 504, code: 'GH_TIMEOUT' });
  if (result.reason === 'busy') return new AppError('GitHub 请求太多，请稍后再试', { statusCode: 503, code: 'GH_BUSY' });
  const details = `${result.stderr}\n${graphqlMessages(result.stdout)}`;
  const output = details.toLowerCase();
  if (/gh auth login|not logged in|authentication|bad credentials|http 401/.test(output)) {
    return new AppError('gh 未登录或登录已失效：请在服务器上运行 gh auth login', { statusCode: 409, code: 'GH_NOT_AUTHENTICATED' });
  }
  if (output.includes('rate limit')) return new AppError('GitHub API 调用次数已达上限，请稍后再试', { statusCode: 429, code: 'GH_RATE_LIMITED' });
  if (output.includes('saml')) return new AppError('这个组织要求 SAML 单点登录：请在 GitHub 上为 gh 的令牌授权', { statusCode: 403, code: 'GH_SAML' });
  if (/could not resolve to a (repository|pullrequest)|http 404/.test(output)) {
    return new AppError('找不到这个仓库或 PR，或者当前账号没有访问权限', { statusCode: 404, code: 'GITHUB_NOT_FOUND' });
  }
  if (/dial tcp|no such host|could not connect|connection refused|network is unreachable|tls handshake|i\/o timeout/.test(output)) {
    return new AppError('服务器连不上 GitHub，请检查网络', { statusCode: 502, code: 'GH_OFFLINE' });
  }
  const summary = redact(details);
  return new AppError(summary ? `gh 执行失败：${summary}` : 'gh 执行失败', { statusCode: 502, code: 'GH_FAILED' });
}

// gh pr merge failures carry GitHub's own reason; the common ones get a precise code for the merge sheet.
function describeMergeFailure(result: GhFailure) {
  if (result.reason !== 'failed') return describeFailure(result);
  const reason = redact(`${result.stderr}\n${graphqlMessages(result.stdout)}`);
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (/head branch was modified|head commit|match-head-commit|does not match/.test(output)) {
    return new AppError('PR 在确认期间有了新提交，GitHub 拒绝了合并：请重新查看后再试', { statusCode: 409, code: 'HEAD_MOVED' });
  }
  if (/required status check|status checks? (?:are|is) (?:expected|failing|pending)|base branch policy|protected branch|approving review|review is required|changes requested/.test(output)) {
    return new AppError(`GitHub 拒绝合并：${reason || '不满足分支保护规则'}`, { statusCode: 409, code: 'MERGE_BLOCKED' });
  }
  if (/merge conflict|conflicts|not mergeable/.test(output)) {
    return new AppError('有合并冲突，GitHub 拒绝了合并', { statusCode: 409, code: 'MERGE_CONFLICT' });
  }
  if (/merging is not allowed|merge method|is not allowed/.test(output)) {
    return new AppError(`这个仓库不允许这种合并方式：${reason}`, { statusCode: 400, code: 'METHOD_NOT_ALLOWED' });
  }
  if (/draft/.test(output)) return new AppError('草稿 PR 不能合并', { statusCode: 409, code: 'PR_DRAFT' });
  if (/resource not accessible|must have (?:admin|write|push)|permission|http 403/.test(output)) {
    return new AppError('当前 gh 账号没有合并这个 PR 的权限', { statusCode: 403, code: 'NO_PERMISSION' });
  }
  return describeFailure(result);
}

// Names of a few checks for a message, e.g. "测试、构建 等 5 项".
function checkNames(checks: CheckItem[]) {
  const names = checks.slice(0, 3).map(check => check.name).join('、');
  return checks.length > 3 ? `${names} 等 ${checks.length} 项` : names;
}

function summarizeCounts(passing: number, failing: number, pending: number): ChecksSummary {
  const total = passing + failing + pending;
  const state = failing ? 'failing' : pending ? 'pending' : total ? 'passing' : 'none';
  return { state, passing, failing, pending, total };
}

// The inbox reads only per-state counts of the head commit's checks, which is one cheap GraphQL field.
function countsSummary(contexts: unknown) {
  let passing = 0; let failing = 0; let pending = 0;
  if (isRecord(contexts)) {
    for (const group of [contexts.checkRunCountsByState, contexts.statusContextCountsByState]) {
      for (const item of Array.isArray(group) ? group : []) {
        if (!isRecord(item) || typeof item.state !== 'string') continue;
        const amount = count(item.count);
        if (FAILING_STATES.has(item.state)) failing += amount;
        else if (PENDING_STATES.has(item.state)) pending += amount;
        else passing += amount;
      }
    }
  }
  return summarizeCounts(passing, failing, pending);
}

function headContexts(node: Record<string, unknown>) {
  const commits = isRecord(node.commits) && Array.isArray(node.commits.nodes) ? node.commits.nodes : [];
  const commit = isRecord(commits[0]) && isRecord(commits[0].commit) ? commits[0].commit : null;
  const rollup = commit && isRecord(commit.statusCheckRollup) ? commit.statusCheckRollup : null;
  return rollup && isRecord(rollup.contexts) ? rollup.contexts : null;
}

function checkState(status: unknown, conclusion: unknown): CheckState {
  if (typeof status === 'string' && status !== 'COMPLETED') return 'pending';
  if (typeof conclusion !== 'string') return 'pending';
  if (FAILING_STATES.has(conclusion)) return 'failing';
  if (SKIPPED_STATES.has(conclusion)) return 'skipped';
  if (PENDING_STATES.has(conclusion)) return 'pending';
  return 'passing';
}

const CHECK_ORDER: Record<CheckState, number> = { failing: 0, pending: 1, passing: 2, skipped: 3 };

function readCheckItems(contexts: Record<string, unknown> | null) {
  const nodes = contexts && Array.isArray(contexts.nodes) ? contexts.nodes : [];
  const items = nodes.flatMap((node): CheckItem[] => {
    if (!isRecord(node)) return [];
    if (node.__typename === 'CheckRun') {
      const suite = isRecord(node.checkSuite) && isRecord(node.checkSuite.workflowRun) && isRecord(node.checkSuite.workflowRun.workflow)
        ? node.checkSuite.workflowRun.workflow : null;
      const name = line(node.name, 120);
      return name ? [{ name, workflow: line(suite?.name, 80) || null, state: checkState(node.status, node.conclusion), required: node.isRequired === true, url: httpsUrl(node.detailsUrl) }] : [];
    }
    if (node.__typename === 'StatusContext') {
      const name = line(node.context, 120);
      return name ? [{ name, workflow: null, state: checkState('COMPLETED', node.state), required: node.isRequired === true, url: httpsUrl(node.targetUrl) }] : [];
    }
    return [];
  });
  // Failures first, then running checks; required checks lead within each group.
  return items.sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  const lowered = typeof value === 'string' ? value.toLowerCase() : '';
  return (allowed as readonly string[]).includes(lowered) ? lowered as T : null;
}

// One pull request node as the inbox and the detail sheet show it, or null when GitHub sent something unusable.
function readPull(node: unknown, repository: Record<string, unknown> | null): Omit<PullSummary, 'reasons'> | null {
  if (!isRecord(node)) return null;
  const source = repository ?? (isRecord(node.repository) ? node.repository : null);
  const [owner = '', repo = '', extra] = typeof source?.nameWithOwner === 'string' ? source.nameWithOwner.split('/') : [];
  const number = typeof node.number === 'number' && Number.isSafeInteger(node.number) && node.number > 0 ? node.number : 0;
  const headSha = typeof node.headRefOid === 'string' && SHA.test(node.headRefOid) ? node.headRefOid : '';
  if (extra !== undefined || !OWNER.test(owner) || !REPO.test(repo) || !number || !headSha) return null;
  const fallbackUrl = `https://github.com/${owner}/${repo}/pull/${number}`;
  const url = typeof node.url === 'string' && node.url.startsWith('https://github.com/') ? node.url : fallbackUrl;
  return {
    id: `${owner}/${repo}#${number}`,
    owner, repo, number, url, headSha,
    title: line(node.title, 300) || `#${number}`,
    author: line(isRecord(node.author) ? node.author.login : '', 60) || 'ghost',
    isDraft: node.isDraft === true,
    headRef: line(node.headRefName, 255),
    baseRef: line(node.baseRefName, 255),
    additions: count(node.additions),
    deletions: count(node.deletions),
    changedFiles: count(node.changedFiles),
    mergeable: readEnum(node.mergeable, ['mergeable', 'conflicting', 'unknown'] as const) ?? 'unknown',
    mergeState: readEnum(node.mergeStateStatus, ['behind', 'blocked', 'clean', 'dirty', 'draft', 'has_hooks', 'unknown', 'unstable'] as const) ?? 'unknown',
    reviewDecision: readEnum(node.reviewDecision, ['approved', 'changes_requested', 'review_required'] as const),
    checks: countsSummary(headContexts(node)),
    updatedAt: isoDate(node.updatedAt),
  };
}

// Conditions that stop a merge no matter which method or acknowledgement the request carries.
function blockersOf(detail: Omit<PullDetail, 'blockers'>): Refusal[] {
  const blockers: Refusal[] = [];
  if (detail.state !== 'open') blockers.push({ code: 'PR_NOT_OPEN', message: detail.state === 'merged' ? '这个 PR 已经合并' : '这个 PR 已关闭', status: 409 });
  if (detail.isDraft) blockers.push({ code: 'PR_DRAFT', message: '草稿 PR 不能合并：请先在 GitHub 上标记为可审查', status: 409 });
  if (!detail.viewerCanMerge) blockers.push({ code: 'NO_PERMISSION', message: '当前 gh 账号对这个仓库没有写权限', status: 403 });
  if (detail.mergeable === 'conflicting') blockers.push({ code: 'MERGE_CONFLICT', message: '有合并冲突：请先解决冲突再合并', status: 409 });
  const requiredFailing = detail.checkItems.filter(check => check.required && check.state === 'failing');
  if (requiredFailing.length) blockers.push({ code: 'REQUIRED_CHECKS_FAILED', message: `必需检查未通过：${checkNames(requiredFailing)}`, status: 409 });
  const requiredPending = detail.checkItems.filter(check => check.required && check.state === 'pending');
  if (requiredPending.length) blockers.push({ code: 'REQUIRED_CHECKS_PENDING', message: `必需检查还在运行：${checkNames(requiredPending)}`, status: 409 });
  if (!detail.mergeMethods.length) blockers.push({ code: 'NO_MERGE_METHOD', message: '这个仓库没有开启任何合并方式', status: 409 });
  return blockers;
}

// The first reason this exact request must be refused, checked against a fresh read of the pull request.
function refusalFor(detail: PullDetail, request: MergeRequest): Refusal | null {
  const closed = detail.blockers.find(blocker => blocker.code === 'PR_NOT_OPEN');
  if (closed) return { ...closed, status: 409 };
  if (detail.headSha !== request.expectedHeadSha) {
    return { code: 'HEAD_MOVED', message: `PR 有了新提交（现在是 ${shortSha(detail.headSha)}）：请重新查看后再合并`, status: 409 };
  }
  const blocker = blockersOf(detail)[0];
  if (blocker) return blocker;
  if (!detail.mergeMethods.includes(request.method)) {
    return { code: 'METHOD_NOT_ALLOWED', message: `这个仓库没有开启${METHOD_LABEL[request.method]}`, status: 400 };
  }
  const failing = detail.checkItems.filter(check => check.state === 'failing');
  if (failing.length && !request.acknowledgeFailing) {
    return { code: 'CHECKS_FAILING', message: `有 ${failing.length} 项检查未通过（${checkNames(failing)}）：确认后才能合并`, status: 409 };
  }
  return null;
}

/** Used by github.routes to validate the :owner/:repo/:number path; the result is safe to place in gh's argv. */
export function parseGitHubPullRef(params: { owner?: unknown; repo?: unknown; number?: unknown }): PullRef {
  const { owner, repo, number } = params;
  if (typeof owner !== 'string' || !OWNER.test(owner)) fail('仓库所有者格式无效', 400, 'INVALID_OWNER');
  if (typeof repo !== 'string' || !REPO.test(repo) || repo === '.' || repo === '..') fail('仓库名格式无效', 400, 'INVALID_REPO');
  if (typeof number !== 'string' || !NUMBER.test(number) || Number(number) > MAX_NUMBER) fail('PR 编号无效', 400, 'INVALID_NUMBER');
  return { owner, repo, number: Number(number) };
}

/** Used by github.routes to validate a merge request body: method, the head SHA the user saw, and two flags. */
export function parseGitHubMergeRequest(body: unknown): MergeRequest {
  if (!isRecord(body)) fail('请求格式无效', 400, 'INVALID_BODY');
  const method = typeof body.method === 'string' && (MERGE_METHODS as readonly string[]).includes(body.method) ? body.method as MergeMethod : null;
  if (!method) fail('合并方式应为 merge、squash 或 rebase', 400, 'INVALID_METHOD');
  if (typeof body.expectedHeadSha !== 'string' || !SHA.test(body.expectedHeadSha)) fail('缺少有效的头提交 SHA（40 位小写十六进制）', 400, 'INVALID_SHA');
  for (const flag of ['deleteBranch', 'acknowledgeFailing'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') fail(`${flag} 应为布尔值`, 400, 'INVALID_FLAG');
  }
  return { method, expectedHeadSha: body.expectedHeadSha, deleteBranch: body.deleteBranch === true, acknowledgeFailing: body.acknowledgeFailing === true };
}

/**
 * Used by studio.module, behind /api/studio/github: the owner's GitHub through the gh CLI already signed in on the
 * server. Reads (account status, PR inbox, PR detail) are cached and single-flight; a merge re-reads the pull request,
 * refuses on a moved head, failing required checks and other blockers, passes --match-head-commit so GitHub refuses
 * a head that moves afterwards, and records every attempt in studio_github_merges.
 */
export function createGitHubService({ database, run, now = Date.now }: { database: Database.Database; run: StudioGhRun; now?: () => number }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS studio_github_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      number INTEGER NOT NULL, method TEXT NOT NULL, head_sha TEXT NOT NULL, delete_branch INTEGER NOT NULL,
      outcome TEXT NOT NULL, code TEXT, message TEXT, created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_github_merges_user_time ON studio_github_merges (user_id, created_at);
  `);

  let status: CacheEntry<GitHubStatus> | null = null;
  let statusRequest: Promise<GitHubStatus> | null = null;
  let inbox: CacheEntry<Inbox> | null = null;
  let inboxRequest: Promise<Inbox> | null = null;
  const details = new Map<string, CacheEntry<PullDetail>>();
  const detailRequests = new Map<string, Promise<PullDetail>>();
  // Pull requests with a merge in flight; a second attempt on the same one is refused rather than queued.
  const merging = new Set<string>();

  const iso = () => new Date(now()).toISOString();
  const refKey = (ref: PullRef) => `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
  // A cached value is reused while fresh, and a forced refresh right after a fetch reuses it too.
  const fresh = (entry: CacheEntry<unknown> | null | undefined, force: boolean) =>
    Boolean(entry) && now() - entry!.at < (force ? FORCE_MIN_INTERVAL_MS : CACHE_TTL_MS);

  async function graphql(query: string, fields: string[]) {
    const result = await run(['api', 'graphql', '-f', `query=${query}`, ...fields], { timeoutMs: READ_TIMEOUT_MS });
    let parsed: unknown = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* handled below */ }
    // GitHub can answer with partial data and errors (one search failing); gh then exits 1 but the data is usable.
    if (isRecord(parsed) && isRecord(parsed.data)) return parsed.data;
    if (!result.ok) throw describeFailure(result);
    fail('GitHub 返回了无法识别的数据', 502, 'GH_BAD_RESPONSE');
  }

  async function readStatus(): Promise<GitHubStatus> {
    const checkedAt = iso();
    const result = await run(['auth', 'status', '--hostname', HOST, '--json', 'hosts'], { timeoutMs: READ_TIMEOUT_MS, maxBuffer: 256 * 1024 });
    const signedOut = (message: string, installed = true): GitHubStatus => ({ installed, authenticated: false, login: null, scopes: [], canMerge: false, message, checkedAt });
    if (!result.ok) {
      if (result.reason === 'missing') return signedOut('服务器上没有安装 GitHub CLI（gh），或设置 STUDIO_GH_PATH 指向它', false);
      if (result.reason === 'failed' && /unknown flag|unknown shorthand/.test(result.stderr)) return signedOut('gh 版本过旧：请升级到支持 gh auth status --json 的版本');
      throw describeFailure(result);
    }
    let parsed: unknown = null;
    try { parsed = JSON.parse(result.stdout); } catch { fail('gh auth status 返回了无法识别的数据', 502, 'GH_BAD_RESPONSE'); }
    const entries = isRecord(parsed) && isRecord(parsed.hosts) && Array.isArray(parsed.hosts[HOST]) ? parsed.hosts[HOST] : [];
    // Only these fields are read; gh does not include the token unless --show-token is passed, which is never done.
    const account = (entries.find(entry => isRecord(entry) && entry.active === true) ?? entries[0]) as Record<string, unknown> | undefined;
    if (!isRecord(account)) return signedOut('gh 还没有登录 GitHub：请在服务器上运行 gh auth login');
    const login = typeof account.login === 'string' && OWNER.test(account.login) ? account.login : null;
    const scopes = typeof account.scopes === 'string'
      ? account.scopes.split(',').map(scope => scope.trim()).filter(scope => SCOPE.test(scope)) : [];
    if (account.state !== 'success' || !login) {
      return { ...signedOut(account.state === 'timeout' ? '检查 gh 登录时连不上 GitHub' : 'gh 的登录已失效：请在服务器上运行 gh auth login'), login };
    }
    const canMerge = scopes.length === 0 || scopes.includes('repo');
    return { installed: true, authenticated: true, login, scopes, canMerge, message: canMerge ? null : 'gh 令牌缺少 repo 权限，无法合并：请运行 gh auth refresh -s repo', checkedAt };
  }

  async function getStatus(force: boolean) {
    if (status && now() - status.at < (force ? FORCE_MIN_INTERVAL_MS : STATUS_TTL_MS)) return status.value;
    statusRequest ??= readStatus().then(value => { status = { at: now(), value }; return value; }).finally(() => { statusRequest = null; });
    return statusRequest;
  }

  async function readInbox(): Promise<Inbox> {
    // @me lets the search run alongside the (usually cached) account check instead of after it.
    const base = 'is:pr is:open archived:false';
    const [account, search] = await Promise.all([
      getStatus(false),
      graphql(INBOX_QUERY, [
        '-f', `authored=${base} author:@me sort:updated-desc`,
        '-f', `review=${base} review-requested:@me sort:updated-desc`,
        '-f', `owned=${base} user:@me sort:updated-desc`,
      ]).then(data => ({ data }), (error: unknown) => ({ error })),
    ]);
    // The account check explains a missing or signed-out gh better than the search's own failure does.
    if (!account.installed) fail(account.message ?? '服务器上没有找到 gh', 503, 'GH_MISSING');
    if (!account.authenticated || !account.login) fail(account.message ?? 'gh 未登录', 409, 'GH_NOT_AUTHENTICATED');
    if ('error' in search) throw search.error;
    const { data } = search;
    const login = account.login;
    const pulls = new Map<string, PullSummary>();
    let truncated = false;
    for (const reason of ['authored', 'review', 'owned'] as const) {
      const results = data[reason];
      if (!isRecord(results)) continue;
      const nodes = Array.isArray(results.nodes) ? results.nodes : [];
      if (count(results.issueCount) > nodes.length) truncated = true;
      for (const node of nodes) {
        const pull = readPull(node, null);
        if (!pull) continue;
        const known = pulls.get(pull.id);
        if (known) { if (!known.reasons.includes(reason)) known.reasons.push(reason); }
        else pulls.set(pull.id, { ...pull, reasons: [reason] });
      }
    }
    const sorted = [...pulls.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { login, pulls: sorted, fetchedAt: iso(), truncated };
  }

  async function readDetail(ref: PullRef): Promise<PullDetail> {
    const data = await graphql(DETAIL_QUERY, ['-f', `owner=${ref.owner}`, '-f', `repo=${ref.repo}`, '-F', `number=${ref.number}`]);
    const repository = isRecord(data.repository) ? data.repository : null;
    const node = repository && isRecord(repository.pullRequest) ? repository.pullRequest : null;
    if (!repository || !node) fail(`找不到 ${ref.owner}/${ref.repo} 的 #${ref.number}`, 404, 'GITHUB_NOT_FOUND');
    const summary = readPull(node, repository);
    if (!summary) fail('GitHub 返回了无法识别的 PR 数据', 502, 'GH_BAD_RESPONSE');
    const contexts = headContexts(node);
    const checkItems = readCheckItems(contexts);
    const passing = checkItems.filter(check => check.state === 'passing' || check.state === 'skipped').length;
    const failing = checkItems.filter(check => check.state === 'failing').length;
    const pending = checkItems.filter(check => check.state === 'pending').length;
    const files = isRecord(node.files) && Array.isArray(node.files.nodes) ? node.files.nodes : [];
    const { body, truncated } = excerpt(node.body);
    const mergeCommit = isRecord(node.mergeCommit) && typeof node.mergeCommit.oid === 'string' && SHA.test(node.mergeCommit.oid) ? node.mergeCommit.oid : null;
    const withoutBlockers: Omit<PullDetail, 'blockers'> = {
      ...summary,
      // The detail lists every check, so its summary is counted from the list rather than the inbox's counters.
      checks: summarizeCounts(passing, failing, pending),
      reasons: [],
      state: readEnum(node.state, ['open', 'closed', 'merged'] as const) ?? 'closed',
      body, bodyTruncated: truncated,
      createdAt: isoDate(node.createdAt),
      checkItems,
      checksTruncated: count(contexts?.totalCount) > checkItems.length,
      files: files.flatMap(file => isRecord(file) && typeof file.path === 'string' && file.path
        ? [{ path: line(file.path, 400), additions: count(file.additions), deletions: count(file.deletions), change: readEnum(file.changeType, ['added', 'modified', 'deleted', 'renamed', 'copied', 'changed'] as const) ?? 'changed' }]
        : []),
      filesTotal: isRecord(node.files) ? count(node.files.totalCount) : 0,
      mergeMethods: MERGE_METHODS.filter(method => repository[METHOD_SETTING[method]] === true),
      deleteBranchOnMerge: repository.deleteBranchOnMerge === true,
      isCrossRepository: node.isCrossRepository === true,
      viewerCanMerge: typeof repository.viewerPermission === 'string' && WRITE_PERMISSIONS.has(repository.viewerPermission),
      mergeCommitSha: mergeCommit,
    };
    return { ...withoutBlockers, blockers: blockersOf(withoutBlockers).map(({ code, message }) => ({ code, message })) };
  }

  function getDetail(ref: PullRef, force: boolean) {
    const key = refKey(ref);
    const hit = details.get(key);
    if (fresh(hit, force)) return Promise.resolve(hit!.value);
    const running = detailRequests.get(key);
    if (running) return running;
    const request = readDetail(ref).then(value => {
      details.delete(key);
      details.set(key, { at: now(), value });
      // Oldest entries go first once the cache is full (Map keeps insertion order).
      while (details.size > MAX_DETAIL_CACHE) details.delete(details.keys().next().value as string);
      return value;
    }).finally(() => detailRequests.delete(key));
    detailRequests.set(key, request);
    return request;
  }

  // Merges change the inbox and the pull request, whatever their outcome.
  function invalidate(ref: PullRef) {
    details.delete(refKey(ref));
    inbox = null;
  }

  function record(userId: number, ref: PullRef, request: MergeRequest) {
    const result = database.prepare(`INSERT INTO studio_github_merges
      (user_id, owner, repo, number, method, head_sha, delete_branch, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(userId, ref.owner, ref.repo, ref.number, request.method, request.expectedHeadSha, request.deleteBranch ? 1 : 0, iso());
    return Number(result.lastInsertRowid);
  }

  function finish(id: number, outcome: Exclude<MergeOutcome, 'pending'>, code: string | null, message: string) {
    database.prepare('UPDATE studio_github_merges SET outcome = ?, code = ?, message = ?, finished_at = ? WHERE id = ?').run(outcome, code, message, iso(), id);
  }

  return {
    status(force = false) {
      return getStatus(force);
    },

    async pulls(force = false) {
      if (fresh(inbox, force)) return inbox!.value;
      inboxRequest ??= readInbox().then(value => { inbox = { at: now(), value }; return value; }).finally(() => { inboxRequest = null; });
      return inboxRequest;
    },

    pull(ref: PullRef, force = false) {
      return getDetail(ref, force);
    },

    async merge(userId: number, ref: PullRef, request: MergeRequest) {
      const key = refKey(ref);
      if (merging.has(key)) fail('这个 PR 正在合并，请稍候', 409, 'MERGE_IN_PROGRESS');
      let recordId: number;
      try {
        recordId = record(userId, ref, request);
      } catch (error) {
        // Nothing is merged without an audit row.
        console.error('[studio] github merge audit insert failed:', error instanceof Error ? error.message : error);
        throw new AppError('无法写入合并记录，已取消合并', { statusCode: 500, code: 'AUDIT_FAILED' });
      }
      merging.add(key);
      let finished = false;
      const close = (outcome: Exclude<MergeOutcome, 'pending'>, code: string | null, message: string) => { finished = true; finish(recordId, outcome, code, message); };
      try {
        // Always a fresh read: the decision is made on what GitHub says now, not on what the sheet showed (the cached
        // copy is dropped first, so even a detail fetched a moment ago is read again).
        details.delete(key);
        const detail = await getDetail(ref, true);
        const refusal = refusalFor(detail, request);
        if (refusal) {
          close('refused', refusal.code, refusal.message);
          throw new AppError(refusal.message, { statusCode: refusal.status, code: refusal.code });
        }
        const args = ['pr', 'merge', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, `--${request.method}`, '--match-head-commit', request.expectedHeadSha];
        if (request.deleteBranch) args.push('--delete-branch');
        const result = await run(args, { timeoutMs: MERGE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        invalidate(ref);
        if (!result.ok) {
          if (result.reason === 'timeout') {
            const message = '合并请求超时：GitHub 可能已经合并，请刷新或在 GitHub 上确认';
            close('unknown', 'MERGE_OUTCOME_UNKNOWN', message);
            throw new AppError(message, { statusCode: 504, code: 'MERGE_OUTCOME_UNKNOWN' });
          }
          const failure = describeMergeFailure(result);
          close('failed', failure.code, failure.message);
          throw failure;
        }
        // gh exits 0 once GitHub accepted the merge; a follow-up read tells a finished merge from a merge queue entry.
        let outcome: 'merged' | 'queued' = 'merged';
        let mergeCommitSha: string | null = null;
        try {
          const after = await getDetail(ref, true);
          if (after.state === 'merged') mergeCommitSha = after.mergeCommitSha;
          else if (after.state === 'open') outcome = 'queued';
        } catch { /* The merge itself succeeded; only the confirmation read failed. */ }
        const message = outcome === 'merged'
          ? `已${METHOD_LABEL[request.method]} #${ref.number} 到 ${detail.baseRef}`
          : `#${ref.number} 已交给 GitHub，正在合并队列中等待`;
        close(outcome, null, message);
        return { outcome, mergeCommitSha, message };
      } catch (error) {
        if (!finished) {
          const failure = error instanceof AppError ? error : null;
          finish(recordId, 'failed', failure?.code ?? 'INTERNAL_ERROR', failure?.message ?? '合并失败');
        }
        throw error;
      } finally {
        merging.delete(key);
      }
    },

    // The signed-in Studio user's most recent merge attempts, newest first.
    merges(userId: number, limit = 20) {
      const rows = database.prepare('SELECT * FROM studio_github_merges WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as MergeRow[];
      return rows.map(row => ({
        id: row.id, owner: row.owner, repo: row.repo, number: row.number, method: row.method, headSha: row.head_sha,
        deleteBranch: row.delete_branch === 1, outcome: row.outcome, code: row.code, message: row.message,
        createdAt: row.created_at, finishedAt: row.finished_at,
      }));
    },
  };
}
