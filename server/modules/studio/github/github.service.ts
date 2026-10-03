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
// A GitHub Actions run on the head commit that waits for someone to approve it: a first-time contributor's fork run
// ('contributor'), or a run held by environment protection rules the gh account may approve ('deployment').
type PendingRun = { id: number; name: string; kind: 'contributor' | 'deployment'; environments: string[] };
// What approving a pending run needs: the environment ids the gh account may approve (deployment runs only).
type RunApproval = PendingRun & { environmentIds: number[] };
type PullDetail = PullSummary & {
  state: 'open' | 'closed' | 'merged'; body: string; bodyTruncated: boolean; createdAt: string;
  checkItems: CheckItem[]; checksTruncated: boolean; files: FileItem[]; filesTotal: number;
  mergeMethods: MergeMethod[]; deleteBranchOnMerge: boolean; isCrossRepository: boolean; viewerCanMerge: boolean;
  // The base branch requires a merge queue: gh then queues the PR instead of merging it (and refuses --delete-branch).
  mergeQueue: boolean;
  blockers: Blocker[]; mergeCommitSha: string | null;
  // Actions runs on the head commit waiting for approval; empty when GitHub could not be asked (never fails the read).
  pendingRuns: PendingRun[];
};
// The one-tap fixes the detail sheet offers next to a blocker, each audited in studio_github_actions.
type PullAction = 'update-branch' | 'ready' | 'approve-runs';
type ActionOutcome = 'pending' | 'done' | 'refused' | 'failed' | 'unknown' | 'invalid';
/** A validated update-branch request: the head SHA the user saw, which GitHub must still find on the branch. */
type UpdateBranchRequest = { expectedHeadSha: string };
/** A validated approve-runs request: distinct positive run ids, at most MAX_APPROVE_RUNS. */
type ApproveRunsRequest = { runIds: number[] };
// 'invalid' marks a merge request the router rejected (bad method, SHA or flags) after the PR address parsed.
type MergeOutcome = 'pending' | 'merged' | 'queued' | 'refused' | 'failed' | 'unknown' | 'invalid';
type MergeRow = {
  // An invalid request stores '' for a method or SHA it did not carry in a valid form.
  id: number; owner: string; repo: string; number: number; method: MergeMethod | ''; head_sha: string; delete_branch: number;
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
// A merged pull request stays out of the inbox this long, because GitHub's search index lists it as open for a while
// after the merge. Merged pull requests can never be reopened, so hiding one is always safe.
const MERGED_HIDE_MS = 5 * 60_000;
// Updating a branch, marking a PR ready or approving a run is one quick GitHub call each.
const ACTION_TIMEOUT_MS = 30_000;
// Runs on one head commit that are looked up for pending deployments; more than this is never realistic.
const MAX_DEPLOYMENT_LOOKUPS = 6;
const MAX_APPROVE_RUNS = 20;
const APPROVAL_COMMENT = 'Approved from Studio';

// GitHub logins and organisation names never start with "-", so no owner can be read as a gh flag.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,9}$/;
// GraphQL Int is 32-bit.
const MAX_NUMBER = 2_147_483_647;
const SHA = /^[0-9a-f]{40}$/;
const SCOPE = /^[a-z][a-z0-9:_-]{0,40}$/;
// A git branch name as gh may receive it: no leading "-", no "..", "//" or "@{", no trailing "/" or ".lock".
const BRANCH = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|\/$|\.lock$))[A-Za-z0-9._/-]{1,200}$/;
const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];
const METHOD_LABEL: Record<MergeMethod, string> = { merge: '合并提交', squash: '压缩合并', rebase: '变基合并' };
// The repository settings that turn each method on.
const METHOD_SETTING: Record<MergeMethod, string> = { merge: 'mergeCommitAllowed', squash: 'squashMergeAllowed', rebase: 'rebaseMergeAllowed' };
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
// gh's advice printed after it refuses a merge. Never shown: Studio offers neither --auto nor --admin (which bypasses
// branch protection), and the local conflict recipe does not apply on the server.
const GH_ADVICE = /--admin|--auto\b|administrator privileges|run the following to resolve|^gh pr checkout /i;

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
      additions deletions changedFiles mergeable mergeStateStatus reviewDecision isCrossRepository isMergeQueueEnabled
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

// What gh printed for a failed merge as clean lines: no styling, no token-shaped strings and none of gh's advice.
function mergeOutputLines(result: GhFailure) {
  return stripAnsiSequences(`${result.stderr}\n${graphqlMessages(result.stdout)}`).replace(TOKEN_PATTERN, '[已隐藏]').split(/\r?\n/)
    .map(item => item.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim())
    .filter(item => item && !GH_ADVICE.test(item));
}

const clip = (value: string) => value.length > MAX_ERROR_LENGTH ? `${value.slice(0, MAX_ERROR_LENGTH - 1)}…` : value;
const mergeRefusal = (code: string, message: string, statusCode = 409) => new AppError(message, { statusCode, code });
const HEAD_BEHIND_MESSAGE = '分支落后于目标分支，仓库要求先更新分支后再合并';
const CONFLICT_MESSAGE = '有合并冲突：请先解决冲突再合并';

// GitHub refusing a required status check, e.g. `Required status check "build" is expected.`, in Chinese.
function requiredChecksMessage(source: string) {
  const names = [...source.matchAll(/"([^"]{1,80})"/g)].map(match => line(match[1], 60)).filter(Boolean);
  const listed = names.length ? `「${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}」` : '';
  const waiting = /expected|pending|in progress|have not|haven't/i.test(source);
  return `必需检查${listed}${waiting ? '还没有结果' : '没有通过'}，分支保护不允许合并`;
}

