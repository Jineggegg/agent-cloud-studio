import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  github: { branchPull: vi.fn(), pull: vi.fn(), merge: vi.fn(), updateBranch: vi.fn(), markReady: vi.fn(), approveRuns: vi.fn() },
}));
vi.mock('@/shared/api', () => ({
  api: { studio: { github: mocks.github } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error.message), { code: value.error.code });
    return value;
  },
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { WorkbenchPullChip } from '@/modules/workbench/WorkbenchPullChip';
import type { StudioGitHubBranchPull, StudioGitHubPullDetail } from '@/shared/types';

const HEAD = '6a86614f929c0d67be9d4124b066832715d7d698';
const json = (value: unknown, status = 200) => () => Promise.resolve(Response.json(value, { status }));

function branchPull(overrides: Partial<StudioGitHubBranchPull['pull']> = {}): StudioGitHubBranchPull {
  return {
    branch: 'feat/chip', canMerge: true,
    pull: {
      id: 'Jineggegg/agent-cloud-studio#12', owner: 'Jineggegg', repo: 'agent-cloud-studio', number: 12, title: 'PR chip', author: 'Jineggegg',
      url: 'https://github.com/Jineggegg/agent-cloud-studio/pull/12', isDraft: false, headRef: 'feat/chip', baseRef: 'main', headSha: HEAD,
      additions: 10, deletions: 2, changedFiles: 3, mergeable: 'mergeable', mergeState: 'clean', reviewDecision: null,
      checks: { state: 'passing', passing: 2, failing: 0, pending: 0, total: 2 }, updatedAt: '2026-10-02T12:00:00Z', reasons: [],
      blockers: [], pendingRuns: [], ...overrides,
    },
  };
}

function detail(): StudioGitHubPullDetail {
  const { blockers, pendingRuns, ...summary } = branchPull().pull;
  return {
    ...summary, state: 'open', body: '', bodyTruncated: false, createdAt: '2026-10-02T10:00:00Z', checkItems: [], checksTruncated: false,
    files: [], filesTotal: 0, mergeMethods: ['squash'], deleteBranchOnMerge: false, isCrossRepository: false, viewerCanMerge: true,
    mergeQueue: false, blockers, mergeCommitSha: null, pendingRuns,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.github.pull.mockImplementation(json(detail()));
});
afterEach(cleanup);

test('the chip names the branch PR and its state, and opens the PR sheet on tap', async () => {
  mocks.github.branchPull.mockImplementation(json(branchPull()));
  render(<WorkbenchPullChip projectId="p1" running={false} />);
  const chip = await screen.findByRole('button', { name: 'PR #12：可合并，打开 PR' });
  expect(chip.textContent).toContain('PR #12');
  expect(mocks.github.branchPull).toHaveBeenCalledWith('p1', false);
  fireEvent.click(chip);
  const sheet = await screen.findByRole('dialog');
  expect(await within(sheet).findByRole('button', { name: '合并…' })).toBeTruthy();
  expect(mocks.github.pull).toHaveBeenCalledWith('Jineggegg', 'agent-cloud-studio', 12, false);
});

test('the chip says what blocks the PR, worst news first', async () => {
  const cases: Array<[Partial<StudioGitHubBranchPull['pull']>, string]> = [
    [{ mergeState: 'behind', blockers: [{ code: 'HEAD_BEHIND', message: '' }] }, '需更新分支'],
    [{ checks: { state: 'pending', passing: 1, failing: 0, pending: 1, total: 2 } }, '检查运行中'],
    [{ checks: { state: 'failing', passing: 1, failing: 1, pending: 0, total: 2 } }, '检查未通过'],
    [{ isDraft: true, blockers: [{ code: 'PR_DRAFT', message: '' }] }, '草稿'],
    [{ mergeable: 'conflicting', blockers: [{ code: 'MERGE_CONFLICT', message: '' }] }, '有冲突'],
    [{ pendingRuns: [{ id: 1, name: 'CI', kind: 'contributor', environments: [] }] }, '运行待批准'],
  ];
  for (const [overrides, label] of cases) {
    mocks.github.branchPull.mockImplementation(json(branchPull(overrides)));
    render(<WorkbenchPullChip projectId="p1" running={false} />);
    expect(await screen.findByRole('button', { name: `PR #12：${label}，打开 PR` })).toBeTruthy();
    cleanup();
  }
});

test('no PR, a signed-out gh or a failed first read show nothing', async () => {
  mocks.github.branchPull.mockImplementation(json(null));
  const { container } = render(<WorkbenchPullChip projectId="p1" running={false} />);
  await waitFor(() => expect(mocks.github.branchPull).toHaveBeenCalled());
  expect(container.textContent).toBe('');
  cleanup();
  mocks.github.branchPull.mockImplementation(json({ error: { code: 'PROJECT_NOT_FOUND', message: '找不到这个项目' } }, 404));
  const failed = render(<WorkbenchPullChip projectId="p1" running={false} />);
  await waitFor(() => expect(mocks.github.branchPull).toHaveBeenCalledTimes(2));
  expect(failed.container.textContent).toBe('');
});

test('the chip reads past the cache when a run ends, on focus, and every minute while visible', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    mocks.github.branchPull.mockImplementation(json(null));
    const { rerender } = render(<WorkbenchPullChip projectId="p1" running />);
    await waitFor(() => expect(mocks.github.branchPull).toHaveBeenCalledTimes(1));
    // The agent pushed and opened the PR during the run.
    mocks.github.branchPull.mockImplementation(json(branchPull({ checks: { state: 'pending', passing: 0, failing: 0, pending: 2, total: 2 } })));
    rerender(<WorkbenchPullChip projectId="p1" running={false} />);
    expect(await screen.findByRole('button', { name: 'PR #12：检查运行中，打开 PR' })).toBeTruthy();
    expect(mocks.github.branchPull).toHaveBeenLastCalledWith('p1', true);

    mocks.github.branchPull.mockImplementation(json(branchPull()));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByRole('button', { name: 'PR #12：可合并，打开 PR' })).toBeTruthy();
    expect(mocks.github.branchPull).toHaveBeenLastCalledWith('p1', false);
    const before = mocks.github.branchPull.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await waitFor(() => expect(mocks.github.branchPull.mock.calls.length).toBe(before + 1));
  } finally {
    vi.useRealTimers();
  }
});
