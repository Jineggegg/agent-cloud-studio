import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  github: { status: vi.fn(), pulls: vi.fn(), pull: vi.fn(), merge: vi.fn(), merges: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/shared/api', () => ({
  api: { studio: { github: mocks.github } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error.message), { code: value.error.code });
    return value;
  },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import { StudioGitHub } from '@/modules/studio/StudioGitHub';
import { StudioWidgets } from '@/modules/studio/StudioWidgets';
import type { StudioGitHubInbox, StudioGitHubPull, StudioGitHubPullDetail, StudioGitHubStatus } from '@/shared/types';

const HEAD = '6a86614f929c0d67be9d4124b066832715d7d698';
const STATUS: StudioGitHubStatus = { installed: true, authenticated: true, login: 'Jineggegg', scopes: ['repo'], canMerge: true, message: null, checkedAt: '2026-10-02T12:00:00Z' };
const recent = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function pull(overrides: Partial<StudioGitHubPull> = {}): StudioGitHubPull {
  const base: StudioGitHubPull = {
    id: 'Jineggegg/agent-cloud-studio#42', owner: 'Jineggegg', repo: 'agent-cloud-studio', number: 42, title: 'GitHub PR inbox',
    author: 'Jineggegg', url: 'https://github.com/Jineggegg/agent-cloud-studio/pull/42', isDraft: false, headRef: 'wip6/github', baseRef: 'main',
    headSha: HEAD, additions: 1840, deletions: 96, changedFiles: 14, mergeable: 'mergeable', mergeState: 'clean', reviewDecision: 'approved',
    checks: { state: 'passing', passing: 6, failing: 0, pending: 0, total: 6 }, updatedAt: recent(1), reasons: ['authored', 'owned'],
  };
  return { ...base, ...overrides };
}

const INBOX: StudioGitHubInbox = {
  login: 'Jineggegg', fetchedAt: '2026-10-02T12:00:00Z', truncated: false,
  pulls: [
    pull(),
    pull({ id: 'siteboon/claudecodeui#512', owner: 'siteboon', repo: 'claudecodeui', number: 512, title: 'Session export', reviewDecision: 'review_required', reasons: ['review'], updatedAt: recent(2),
      checks: { state: 'failing', passing: 3, failing: 2, pending: 0, total: 5 } }),
    pull({ id: 'Jineggegg/agent-cloud-studio#39', number: 39, title: 'Keyboard fix', isDraft: true, reviewDecision: null, updatedAt: recent(3), checks: { state: 'none', passing: 0, failing: 0, pending: 0, total: 0 } }),
  ],
};

function detail(overrides: Partial<StudioGitHubPullDetail> = {}): StudioGitHubPullDetail {
  return {
    ...pull(), state: 'open', body: 'Adds the inbox.', bodyTruncated: false, createdAt: recent(5),
    checkItems: [{ name: 'Unit tests', workflow: 'CI', state: 'passing', required: true, url: 'https://github.com/x/actions' }],
    checksTruncated: false, files: [{ path: 'src/modules/studio/StudioGitHub.tsx', additions: 400, deletions: 0, change: 'added' }], filesTotal: 1,
    mergeMethods: ['squash', 'merge'], deleteBranchOnMerge: false, isCrossRepository: false, viewerCanMerge: true, blockers: [], mergeCommitSha: null,
    ...overrides,
  };
}

const json = (value: unknown, status = 200) => () => Promise.resolve(Response.json(value, { status }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.github.status.mockImplementation(json(STATUS));
  mocks.github.pulls.mockImplementation(json(INBOX));
  mocks.github.merges.mockImplementation(json([]));
  mocks.github.pull.mockImplementation(json(detail()));
});
afterEach(cleanup);

async function openPull(title: string) {
  render(<StudioGitHub />);
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(title) }));
  return screen.findByRole('dialog');
}

