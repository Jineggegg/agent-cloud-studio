import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { ChevronRight, GitPullRequest, RotateCw, SquareTerminal, TriangleAlert } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { readableErrorMessage } from '@/shared/utils';
import type { StudioGitHubInbox, StudioGitHubMergeRecord, StudioGitHubPull, StudioGitHubStatus } from '@/shared/types';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioGitHubSheet } from '@/modules/studio/StudioGitHubSheet';
import { GitHubCheckBeads, GitHubPullMark, GitHubReviewBadge, GitHubTime } from '@/modules/studio/StudioGitHubMarks';
import '@/modules/studio/studio-github.css';

type Filter = 'all' | 'review' | 'authored' | 'owned';

const FILTERS: { id: Filter; label: string; empty: string; hint: string }[] = [
  { id: 'all', label: '全部', empty: '没有待处理的 PR', hint: '你发起的、请你审查的，以及你仓库里的开放 PR 都会出现在这里。' },
  { id: 'review', label: '待审', empty: '没有等你审查的 PR', hint: '有人请你审查时，PR 会出现在这里。' },
  { id: 'authored', label: '我发起', empty: '你没有开放中的 PR', hint: '你在任何仓库发起的开放 PR 会出现在这里。' },
  { id: 'owned', label: '我的仓库', empty: '你的仓库里没有开放的 PR', hint: '别人向你的仓库提交的 PR 也会出现在这里。' },
];
// The chosen filter, per device.
const FILTER_STORAGE_KEY = 'studio-github-filter-v1';
const OUTCOME: Record<StudioGitHubMergeRecord['outcome'], { label: string; tone: string }> = {
  merged: { label: '已合并', tone: 'good' }, queued: { label: '已排队', tone: 'warn' }, refused: { label: '已拒绝', tone: 'warn' },
  failed: { label: '失败', tone: 'bad' }, unknown: { label: '待确认', tone: 'warn' }, pending: { label: '进行中', tone: '' },
};
const METHOD_LABEL: Record<StudioGitHubMergeRecord['method'], string> = { squash: '压缩合并', merge: '合并提交', rebase: '变基合并' };
// Rows leave the list (after a merge) by folding away; they arrive with a short rise.
const ROW_SPRING = { type: 'spring', stiffness: 380, damping: 34 } as const;

function readFilter(): Filter {
  try {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY);
    return FILTERS.some(item => item.id === saved) ? saved as Filter : 'all';
  } catch { return 'all'; }
}

const number = (value: number) => value.toLocaleString('zh-CN');

function PullRow({ pull, onOpen }: { pull: StudioGitHubPull; onOpen: () => void }) {
  return <button type="button" className="gh-row" onClick={onOpen}>
    <GitHubPullMark pull={pull} />
    <span className="gh-row-body">
      <span className="gh-row-title">
        <strong>{pull.title}</strong>
        {pull.isDraft && <span className="gh-badge">草稿</span>}
      </span>
      <span className="gh-row-meta">
        <span className="mono">#{pull.number}</span>
        <span>{pull.author}</span>
        <span className="gh-row-branch mono" title={`${pull.headRef} → ${pull.baseRef}`}>{pull.headRef} → {pull.baseRef}</span>
      </span>
      <span className="gh-row-stats">
        <GitHubCheckBeads checks={pull.checks} />
        <span className="gh-diff mono" aria-label={`新增 ${pull.additions} 行，删除 ${pull.deletions} 行`}><ins>+{number(pull.additions)}</ins><del>−{number(pull.deletions)}</del></span>
        <span className="gh-row-files">{number(pull.changedFiles)} 个文件</span>
        <GitHubReviewBadge decision={pull.reviewDecision} />
        {pull.mergeable === 'conflicting' && <span className="gh-badge bad">有冲突</span>}
      </span>
    </span>
    <span className="gh-row-trail">
      <GitHubTime iso={pull.updatedAt} />
      <ChevronRight size={18} className="chevron" aria-hidden="true" />
    </span>
  </button>;
}

function InboxSkeleton() {
  return <div className="gh-skeleton" role="status" aria-label="正在读取 PR">
    {[3, 2].map((rows, group) => <div key={group} className="gh-skeleton-group">
      <span className="skeleton-block gh-skeleton-head" />
      <div className="ios-list">
        {Array.from({ length: rows }, (_, index) => <div key={index} className="gh-skeleton-row">
          <span className="skeleton-block gh-skeleton-mark" />
          <span className="gh-skeleton-lines"><span className="skeleton-block" /><span className="skeleton-block" /><span className="skeleton-block" /></span>
        </div>)}
      </div>
    </div>)}
  </div>;
}

