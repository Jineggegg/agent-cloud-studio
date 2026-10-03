import { useState } from 'react';
import { GitPullRequest } from 'lucide-react';

import { StudioGitHubSheet } from '@/modules/studio';
import type { StudioGitHubBranchPull } from '@/shared/types';
import { useWorkbenchBranchPull } from '@/modules/workbench/hooks/useWorkbenchBranchPull';

type ChipTone = 'good' | 'warn' | 'bad' | 'pending' | 'muted';

// The pull request's state in two or three words, worst news first, with the tone of its dot.
function chipStatus(pull: StudioGitHubBranchPull['pull']): { label: string; tone: ChipTone } {
  if (pull.isDraft) return { label: '草稿', tone: 'muted' };
  if (pull.mergeable === 'conflicting' || pull.mergeState === 'dirty') return { label: '有冲突', tone: 'bad' };
  if (pull.blockers.some(blocker => blocker.code === 'HEAD_BEHIND')) return { label: '需更新分支', tone: 'warn' };
  if (pull.pendingRuns.length) return { label: '运行待批准', tone: 'warn' };
  if (pull.checks.failing) return { label: '检查未通过', tone: 'bad' };
  if (pull.checks.pending) return { label: '检查运行中', tone: 'pending' };
  if (pull.blockers.length) {
    if (pull.reviewDecision === 'review_required') return { label: '待审查', tone: 'warn' };
    if (pull.reviewDecision === 'changes_requested') return { label: '需修改', tone: 'warn' };
    return { label: '暂不能合并', tone: 'warn' };
  }
  if (pull.mergeState === 'unknown') return { label: '正在检查', tone: 'pending' };
  return { label: '可合并', tone: 'good' };
}

/**
 * Used by WorkbenchShell in the chat title bar: 「PR #12 · 可合并」 for the open pull request of the project's current
 * branch, opening the Studio PR sheet (checks, fixes, merge) on tap. Renders nothing while there is no such PR.
 * `running` is the open session's run state; the chip re-reads when a run ends.
 */
export function WorkbenchPullChip({ projectId, running }: { projectId: string; running: boolean }) {
  const { branchPull, refresh } = useWorkbenchBranchPull(projectId, running);
  // The pull request whose sheet is open. Kept apart from the chip's reading so a merge made in the sheet (which makes
  // the chip disappear) does not close the sheet before it shows the result.
  const [opened, setOpened] = useState<StudioGitHubBranchPull | null>(null);
  const status = branchPull ? chipStatus(branchPull.pull) : null;
  return <>
    {branchPull && status && <button type="button" className={`wb-pr-chip is-${status.tone}`} onClick={() => setOpened(branchPull)}
      aria-label={`PR #${branchPull.pull.number}：${status.label}，打开 PR`} title={`${branchPull.pull.title}（${branchPull.branch}）`}>
      <GitPullRequest size={14} strokeWidth={2.2} aria-hidden="true" />
      <span className="wb-pr-chip-number">PR #{branchPull.pull.number}</span>
      <span className="wb-pr-chip-dot" aria-hidden="true" />
      <span className="wb-pr-chip-state">{status.label}</span>
    </button>}
    {opened && <StudioGitHubSheet pull={opened.pull} canMerge={opened.canMerge}
      onClose={() => { setOpened(null); void refresh(); }} onChanged={() => { void refresh(); }} />}
  </>;
}