test('the inbox groups open PRs by repository with CI, review, diff and draft marks, and filters review requests', async () => {
  render(<StudioGitHub />);
  expect(await screen.findByRole('heading', { name: /^Jineggegg\/\s?agent-cloud-studio$/ })).toBeTruthy();
  expect(screen.getByRole('heading', { name: /^siteboon\/\s?claudecodeui$/ })).toBeTruthy();
  expect(screen.getByRole('img', { name: 'CI：2 项失败，0 项运行中，3 项通过' })).toBeTruthy();
  expect(screen.getByText('2 项失败')).toBeTruthy();
  expect(screen.getByText('已批准')).toBeTruthy();
  expect(screen.getByText('待审查')).toBeTruthy();
  expect(screen.getByText('草稿')).toBeTruthy();
  expect(screen.getAllByText('+1,840')).toHaveLength(3);
  expect(screen.getAllByLabelText('新增 1840 行，删除 96 行', { selector: '.gh-diff' })).toHaveLength(3);
  expect(document.querySelector('.gh-account-name')?.textContent).toBe('Jineggegg');

  fireEvent.click(screen.getByRole('radio', { name: /待审/ }));
  expect(screen.queryByRole('heading', { name: /^Jineggegg\/\s?agent-cloud-studio$/ })).toBeNull();
  expect(screen.getByText('Session export')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: /我发起/ }));
  expect(screen.queryByText('Session export')).toBeNull();
  expect(localStorage.getItem('studio-github-filter-v1')).toBe('authored');
});

test('a signed-out gh shows how to sign in instead of an error, and re-checks on demand', async () => {
  mocks.github.status.mockImplementation(json({ ...STATUS, authenticated: false, login: null, message: 'gh 还没有登录 GitHub：请在服务器上运行 gh auth login' }));
  mocks.github.pulls.mockImplementation(json({ error: { code: 'GH_NOT_AUTHENTICATED', message: 'gh 未登录' } }, 409));
  render(<StudioGitHub />);
  expect(await screen.findByText('让 gh 登录 GitHub')).toBeTruthy();
  expect(screen.getByText('gh auth login')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
  await waitFor(() => expect(mocks.github.status).toHaveBeenLastCalledWith(true));
});

test('a failed load stays visible with a retry, and the navigation bar refresh reloads past the cache', async () => {
  mocks.github.pulls.mockImplementation(json({ error: { code: 'GH_OFFLINE', message: '服务器连不上 GitHub，请检查网络' } }, 502));
  const { rerender } = render(<StudioGitHub refreshing={false} />);
  expect(await screen.findByText('服务器连不上 GitHub，请检查网络')).toBeTruthy();
  mocks.github.pulls.mockImplementation(json(INBOX));
  rerender(<StudioGitHub refreshing />);
  await waitFor(() => expect(mocks.github.pulls).toHaveBeenLastCalledWith(true));
  expect(await screen.findByText('Session export')).toBeTruthy();
  expect(screen.queryByText('服务器连不上 GitHub，请检查网络')).toBeNull();
});

test('merging walks through method, a destructive confirmation with repo, PR and short SHA, then a toast and a refresh', async () => {
  mocks.github.merge.mockImplementation(json({ outcome: 'merged', mergeCommitSha: 'f'.repeat(40), message: '已压缩合并 #42 到 main' }));
  const sheet = await openPull('GitHub PR inbox');
  expect(await within(sheet).findByText('Unit tests')).toBeTruthy();
  expect(within(sheet).getByText('必需')).toBeTruthy();
  expect(within(sheet).getByText('StudioGitHub.tsx')).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('button', { name: '合并…' }));

  const methods = await within(sheet).findByRole('radiogroup', { name: '方式' });
  expect(within(methods).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['压缩合并', '合并提交']);
  fireEvent.click(within(methods).getByRole('radio', { name: '合并提交' }));
  fireEvent.click(within(methods).getByRole('radio', { name: '压缩合并' }));
  fireEvent.click(within(sheet).getByRole('switch', { name: /合并后删除/ }));
  fireEvent.click(within(sheet).getByRole('button', { name: '合并 #42' }));

  const alert = await screen.findByRole('alertdialog', { name: '合并 #42 到 main？' });
  expect(alert.textContent).toContain('Jineggegg/agent-cloud-studio');
  expect(alert.textContent).toContain('6a86614');
  expect(alert.textContent).toContain('压缩合并');
  expect(alert.textContent).toContain('合并后删除 wip6/github');
  fireEvent.click(within(alert).getByRole('button', { name: '合并' }));

  await waitFor(() => expect(mocks.github.merge).toHaveBeenCalledWith('Jineggegg', 'agent-cloud-studio', 42, {
    method: 'squash', expectedHeadSha: HEAD, deleteBranch: true, acknowledgeFailing: false,
  }));
  expect(await within(sheet).findByText('#42 已合并')).toBeTruthy();
  expect(within(sheet).getByText('fffffff')).toBeTruthy();
  expect(mocks.toast.success).toHaveBeenCalledWith('已合并 #42');
  await waitFor(() => expect(mocks.github.pulls).toHaveBeenLastCalledWith(true));
  expect(JSON.parse(localStorage.getItem('studio-github-merge-method-v1') ?? '{}')).toEqual({ 'jineggegg/agent-cloud-studio': 'squash' });
});