/**
 * Used by StudioPage as the GitHub system app: the gh account's open pull requests grouped by repository, with CI
 * beads, review state and diff size, a filter for review requests, own PRs and own repositories, the merge history,
 * and the detail sheet that merges. `refreshing` is StudioPage's navigation-bar refresh; each new one reloads the
 * inbox past the server's short cache.
 */
export function StudioGitHub({ refreshing = false }: { refreshing?: boolean }) {
  // The gh account on the server; null until the first answer.
  const [status, setStatus] = useState<StudioGitHubStatus | null>(null);
  // The inbox; null until it first loads, then kept through failed refreshes so the list never blanks.
  const [inbox, setInbox] = useState<StudioGitHubInbox | null>(null);
  // Why the last load failed; shown above the (possibly stale) list until a load succeeds.
  const [error, setError] = useState('');
  // A load is in flight: skeletons before the first inbox, the sync spinner afterwards. The first load starts on mount.
  const [syncing, setSyncing] = useState(true);
  // Which part of the inbox is listed.
  const [filter, setFilter] = useState<Filter>(readFilter);
  // The pull request whose detail sheet is open.
  const [selected, setSelected] = useState<StudioGitHubPull | null>(null);
  // This Studio user's recent merge attempts from the server's audit log.
  const [merges, setMerges] = useState<StudioGitHubMergeRecord[]>([]);
  // Only the newest load may write state, so a slow early answer never overwrites a later one.
  const latestLoad = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const id = ++latestLoad.current;
    const [account, pulls, history] = await Promise.allSettled([
      api.studio.github.status(refresh).then(readApiJson<StudioGitHubStatus>),
      api.studio.github.pulls(refresh).then(readApiJson<StudioGitHubInbox>),
      api.studio.github.merges().then(readApiJson<StudioGitHubMergeRecord[]>),
    ]);
    if (id !== latestLoad.current) return;
    if (account.status === 'fulfilled') setStatus(account.value);
    if (pulls.status === 'fulfilled') {
      setInbox(pulls.value);
      setError('');
    } else {
      // A missing or signed-out gh gets the setup screen instead of an error line.
      const setupNeeded = account.status === 'fulfilled' && (!account.value.installed || !account.value.authenticated);
      setError(setupNeeded ? '' : readableErrorMessage(pulls.reason, 'PR 列表加载失败'));
    }
    if (history.status === 'fulfilled') setMerges(history.value);
    setSyncing(false);
  }, []);

  // User-started reloads show the sync spinner; the mount load already starts with it on.
  const reload = useCallback((refresh: boolean) => {
    setSyncing(true);
    void load(refresh);
  }, [load]);
  useEffect(() => { void load(false); }, [load]);
  // Coming back to the tab re-reads through the server cache, which only calls GitHub when it is stale.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) reload(false); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);
  // StudioPage's refresh button spins its own icon, so this reload skips the sync spinner.
  const wasRefreshing = useRef(refreshing);
  useEffect(() => {
    if (refreshing && !wasRefreshing.current) void load(true);
    wasRefreshing.current = refreshing;
  }, [refreshing, load]);
  useEffect(() => {
    try { localStorage.setItem(FILTER_STORAGE_KEY, filter); } catch { /* Private mode keeps the filter for this visit. */ }
  }, [filter]);

  const pulls = useMemo(() => inbox?.pulls ?? [], [inbox]);
  const counts = useMemo(() => ({
    all: pulls.length,
    review: pulls.filter(pull => pull.reasons.includes('review')).length,
    authored: pulls.filter(pull => pull.reasons.includes('authored')).length,
    owned: pulls.filter(pull => pull.reasons.includes('owned')).length,
  }), [pulls]);
  // Repositories in order of their most recent activity (the inbox is sorted newest first).
  const groups = useMemo(() => {
    const byRepo = new Map<string, StudioGitHubPull[]>();
    for (const pull of pulls) {
      if (filter !== 'all' && !pull.reasons.includes(filter)) continue;
      const key = `${pull.owner}/${pull.repo}`;
      byRepo.set(key, [...(byRepo.get(key) ?? []), pull]);
    }
    return [...byRepo.entries()].map(([key, items]) => ({ key, owner: items[0].owner, repo: items[0].repo, items }));
  }, [pulls, filter]);
  const setupNeeded = status !== null && (!status.installed || !status.authenticated);
  const activeFilter = FILTERS.find(item => item.id === filter) ?? FILTERS[0];

  return <div className="gh-app">
    <div className="gh-account" aria-live="polite">
      <span className={`status-dot ${status?.authenticated ? 'good' : ''}`} aria-hidden="true" />
      <span className="gh-account-name">{status?.login ?? (status ? '未登录' : 'GitHub')}</span>
      <span className="gh-account-sync">
        {syncing ? <><StudioSpinner size={13} />正在同步</> : inbox ? <GitHubTime iso={inbox.fetchedAt} prefix="同步于 " /> : null}
      </span>
      {status?.authenticated && !status.canMerge && <span className="gh-badge warn" title={status.message ?? undefined}>只读</span>}
    </div>

    {error && <div className="gh-callout bad" role="alert">
      <TriangleAlert size={18} aria-hidden="true" />
      <span>{error}</span>
      <button type="button" className="ios-button tinted" disabled={syncing} onClick={() => reload(true)}>重试</button>
    </div>}

    {setupNeeded ? <div className="gh-setup">
      <span className="gh-setup-mark" aria-hidden="true"><SquareTerminal size={28} strokeWidth={1.6} /></span>
      <h2>{status.installed ? '让 gh 登录 GitHub' : '这台电脑上还没有 gh'}</h2>
      <p>{status.message}</p>
      <code className="gh-command">{status.installed ? 'gh auth login' : 'sudo apt install gh'}</code>
      <p className="gh-setup-hint">在运行 Studio 的电脑（WSL）终端里执行。Studio 只调用 gh，不读取也不保存它的令牌。</p>
      <button type="button" className="ios-button filled" disabled={syncing} onClick={() => reload(true)}>
        {syncing ? <StudioSpinner size={16} /> : <RotateCw size={16} aria-hidden="true" />}重新检查
      </button>
    </div>
      : !inbox ? (error ? null : <InboxSkeleton />)
        : <>
          <div className="segmented gh-filter" role="radiogroup" aria-label="筛选 PR">
            {FILTERS.map(item => <button key={item.id} type="button" role="radio" aria-checked={filter === item.id} onClick={() => setFilter(item.id)}>
              {item.label}<span className="gh-filter-count">{counts[item.id]}</span>
            </button>)}
          </div>

          {groups.length === 0 ? <div className="ios-empty gh-empty">
            <GitPullRequest size={32} strokeWidth={1.5} aria-hidden="true" />
            <strong>{activeFilter.empty}</strong>
            <span>{activeFilter.hint}</span>
          </div>
            : <AnimatePresence initial={false}>
              {groups.map(group => <m.section key={group.key} className="gh-repo" layout="position" aria-labelledby={`gh-repo-${group.key}`}
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.16 } }} transition={ROW_SPRING}>
                <header className="gh-repo-head">
                  <h2 id={`gh-repo-${group.key}`}><span className="gh-repo-owner">{group.owner}/</span>{group.repo}</h2>
                  <span className="caption">{group.items.length}</span>
                </header>
                <ul className="ios-list gh-list">
                  <AnimatePresence initial={false}>
                    {group.items.map(pull => <m.li key={pull.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, height: 0, transition: { duration: 0.22 } }} transition={ROW_SPRING}>
                      <PullRow pull={pull} onOpen={() => setSelected(pull)} />
                    </m.li>)}
                  </AnimatePresence>
                </ul>
              </m.section>)}
            </AnimatePresence>}
          {inbox.truncated && <p className="ios-section-footer">每类只列出最近更新的 50 个 PR，其余请在 GitHub 上查看。</p>}
        </>}

    {merges.length > 0 && <section className="gh-repo gh-log" aria-labelledby="gh-log-title">
      <header className="gh-repo-head"><h2 id="gh-log-title">合并记录</h2><span className="caption">最近 {Math.min(merges.length, 6)} 次</span></header>
      <ul className="ios-list">
        {merges.slice(0, 6).map(record => <li key={record.id} className="gh-log-row">
          <span className="gh-log-body">
            <strong>{record.repo} <span className="mono">#{record.number}</span></strong>
            <small>{METHOD_LABEL[record.method]} · <span className="mono">{record.headSha.slice(0, 7)}</span>{record.message ? ` · ${record.message}` : ''}</small>
          </span>
          <span className={`gh-badge ${OUTCOME[record.outcome].tone}`}>{OUTCOME[record.outcome].label}</span>
          <GitHubTime iso={record.createdAt} />
        </li>)}
      </ul>
    </section>}

    {selected && <StudioGitHubSheet pull={selected} canMerge={status?.canMerge ?? false}
      onClose={() => setSelected(null)} onChanged={() => reload(true)} />}
  </div>;
}