/**
 * gh pr merge failures as the real reason in Chinese with a precise code for the merge sheet. gh refuses on its own
 * side with "X Pull request o/r#N is not mergeable: <reason>." followed by advice about --auto and --admin; the
 * reason line is used and the advice is dropped. GitHub's refusals of the merge mutation are mapped the same way.
 */
function describeMergeFailure(result: GhFailure) {
  if (result.reason !== 'failed') return describeFailure(result);
  const lines = mergeOutputLines(result);
  const text = lines.join('\n');
  if (/unknown flag|unknown shorthand/i.test(text)) return mergeRefusal('GH_OUTDATED', 'gh 版本过旧，不支持 --match-head-commit：请在服务器上升级 gh', 502);
  if (/head branch was modified|head (?:commit|sha|oid)\b[^\n]*(?:does not|doesn't|did not|didn't) match/i.test(text)) {
    return mergeRefusal('HEAD_MOVED', 'PR 在确认期间有了新提交，GitHub 拒绝了合并：请重新查看后再试');
  }
  if (/base branch was modified/i.test(text)) return mergeRefusal('BASE_MOVED', '目标分支刚刚有了新提交，GitHub 拒绝了合并：请重新载入后再试');
  // gh's own pre-check, which reads mergeStateStatus: BLOCKED, BEHIND or DIRTY.
  const ghReason = lines.map(item => /is not mergeable: (.+?)\.?$/i.exec(item)?.[1]).find(Boolean);
  if (ghReason) {
    if (/not up to date|behind/i.test(ghReason)) return mergeRefusal('HEAD_BEHIND', HEAD_BEHIND_MESSAGE);
    if (/cannot be cleanly created|conflict/i.test(ghReason)) return mergeRefusal('MERGE_CONFLICT', CONFLICT_MESSAGE);
    if (/base branch policy|prohibits/i.test(ghReason)) return mergeRefusal('MERGE_BLOCKED', '分支保护规则不允许合并：可能还缺少必需的审查或检查');
    return mergeRefusal('MERGE_BLOCKED', `GitHub 拒绝合并：${clip(ghReason)}`);
  }
  // GitHub's own refusals of the merge mutation.
  const checksLine = lines.find(item => /required status checks?/i.test(item));
  if (checksLine) return mergeRefusal('MERGE_BLOCKED', requiredChecksMessage(checksLine));
  if (/verified signatures|signed commits/i.test(text)) return mergeRefusal('MERGE_BLOCKED', '分支保护要求签名提交：这个 PR 里有未签名的提交');
  if (/repository rule violations?|ruleset/i.test(text)) return mergeRefusal('MERGE_BLOCKED', '仓库规则不允许合并：请在 GitHub 上查看具体规则');
  if (/changes requested|requested changes/i.test(text)) return mergeRefusal('MERGE_BLOCKED', '审查者要求修改，分支保护不允许合并');
  if (/approving reviews?|reviews? (?:is |are )?required|review required|code owner review/i.test(text)) {
    return mergeRefusal('MERGE_BLOCKED', '分支保护要求先通过审查：需要有写权限的审查者批准');
  }
  if (/delete-branch[^\n]*merge queue/i.test(text)) {
    return mergeRefusal('DELETE_BRANCH_UNSUPPORTED', '这个仓库使用合并队列，合并时不能删除分支：请关闭「合并后删除」再试', 400);
  }
  if (/merge already in progress|already being merged/i.test(text)) return mergeRefusal('MERGE_IN_PROGRESS', 'GitHub 上已有一次合并在进行中：请稍后刷新');
  if (/already merged/i.test(text)) return mergeRefusal('PR_NOT_OPEN', '这个 PR 已经合并');
  if (/(?:merge commits|squash merges|rebase merges) are not allowed|merging is not allowed|merge method/i.test(text)) {
    return mergeRefusal('METHOD_NOT_ALLOWED', '这个仓库不允许这种合并方式：请换一种方式', 400);
  }
  if (/(?:can't|cannot|could not) be rebased/i.test(text)) return mergeRefusal('METHOD_NOT_ALLOWED', '这个 PR 不能变基合并：请换一种合并方式', 400);
  const cleaned: GhFailure = { ...result, stderr: text, stdout: '' };
  // Sign-in, rate limit, SAML and network failures keep their own messages.
  const generic = describeFailure(cleaned);
  if (generic.code !== 'GH_FAILED') return generic;
  if (/draft/i.test(text)) return mergeRefusal('PR_DRAFT', '草稿 PR 不能合并');
  if (/resource not accessible|must have (?:admin|write|push)|permission|http 403/i.test(text)) {
    return mergeRefusal('NO_PERMISSION', '当前 gh 账号没有合并这个 PR 的权限', 403);
  }
  if (/merge conflict/i.test(text)) return mergeRefusal('MERGE_CONFLICT', CONFLICT_MESSAGE);
  if (/not mergeable/i.test(text)) return mergeRefusal('MERGE_BLOCKED', 'GitHub 认为这个 PR 现在不能合并：请重新载入 PR 查看原因');
  return generic;
}

// A GitHub database id (run, environment) as a positive safe integer, or 0; only such ids reach argv and API paths.
const positiveId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

// The messages of a failed `gh api` call: the REST body's `message` and any GraphQL-style `errors`, both on stdout.
function apiMessages(stdout: string) {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) return '';
    const own = typeof parsed.message === 'string' ? [parsed.message] : [];
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(error => isRecord(error) && typeof error.message === 'string' ? error.message : '') : [];
    return [...own, ...errors].filter(Boolean).join('\n');
  } catch { return ''; }
}

