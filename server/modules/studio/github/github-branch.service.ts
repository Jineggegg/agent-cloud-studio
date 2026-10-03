import { AppError } from '@/shared/utils.js';

import { isGitHubRepository } from './github.service.js';
import type { createGitHubService } from './github.service.js';

type GitHubService = Pick<ReturnType<typeof createGitHubService>, 'status' | 'pull' | 'openPullForBranch'>;
type PullDetail = Awaited<ReturnType<GitHubService['pull']>>;
// The current branch and `origin` URL of a directory, null where git has no answer (see git-local.adapter).
type LocalRepo = { branch: string | null; remoteUrl: string | null };
// Which pull request a project's branch has, as the short cache keeps it; null when it has none.
type BranchLookup = { owner: string; repo: string; branch: string; number: number } | null;
type CacheEntry = { at: number; value: BranchLookup };

type GitHubBranchServiceDeps = {
  github: GitHubService;
  // The directory of a non-archived IDE project, or null when there is no such project.
  projectDirectory: (projectId: string) => string | null;
  readLocalRepo: (directory: string) => Promise<LocalRepo>;
  now?: () => number;
};

const CACHE_TTL_MS = 30_000;
// A forced refresh within this long of the last lookup reuses it, so a burst of focus events cannot hammer gh.
const FORCE_MIN_INTERVAL_MS = 5_000;
const MAX_CACHE = 64;
// IDE project ids are UUIDs; older installs may hold other simple ids.
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// github.com remotes only: https (optionally with credentials, which are never echoed), scp-style and ssh:// URLs.
const REMOTE_PATTERNS = [
  /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
];

// owner/repo of a github.com remote URL, validated like a PR address; null for any other host or shape.
function parseGitHubRemote(url: string) {
  for (const pattern of REMOTE_PATTERNS) {
    const match = pattern.exec(url.trim());
    if (match && isGitHubRepository(match[1], match[2])) return { owner: match[1], repo: match[2] };
  }
  return null;
}

/** Used by github.routes to validate the ?projectId= of GET /branch-pr (an IDE project id). */
export function parseWorkbenchProjectId(value: unknown) {
  if (typeof value !== 'string' || !PROJECT_ID.test(value)) throw new AppError('项目编号无效', { statusCode: 400, code: 'INVALID_PROJECT' });
  return value;
}

/**
 * Used by studio.module behind GET /api/studio/github/branch-pr: the open pull request of a workbench project's
 * current branch, for the chip in the workbench chat header. It reads the project's branch and `origin` with git (no
 * shell), accepts only github.com remotes, and asks gh for an open PR from that branch of that repository itself.
 * Answers null when there is none, the project is not a GitHub checkout, or gh is missing or signed out. The branch
 * lookup is cached for 30 s per project (single-flight); the pull request itself comes from the GitHub service's
 * detail cache, so the chip and the PR sheet agree.
 */
export function createGitHubBranchService({ github, projectDirectory, readLocalRepo, now = Date.now }: GitHubBranchServiceDeps) {
  const cache = new Map<string, CacheEntry>();
  const running = new Map<string, Promise<BranchLookup>>();

  async function lookup(directory: string): Promise<BranchLookup> {
    const local = await readLocalRepo(directory);
    if (!local.branch || !local.remoteUrl) return null;
    const repository = parseGitHubRemote(local.remoteUrl);
    if (!repository) return null;
    const account = await github.status();
    if (!account.installed || !account.authenticated) return null;
    // Branch names gh cannot be given safely (or git allows but GitHub never shows) simply have no PR here.
    let number: number | null = null;
    try {
      number = await github.openPullForBranch(repository.owner, repository.repo, local.branch);
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_BRANCH') return null;
      throw error;
    }
    return number ? { ...repository, branch: local.branch, number } : null;
  }

  function cachedLookup(projectId: string, directory: string, force: boolean) {
    const hit = cache.get(projectId);
    if (hit && now() - hit.at < (force ? FORCE_MIN_INTERVAL_MS : CACHE_TTL_MS)) return Promise.resolve(hit.value);
    const pending = running.get(projectId);
    if (pending) return pending;
    const request = lookup(directory).then(value => {
      cache.delete(projectId);
      cache.set(projectId, { at: now(), value });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
      return value;
    }).finally(() => { if (running.get(projectId) === request) running.delete(projectId); });
    running.set(projectId, request);
    return request;
  }

  // The fields the chip shows, plus what the sheet needs to open: the summary, blockers and runs waiting for approval.
  function summarize(detail: PullDetail) {
    const {
      id, owner, repo, number, title, author, url, isDraft, headRef, baseRef, headSha, additions, deletions, changedFiles,
      mergeable, mergeState, reviewDecision, checks, updatedAt, reasons, blockers, pendingRuns,
    } = detail;
    return {
      id, owner, repo, number, title, author, url, isDraft, headRef, baseRef, headSha, additions, deletions, changedFiles,
      mergeable, mergeState, reviewDecision, checks, updatedAt, reasons, blockers, pendingRuns,
    };
  }

  return {
    async branchPull(projectId: string, force = false) {
      const directory = projectDirectory(projectId);
      if (!directory) throw new AppError('找不到这个项目', { statusCode: 404, code: 'PROJECT_NOT_FOUND' });
      const found = await cachedLookup(projectId, directory, force);
      if (!found) return null;
      const [account, detail] = await Promise.all([
        github.status(),
        github.pull({ owner: found.owner, repo: found.repo, number: found.number }, force),
      ]);
      // A PR merged or closed since the lookup: none until the next lookup finds another.
      if (detail.state !== 'open') return null;
      return { branch: found.branch, canMerge: account.canMerge, pull: summarize(detail) };
    },
  };
}