test('a refused merge keeps its error in the sheet and offers to reload a moved PR', async () => {
  mocks.github.merge.mockImplementation(json({ error: { code: 'HEAD_MOVED', message: 'PR 有了新提交（现在是 1111111）：请重新查看后再合并' } }, 409));
  const sheet = await openPull('GitHub PR inbox');
  fireEvent.click(await within(sheet).findByRole('button', { name: '合并…' }));
  fireEvent.click(await within(sheet).findByRole('button', { name: '合并 #42' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '合并' }));
  const error = await within(sheet).findByRole('alert');
  expect(error.textContent).toContain('PR 有了新提交（现在是 1111111）');
  expect(mocks.toast.success).not.toHaveBeenCalled();
  // The error stays until the user acts on it.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(within(sheet).getByRole('alert')).toBeTruthy();
  fireEvent.click(within(error).getByRole('button', { name: '重新载入 PR' }));
  await waitFor(() => expect(mocks.github.pull).toHaveBeenLastCalledWith('Jineggegg', 'agent-cloud-studio', 42, true));
  expect(await within(sheet).findByRole('button', { name: '合并…' })).toBeTruthy();
});

test('failing checks that are not required must be acknowledged, and blockers disable merging', async () => {
  mocks.github.pull.mockImplementation(json(detail({ checkItems: [{ name: 'E2E (Safari)', workflow: 'CI', state: 'failing', required: false, url: null }] })));
  mocks.github.merge.mockImplementation(json({ outcome: 'queued', mergeCommitSha: null, message: '#42 已交给 GitHub' }));
  const sheet = await openPull('GitHub PR inbox');
  fireEvent.click(await within(sheet).findByRole('button', { name: '合并…' }));
  const merge = await within(sheet).findByRole('button', { name: '合并 #42' });
  expect((merge as HTMLButtonElement).disabled).toBe(true);
  expect(within(sheet).getByText('1 项检查没有通过')).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('switch', { name: '我已了解，仍要合并' }));
  expect((merge as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(merge);
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '合并' }));
  await waitFor(() => expect(mocks.github.merge).toHaveBeenCalledWith('Jineggegg', 'agent-cloud-studio', 42, expect.objectContaining({ acknowledgeFailing: true })));
  expect(await within(sheet).findByText('#42 已进入合并队列')).toBeTruthy();
  cleanup();

  mocks.github.pull.mockImplementation(json(detail({ isDraft: true, blockers: [{ code: 'PR_DRAFT', message: '草稿 PR 不能合并：请先在 GitHub 上标记为可审查' }] })));
  const blocked = await openPull('GitHub PR inbox');
  expect(await within(blocked).findByText('草稿 PR 不能合并：请先在 GitHub 上标记为可审查')).toBeTruthy();
  expect((within(blocked).getByRole('button', { name: '合并' }) as HTMLButtonElement).disabled).toBe(true);
});

test('the GitHub widget shows the open PR count and CI state when small, and the top three PRs when medium', async () => {
  localStorage.setItem('studio-widgets-v1', JSON.stringify([{ id: 'w-gh-s', type: 'github', size: 'small' }, { id: 'w-gh-m', type: 'github', size: 'medium' }]));
  render(<StudioWidgets editing={false} snr={null} onEnterEdit={vi.fn()} galleryOpen={false} onGalleryClose={vi.fn()} />);
  const [small, medium] = await screen.findAllByRole('article', { name: 'GitHub' });
  await waitFor(() => expect(small.textContent).toContain('1 个 PR 检查失败'));
  expect(small.textContent).toContain('个 PR');
  expect(small.textContent).toContain('1 个待审');
  expect(medium.textContent).toContain('GitHub PR inbox');
  expect(medium.textContent).toContain('claudecodeui #512');
  expect(medium.textContent).toContain('共 3 个');
  // One request feeds both widgets.
  expect(mocks.github.pulls).toHaveBeenCalledTimes(1);
});