const actionRefusal = (code: string, message: string, statusCode = 409) => new AppError(message, { statusCode, code });

/**
 * Failures of the one-tap fixes (update branch, mark ready, approve runs) as a short Chinese reason with a code, in
 * the style of describeFailure: GitHub's specific refusals first, then sign-in, rate limit, SAML and network, then a
 * missing permission. Raw output only ever surfaces redacted, as one line.
 */
function describeActionFailure(result: GhFailure) {
  if (result.reason !== 'failed') return describeFailure(result);
  const text = stripAnsiSequences(`${result.stderr}\n${apiMessages(result.stdout)}`).replace(TOKEN_PATTERN, '[已隐藏]').split(/\r?\n/)
    .map(item => item.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim())
    .filter(item => item && !GH_ADVICE.test(item)).join('\n');
  if (/unknown command|unknown flag|unknown shorthand/i.test(text)) return actionRefusal('GH_OUTDATED', 'gh 版本过旧，不支持这个操作：请在服务器上升级 gh', 502);
  if (/expected head sha|head sha[^\n]*(?:match|differ)|head ref[^\n]*(?:changed|match)/i.test(text)) {
    return actionRefusal('HEAD_MOVED', 'PR 在确认期间有了新提交，GitHub 没有更新分支：请重新查看后再试');
  }
  if (/merge conflict/i.test(text)) return actionRefusal('MERGE_CONFLICT', '和目标分支有冲突，无法自动更新：请在本地解决冲突');
  if (/no new commits|already up[ -]to[ -]date|is up to date/i.test(text)) return actionRefusal('ALREADY_UP_TO_DATE', '分支已经是最新的，不需要更新');
  if (/not from a fork|cannot be approved|not waiting|already (?:been )?approved|no pending deployments?/i.test(text)) {
    return actionRefusal('RUN_NOT_PENDING', '这个运行已经不需要批准：请刷新后再看');
  }
  const cleaned: GhFailure = { ...result, stderr: text, stdout: '' };
  const generic = describeFailure(cleaned);
  if (generic.code !== 'GH_FAILED') return generic;
  if (/resource not accessible|must have (?:admin|write|push)|not authorized|permission|http 403/i.test(text)) {
    return actionRefusal('NO_PERMISSION', '当前 gh 账号没有权限执行这个操作', 403);
  }
  return generic;
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
  if (detail.isDraft) blockers.push({ code: 'PR_DRAFT', message: '草稿 PR 不能合并：请先标记为可审查', status: 409 });
  if (!detail.viewerCanMerge) blockers.push({ code: 'NO_PERMISSION', message: '当前 gh 账号对这个仓库没有写权限', status: 403 });
  if (detail.mergeable === 'conflicting' || detail.mergeState === 'dirty') blockers.push({ code: 'MERGE_CONFLICT', message: CONFLICT_MESSAGE, status: 409 });
  const requiredFailing = detail.checkItems.filter(check => check.required && check.state === 'failing');
  if (requiredFailing.length) blockers.push({ code: 'REQUIRED_CHECKS_FAILED', message: `必需检查未通过：${checkNames(requiredFailing)}`, status: 409 });
  const requiredPending = detail.checkItems.filter(check => check.required && check.state === 'pending');
  if (requiredPending.length) blockers.push({ code: 'REQUIRED_CHECKS_PENDING', message: `必需检查还在运行：${checkNames(requiredPending)}`, status: 409 });
  // gh refuses BEHIND and BLOCKED unless --admin is passed, which Studio never does, so the sheet says so up front.
  // With a merge queue gh skips that check and queues the pull request, so neither state blocks there.
  if (detail.state === 'open' && !detail.mergeQueue) {
    if (detail.mergeState === 'behind') {
      blockers.push({ code: 'HEAD_BEHIND', message: `${detail.headRef} 落后于 ${detail.baseRef}，仓库要求先更新分支后再合并`, status: 409 });
    }
    // A blocker above already explains most BLOCKED states; otherwise the review decision usually does.
    if (detail.mergeState === 'blocked' && !blockers.length) {
      const message = detail.reviewDecision === 'review_required' ? '分支保护要求先通过审查才能合并'
        : detail.reviewDecision === 'changes_requested' ? '审查者要求修改，分支保护不允许合并'
          : '分支保护规则不允许合并：可能缺少必需的审查、检查或签名提交';
      blockers.push({ code: 'MERGE_BLOCKED', message, status: 409 });
    }
  }
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
  // UNSTABLE: GitHub sees non-passing checks that branch protection does not require, including any beyond the 100
  // listed, so it needs the same explicit acknowledgement as a failing check in the list.
  if ((failing.length || detail.mergeState === 'unstable') && !request.acknowledgeFailing) {
    const message = failing.length ? `有 ${failing.length} 项检查未通过（${checkNames(failing)}）：确认后才能合并`
      : 'GitHub 报告有检查没有通过或还在运行：确认后才能合并';
    return { code: 'CHECKS_FAILING', message, status: 409 };
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

/** Used by github.routes to validate an update-branch body: the head SHA the user saw in the sheet. */
export function parseGitHubUpdateBranchRequest(body: unknown): UpdateBranchRequest {
  if (!isRecord(body)) fail('请求格式无效', 400, 'INVALID_BODY');
  if (typeof body.expectedHeadSha !== 'string' || !SHA.test(body.expectedHeadSha)) fail('缺少有效的头提交 SHA（40 位小写十六进制）', 400, 'INVALID_SHA');
  return { expectedHeadSha: body.expectedHeadSha };
}

/** Used by github.routes to validate an approve-runs body: 1–20 distinct positive integer run ids. */
export function parseGitHubApproveRunsRequest(body: unknown): ApproveRunsRequest {
  if (!isRecord(body) || !Array.isArray(body.runIds)) fail('请求格式无效：缺少 runIds', 400, 'INVALID_BODY');
  const runIds = body.runIds.map(positiveId);
  if (!runIds.length || runIds.length > MAX_APPROVE_RUNS || runIds.some(id => !id)) fail(`runIds 应为 1–${MAX_APPROVE_RUNS} 个正整数`, 400, 'INVALID_RUN_IDS');
  return { runIds: [...new Set(runIds)] };
}

/** Used by github-branch.service to accept only an owner/repo pair that is safe to place in gh's argv. */
export function isGitHubRepository(owner: string, repo: string) {
  return OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..';
}

/**
 * Used by studio.module, behind /api/studio/github: the owner's GitHub through the gh CLI already signed in on the
 * server. Reads (account status, PR inbox, PR detail) are cached and single-flight; a merge re-reads the pull request,
 * refuses on a moved head, failing required checks and other blockers, passes --match-head-commit so GitHub refuses
 * a head that moves afterwards, and records every attempt in studio_github_merges (requests the router rejects too,
 * through recordInvalidMerge). A finished merge hides the pull request from the inbox at once.
 * The one-tap fixes the detail sheet offers next to a blocker (更新分支, 标记为可审查, 批准运行) follow the same rules:
 * audited in studio_github_actions, decided on a fresh strict read, never with --admin or anything that bypasses
 * branch protection, and followed by dropped caches and a new read. Also used by github-branch.service for the PR of
 * a workbench project's branch (status and pull).
 */
export function createGitHubService({ database, run, now = Date.now }: { database: Database.Database; run: StudioGhRun; now?: () => number }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS studio_github_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      number INTEGER NOT NULL, method TEXT NOT NULL, head_sha TEXT NOT NULL, delete_branch INTEGER NOT NULL,
      outcome TEXT NOT NULL, code TEXT, message TEXT, created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_github_merges_user_time ON studio_github_merges (user_id, created_at);
    CREATE TABLE IF NOT EXISTS studio_github_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
      number INTEGER NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, outcome TEXT NOT NULL, code TEXT, message TEXT,
      created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_github_actions_user_time ON studio_github_actions (user_id, created_at);
  `);

  let status: CacheEntry<GitHubStatus> | null = null;
  let statusRequest: Promise<GitHubStatus> | null = null;
  let inbox: CacheEntry<Inbox> | null = null;
  let inboxRequest: Promise<Inbox> | null = null;
  const details = new Map<string, CacheEntry<PullDetail>>();
  const detailRequests = new Map<string, Promise<PullDetail>>();
  // Pull requests with a merge in flight; a second attempt on the same one is refused rather than queued.
  const merging = new Set<string>();
  // Pull requests with a one-tap fix in flight; a merge or a second fix on the same one is refused meanwhile.
  const acting = new Set<string>();
  // Bumped by every merge attempt that reached gh: a read that started before it never writes its result to a cache.
  let cacheGeneration = 0;
  // Pull requests merged through Studio (refKey → when), hidden from every inbox answer for MERGED_HIDE_MS.
  const recentlyMerged = new Map<string, number>();

  const iso = () => new Date(now()).toISOString();
  const refKey = (ref: PullRef) => `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
  // A cached value is reused while fresh, and a forced refresh right after a fetch reuses it too.
  const fresh = (entry: CacheEntry<unknown> | null | undefined, force: boolean) =>
    Boolean(entry) && now() - entry!.at < (force ? FORCE_MIN_INTERVAL_MS : CACHE_TTL_MS);

  // `strict` is for the read a merge decides on: any GraphQL error rejects it, because a field that failed (checks,
  // isRequired) comes back as null and would silently weaken the merge guard. Other reads keep partial data.
  async function graphql(query: string, fields: string[], strict = false) {
    const result = await run(['api', 'graphql', '-f', `query=${query}`, ...fields], { timeoutMs: READ_TIMEOUT_MS });
    let parsed: unknown = null;
    try { parsed = JSON.parse(result.stdout); } catch { /* handled below */ }
    const errors = isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors : [];
    // GitHub can answer with partial data and errors (one search failing); gh then exits 1 but the data is usable.
    if (isRecord(parsed) && isRecord(parsed.data)) {
      if (!errors.length) return parsed.data;
      if (strict) {
        const failure = describeFailure({ ok: false, reason: 'failed', stdout: result.stdout, stderr: result.ok ? '' : result.stderr, exitCode: 1 });
        if (failure.code !== 'GH_FAILED') throw failure;
        fail('GitHub 只返回了部分 PR 数据，为安全起见没有合并：请稍后再试', 502, 'GH_PARTIAL_RESPONSE');
      }
      console.warn(`[studio] github: kept partial GraphQL data despite ${errors.length} error(s): ${redact(graphqlMessages(result.stdout))}`);
      return parsed.data;
    }
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

  // One `gh api` GET of a REST path built only from validated values; rejects with describeFailure's reason.
  async function restGet(path: string) {
    const result = await run(['api', path], { timeoutMs: READ_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
    if (!result.ok) throw describeFailure(result);
    try { return JSON.parse(result.stdout) as unknown; } catch { fail('GitHub 返回了无法识别的数据', 502, 'GH_BAD_RESPONSE'); }
  }

  /**
   * Actions runs on `headSha` that wait for approval: fork runs of a first-time contributor (status action_required,
   * approvable with write access) and runs held by environment protection rules, keeping only the environments the gh
   * account may approve. `strict` (an approval deciding on it) rejects when a lookup fails; otherwise a run whose
   * pending deployments cannot be read is skipped.
   */
  async function readRunApprovals(ref: PullRef, headSha: string, viewerCanMerge: boolean, strict: boolean): Promise<RunApproval[]> {
    const repoPath = `repos/${ref.owner}/${ref.repo}`;
    const listed = await restGet(`${repoPath}/actions/runs?head_sha=${headSha}&per_page=50`);
    const runs = isRecord(listed) && Array.isArray(listed.workflow_runs) ? listed.workflow_runs : [];
    const approvals: RunApproval[] = [];
    const waiting: Array<{ id: number; name: string }> = [];
    for (const item of runs) {
      if (!isRecord(item) || item.head_sha !== headSha) continue;
      const id = positiveId(item.id);
      if (!id) continue;
      const name = line(item.name, 120) || line(item.display_title, 120) || `运行 ${id}`;
      if (item.status === 'action_required' && viewerCanMerge) approvals.push({ id, name, kind: 'contributor', environments: [], environmentIds: [] });
      else if (item.status === 'waiting' && waiting.length < MAX_DEPLOYMENT_LOOKUPS) waiting.push({ id, name });
    }
    const deployments = await Promise.all(waiting.map(async ({ id, name }): Promise<RunApproval | null> => {
      let pending: unknown;
      try { pending = await restGet(`${repoPath}/actions/runs/${id}/pending_deployments`); } catch (error) { if (strict) throw error; return null; }
      const environments = (Array.isArray(pending) ? pending : []).flatMap(entry => {
        if (!isRecord(entry) || entry.current_user_can_approve !== true || !isRecord(entry.environment)) return [];
        const environmentId = positiveId(entry.environment.id);
        return environmentId ? [{ id: environmentId, name: line(entry.environment.name, 80) || `环境 ${environmentId}` }] : [];
      });
      return environments.length ? {
        id, name, kind: 'deployment', environments: environments.map(item => item.name), environmentIds: environments.map(item => item.id),
      } : null;
    }));
    return [...approvals, ...deployments.filter((item): item is RunApproval => item !== null)].sort((a, b) => a.id - b.id);
  }

  async function readDetail(ref: PullRef, strict: boolean): Promise<PullDetail> {
    const data = await graphql(DETAIL_QUERY, ['-f', `owner=${ref.owner}`, '-f', `repo=${ref.repo}`, '-F', `number=${ref.number}`], strict);
    const repository = isRecord(data.repository) ? data.repository : null;
    const node = repository && isRecord(repository.pullRequest) ? repository.pullRequest : null;
    if (!repository || !node) fail(`找不到 ${ref.owner}/${ref.repo} 的 #${ref.number}`, 404, 'GITHUB_NOT_FOUND');
    const summary = readPull(node, repository);
    if (!summary) fail('GitHub 返回了无法识别的 PR 数据', 502, 'GH_BAD_RESPONSE');
    const contexts = headContexts(node);
    // A check GitHub could not resolve arrives as null; the merge guard must see every check or none.
    if (strict && contexts && Array.isArray(contexts.nodes) && contexts.nodes.some(item => !isRecord(item))) {
      fail('GitHub 只返回了部分检查数据，为安全起见没有合并：请稍后再试', 502, 'GH_PARTIAL_RESPONSE');
    }
    const checkItems = readCheckItems(contexts);
    const passing = checkItems.filter(check => check.state === 'passing' || check.state === 'skipped').length;
    const failing = checkItems.filter(check => check.state === 'failing').length;
    const pending = checkItems.filter(check => check.state === 'pending').length;
    const files = isRecord(node.files) && Array.isArray(node.files.nodes) ? node.files.nodes : [];
    const { body, truncated } = excerpt(node.body);
    const mergeCommit = isRecord(node.mergeCommit) && typeof node.mergeCommit.oid === 'string' && SHA.test(node.mergeCommit.oid) ? node.mergeCommit.oid : null;
    const state = readEnum(node.state, ['open', 'closed', 'merged'] as const) ?? 'closed';
    const viewerCanMerge = typeof repository.viewerPermission === 'string' && WRITE_PERMISSIONS.has(repository.viewerPermission);
    // Fail-soft: runs waiting for approval are an extra, so a failed Actions read only means none are offered.
    const pendingRuns = state !== 'open' ? [] : await readRunApprovals(ref, summary.headSha, viewerCanMerge, false)
      .then(items => items.map(({ id, name, kind, environments }) => ({ id, name, kind, environments })))
      .catch(() => []);
    const withoutBlockers: Omit<PullDetail, 'blockers'> = {
      ...summary,
      // The detail lists every check, so its summary is counted from the list rather than the inbox's counters.
      checks: summarizeCounts(passing, failing, pending),
      reasons: [],
      state,
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
      viewerCanMerge,
      mergeQueue: node.isMergeQueueEnabled === true,
      mergeCommitSha: mergeCommit,
      pendingRuns,
    };
    return { ...withoutBlockers, blockers: blockersOf(withoutBlockers).map(({ code, message }) => ({ code, message })) };
  }

  // A merge whose outcome timed out is settled by the next read that finds the pull request merged at the same head.
  function settleUnknownMerges(ref: PullRef, detail: PullDetail) {
    if (detail.state !== 'merged') return;
    try {
      database.prepare(`UPDATE studio_github_merges SET outcome = 'merged', code = NULL, message = ?, finished_at = ?
        WHERE outcome = 'unknown' AND lower(owner) = ? AND lower(repo) = ? AND number = ? AND head_sha = ?`)
        .run(`GitHub 确认 #${ref.number} 已合并`, iso(), ref.owner.toLowerCase(), ref.repo.toLowerCase(), ref.number, detail.headSha);
    } catch (error) {
      console.error('[studio] github merge audit update failed:', error instanceof Error ? error.message : error);
    }
  }

  // `strict` is the read a merge decides on: it never reuses a cached copy or joins a read already running (which may
  // have started before a merge), and it rejects partial GraphQL data.
  function getDetail(ref: PullRef, { force = false, strict = false }: { force?: boolean; strict?: boolean } = {}) {
    const key = refKey(ref);
    const hit = details.get(key);
    if (!strict && fresh(hit, force)) return Promise.resolve(hit!.value);
    const running = detailRequests.get(key);
    if (running && !strict) return running;
    const generation = cacheGeneration;
    const request: Promise<PullDetail> = readDetail(ref, strict).then(value => {
      settleUnknownMerges(ref, value);
      if (generation === cacheGeneration) {
        details.delete(key);
        details.set(key, { at: now(), value });
        // Oldest entries go first once the cache is full (Map keeps insertion order).
        while (details.size > MAX_DETAIL_CACHE) details.delete(details.keys().next().value as string);
      }
      return value;
    }).finally(() => { if (detailRequests.get(key) === request) detailRequests.delete(key); });
    detailRequests.set(key, request);
    return request;
  }

  // The inbox without pull requests merged through Studio a moment ago, which GitHub's search may still list as open.
  function withoutRecentlyMerged(value: Inbox): Inbox {
    for (const [key, at] of recentlyMerged) if (now() - at >= MERGED_HIDE_MS) recentlyMerged.delete(key);
    if (!recentlyMerged.size) return value;
    const pulls = value.pulls.filter(pull => !recentlyMerged.has(pull.id.toLowerCase()));
    return pulls.length === value.pulls.length ? value : { ...value, pulls };
  }

  // Every merge attempt that reached gh changes the pull request, and maybe the inbox. Reads already running were
  // started before it, so they lose the right to fill a cache and new callers no longer join them. After a merge
  // GitHub finished, the inbox cache is kept but the pull request is hidden from it (and from fresh searches) at once;
  // otherwise the inbox is read again.
  function invalidate(ref: PullRef, merged: boolean) {
    const key = refKey(ref);
    cacheGeneration += 1;
    details.delete(key);
    detailRequests.delete(key);
    inboxRequest = null;
    if (merged) recentlyMerged.set(key, now());
    else inbox = null;
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

  // Runs one gh command of a one-tap fix. Whatever happened, the pull request changed or may have: the caches go.
  async function runFix(ref: PullRef, args: string[]) {
    const result = await run(args, { timeoutMs: ACTION_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    invalidate(ref, false);
    if (result.ok) return;
    if (result.reason === 'timeout') {
      throw new AppError('GitHub 响应超时：操作可能已经生效，请刷新确认', { statusCode: 504, code: 'ACTION_OUTCOME_UNKNOWN' });
    }
    throw describeActionFailure(result);
  }

  /**
   * One audited one-tap fix: an audit row first (nothing runs without one), one fix at a time per pull request and
   * never during a merge, a fresh strict read of the pull request that `steps` decides on (it may refuse through
   * `refuse`), then gh. Afterwards the caches are dropped and the pull request is read again for the sheet.
   */
  async function performAction(userId: number, ref: PullRef, action: PullAction, subject: string,
    steps: (detail: PullDetail, refuse: (refusal: Refusal) => never) => Promise<string>) {
    const key = refKey(ref);
    let recordId: number;
    try {
      recordId = Number(database.prepare(`INSERT INTO studio_github_actions (user_id, owner, repo, number, action, subject, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(userId, ref.owner, ref.repo, ref.number, action, subject, iso()).lastInsertRowid);
    } catch (error) {
      console.error('[studio] github action audit insert failed:', error instanceof Error ? error.message : error);
      throw new AppError('无法写入操作记录，已取消', { statusCode: 500, code: 'AUDIT_FAILED' });
    }
    let finished = false;
    const close = (outcome: Exclude<ActionOutcome, 'pending' | 'invalid'>, code: string | null, message: string) => {
      finished = true;
      try {
        database.prepare('UPDATE studio_github_actions SET outcome = ?, code = ?, message = ?, finished_at = ? WHERE id = ?').run(outcome, code, message, iso(), recordId);
      } catch (error) {
        console.error('[studio] github action audit update failed:', error instanceof Error ? error.message : error);
      }
    };
    const refuse = (refusal: Refusal): never => {
      close('refused', refusal.code, refusal.message);
      throw new AppError(refusal.message, { statusCode: refusal.status, code: refusal.code });
    };
    if (merging.has(key) || acting.has(key)) refuse({ code: 'ACTION_IN_PROGRESS', message: '这个 PR 上有操作正在进行，请稍候', status: 409 });
    acting.add(key);
    try {
      const detail = await getDetail(ref, { strict: true });
      if (detail.state !== 'open') refuse({ code: 'PR_NOT_OPEN', message: detail.state === 'merged' ? '这个 PR 已经合并' : '这个 PR 已关闭', status: 409 });
      const message = await steps(detail, refuse);
      close('done', null, message);
      // GitHub may take a moment to recompute; the sheet gets what it says now and re-reads on its own later.
      const pull = await getDetail(ref, { force: true }).catch(() => null);
      return { message, pull };
    } catch (error) {
      if (!finished) {
        const failure = error instanceof AppError ? error : null;
        close(failure?.code === 'ACTION_OUTCOME_UNKNOWN' ? 'unknown' : 'failed', failure?.code ?? 'INTERNAL_ERROR', failure?.message ?? '操作失败');
      }
      throw error;
    } finally {
      acting.delete(key);
    }
  }

  return {
    status(force = false) {
      return getStatus(force);
    },

    async pulls(force = false) {
      if (fresh(inbox, force)) return withoutRecentlyMerged(inbox!.value);
      if (!inboxRequest) {
        const generation = cacheGeneration;
        const request: Promise<Inbox> = readInbox().then(value => {
          // A search that started before a merge would put the merged pull request back for the whole TTL.
          if (generation === cacheGeneration) inbox = { at: now(), value };
          return value;
        }).finally(() => { if (inboxRequest === request) inboxRequest = null; });
        inboxRequest = request;
      }
      return withoutRecentlyMerged(await inboxRequest);
    },

    pull(ref: PullRef, force = false) {
      return getDetail(ref, { force });
    },

    /**
     * The number of the open pull request from `branch` of owner/repo itself (a fork's branch of the same name does not
     * count), or null. Used by github-branch.service for a workbench project's current branch.
     */
    async openPullForBranch(owner: string, repo: string, branch: string): Promise<number | null> {
      if (!isGitHubRepository(owner, repo)) fail('仓库格式无效', 400, 'INVALID_REPO');
      if (!BRANCH.test(branch)) fail('分支名格式无效', 400, 'INVALID_BRANCH');
      const result = await run(['pr', 'list', '--repo', `${owner}/${repo}`, `--head=${branch}`, '--state', 'open', '--json', 'number,isCrossRepository', '--limit', '5'],
        { timeoutMs: READ_TIMEOUT_MS, maxBuffer: 256 * 1024 });
      if (!result.ok) throw describeFailure(result);
      let parsed: unknown = null;
      try { parsed = JSON.parse(result.stdout); } catch { fail('gh pr list 返回了无法识别的数据', 502, 'GH_BAD_RESPONSE'); }
      const own = (Array.isArray(parsed) ? parsed : []).find(item => isRecord(item) && item.isCrossRepository !== true && positiveId(item.number) && Number(item.number) <= MAX_NUMBER);
      return own ? positiveId((own as Record<string, unknown>).number) : null;
    },

    async merge(userId: number, ref: PullRef, request: MergeRequest) {
      const key = refKey(ref);
      let recordId: number;
      try {
        recordId = record(userId, ref, request);
      } catch (error) {
        // Nothing is merged without an audit row.
        console.error('[studio] github merge audit insert failed:', error instanceof Error ? error.message : error);
        throw new AppError('无法写入合并记录，已取消合并', { statusCode: 500, code: 'AUDIT_FAILED' });
      }
      if (merging.has(key)) {
        const message = '这个 PR 正在合并，请稍候';
        finish(recordId, 'refused', 'MERGE_IN_PROGRESS', message);
        fail(message, 409, 'MERGE_IN_PROGRESS');
      }
      if (acting.has(key)) {
        const message = '这个 PR 上有操作正在进行，请稍候';
        finish(recordId, 'refused', 'ACTION_IN_PROGRESS', message);
        fail(message, 409, 'ACTION_IN_PROGRESS');
      }
      merging.add(key);
      let finished = false;
      const close = (outcome: Exclude<MergeOutcome, 'pending'>, code: string | null, message: string) => { finished = true; finish(recordId, outcome, code, message); };
      try {
        // Always a fresh, strict read: the decision is made on what GitHub says now, not on what the sheet showed.
        const detail = await getDetail(ref, { strict: true });
        const refused = refusalFor(detail, request);
        if (refused) {
          close('refused', refused.code, refused.message);
          throw new AppError(refused.message, { statusCode: refused.status, code: refused.code });
        }
        const args = ['pr', 'merge', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`, `--${request.method}`, '--match-head-commit', request.expectedHeadSha];
        // GitHub already deletes the branch when the repository auto-deletes, Studio cannot delete a fork's branch,
        // and gh refuses --delete-branch with a merge queue; the flag is only sent when it changes something.
        const deleteBranch = request.deleteBranch && !detail.deleteBranchOnMerge && !detail.isCrossRepository && !detail.mergeQueue;
        if (deleteBranch) args.push('--delete-branch');
        else if (request.deleteBranch) database.prepare('UPDATE studio_github_merges SET delete_branch = 0 WHERE id = ?').run(recordId);
        const result = await run(args, { timeoutMs: MERGE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        if (!result.ok) {
          invalidate(ref, false);
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
        let outcome: 'merged' | 'queued' = detail.mergeQueue ? 'queued' : 'merged';
        let mergeCommitSha: string | null = null;
        invalidate(ref, outcome === 'merged');
        try {
          const after = await getDetail(ref, { strict: true });
          if (after.state === 'merged') { outcome = 'merged'; mergeCommitSha = after.mergeCommitSha; }
          else if (after.state === 'open') outcome = 'queued';
        } catch { /* The merge itself succeeded; only the confirmation read failed. */ }
        if (outcome === 'merged') recentlyMerged.set(key, now());
        else recentlyMerged.delete(key);
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

    /**
     * A merge request the router rejected after the PR address parsed (bad method, SHA or flags), so the audit log
     * holds every attempt. Never throws: the request is refused either way.
     */
    recordInvalidMerge(userId: number, ref: PullRef, error: unknown) {
      const failure = error instanceof AppError ? error : null;
      try {
        database.prepare(`INSERT INTO studio_github_merges
          (user_id, owner, repo, number, method, head_sha, delete_branch, outcome, code, message, created_at, finished_at)
          VALUES (?, ?, ?, ?, '', '', 0, 'invalid', ?, ?, ?, ?)`)
          .run(userId, ref.owner, ref.repo, ref.number, failure?.code ?? 'INVALID_BODY', failure?.message ?? '请求格式无效', iso(), iso());
      } catch (insertError) {
        console.error('[studio] github merge audit insert failed:', insertError instanceof Error ? insertError.message : insertError);
      }
    },

    /**
     * 更新分支: merges the base branch into the head branch through GitHub's update-branch API, which itself refuses
     * when the head is no longer `expectedHeadSha`. Only offered (and accepted) while GitHub reports the branch BEHIND.
     */
    updateBranch(userId: number, ref: PullRef, request: UpdateBranchRequest) {
      return performAction(userId, ref, 'update-branch', request.expectedHeadSha, async (detail, refuse) => {
        if (detail.headSha !== request.expectedHeadSha) {
          refuse({ code: 'HEAD_MOVED', message: `PR 有了新提交（现在是 ${shortSha(detail.headSha)}）：请重新查看后再更新`, status: 409 });
        }
        if (detail.mergeState !== 'behind') refuse({ code: 'NOT_BEHIND', message: '这个 PR 现在不需要更新分支：请刷新后再看', status: 409 });
        await runFix(ref, ['api', '-X', 'PUT', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/update-branch`, '-f', `expected_head_sha=${request.expectedHeadSha}`]);
        return `已把 ${detail.baseRef} 的最新提交合并进 ${detail.headRef}，检查会重新运行`;
      });
    },

    /** 标记为可审查: gh pr ready on a draft pull request. */
    markReady(userId: number, ref: PullRef) {
      return performAction(userId, ref, 'ready', '', async (detail, refuse) => {
        if (!detail.isDraft) refuse({ code: 'NOT_DRAFT', message: '这个 PR 已经是可审查状态', status: 409 });
        await runFix(ref, ['pr', 'ready', String(ref.number), '--repo', `${ref.owner}/${ref.repo}`]);
        return `#${ref.number} 已标记为可审查`;
      });
    },

    /**
     * 批准运行: approves the requested Actions runs on the head commit. Every id must be one that a fresh read lists as
     * waiting for this gh account (a contributor's fork run, or environments it may approve); otherwise nothing runs.
     * Runs are approved one by one; a failure after some succeeded says which ones went through.
     */
    approveRuns(userId: number, ref: PullRef, request: ApproveRunsRequest) {
      return performAction(userId, ref, 'approve-runs', request.runIds.join(','), async (detail, refuse) => {
        const approvals = await readRunApprovals(ref, detail.headSha, detail.viewerCanMerge, true);
        const byId = new Map(approvals.map(item => [item.id, item]));
        const selected = request.runIds.map(id => byId.get(id));
        if (selected.some(item => !item)) {
          refuse({ code: 'RUN_NOT_PENDING', message: '有运行已经不需要批准，或当前 gh 账号无权批准：请刷新后再看', status: 409 });
        }
        const approved: string[] = [];
        for (const item of selected as RunApproval[]) {
          const path = `repos/${ref.owner}/${ref.repo}/actions/runs/${item.id}`;
          const args = item.kind === 'contributor' ? ['api', '-X', 'POST', `${path}/approve`]
            : ['api', '-X', 'POST', `${path}/pending_deployments`, ...item.environmentIds.flatMap(id => ['-F', `environment_ids[]=${id}`]),
              '-f', 'state=approved', '-f', `comment=${APPROVAL_COMMENT}`];
          try {
            await runFix(ref, args);
          } catch (error) {
            if (!approved.length || !(error instanceof AppError)) throw error;
            throw new AppError(`已批准「${approved.join('、')}」，「${item.name}」没有批准：${error.message}`, { statusCode: error.statusCode, code: error.code });
          }
          approved.push(item.name);
        }
        return approved.length === 1 ? `已批准运行「${approved[0]}」` : `已批准 ${approved.length} 个运行`;
      });
    },

    /**
     * A one-tap fix the router rejected after the PR address parsed (bad SHA or run ids), so studio_github_actions
     * holds every attempt. Never throws: the request is refused either way.
     */
    recordInvalidAction(userId: number, ref: PullRef, action: PullAction, error: unknown) {
      const failure = error instanceof AppError ? error : null;
      try {
        database.prepare(`INSERT INTO studio_github_actions (user_id, owner, repo, number, action, subject, outcome, code, message, created_at, finished_at)
          VALUES (?, ?, ?, ?, ?, '', 'invalid', ?, ?, ?, ?)`)
          .run(userId, ref.owner, ref.repo, ref.number, action, failure?.code ?? 'INVALID_BODY', failure?.message ?? '请求格式无效', iso(), iso());
      } catch (insertError) {
        console.error('[studio] github action audit insert failed:', insertError instanceof Error ? insertError.message : insertError);
      }
    },

    // The signed-in Studio user's most recent merge attempts, newest first.
    merges(userId: number, limit = 20) {
      const rows = database.prepare('SELECT * FROM studio_github_merges WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as MergeRow[];
      return rows.map(row => ({
        id: row.id, owner: row.owner, repo: row.repo, number: row.number, method: row.method || null, headSha: row.head_sha,
        deleteBranch: row.delete_branch === 1, outcome: row.outcome, code: row.code, message: row.message,
        createdAt: row.created_at, finishedAt: row.finished_at,
      }));
    },
  };
}
