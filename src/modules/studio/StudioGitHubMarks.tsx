import { useSyncExternalStore } from 'react';

import { IconGitPullRequest, IconGitPullRequestDraft } from '@/modules/studio/icons/tabler';
import type { StudioGitHubChecks, StudioGitHubPull } from '@/shared/types';

type BeadState = 'failing' | 'pending' | 'passing';

// A row of beads stays readable at a glance up to about eight; beyond that each bead stands for several checks.
const BEAD_LIMIT = 8;
const REVIEW_LABEL = {
  approved: { text: '已批准', tone: 'good' },
  changes_requested: { text: '需修改', tone: 'bad' },
  review_required: { text: '待审查', tone: 'warn' },
} as const;

// Relative timestamps re-read the clock in 30-second steps; one shared timer wakes every visible timestamp.
const CLOCK_STEP_MS = 30_000;
const clockListeners = new Set<() => void>();
let clockTimer: number | undefined;
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  clockTimer ??= window.setInterval(() => { for (const notify of clockListeners) notify(); }, CLOCK_STEP_MS);
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && clockTimer !== undefined) { window.clearInterval(clockTimer); clockTimer = undefined; }
  };
}
// Stable within a step, so React sees the same snapshot until the step changes.
const readClock = () => Math.floor(Date.now() / CLOCK_STEP_MS) * CLOCK_STEP_MS;

// One bead per check, failures first. With more checks than beads the counts are scaled down, but every outcome that
// occurred keeps at least one bead, so a single failure among forty passes is never rounded away.
function beadRun(checks: StudioGitHubChecks, limit: number): BeadState[] {
  const parts: [BeadState, number][] = [['failing', checks.failing], ['pending', checks.pending], ['passing', checks.passing]];
  if (checks.total <= limit) return parts.flatMap(([state, amount]) => Array<BeadState>(amount).fill(state));
  const present = parts.filter(([, amount]) => amount > 0).map(([state, amount]) => ({ state, amount, beads: Math.max(1, Math.round(amount / checks.total * limit)) }));
  let used = present.reduce((sum, part) => sum + part.beads, 0);
  while (used > limit) {
    const widest = present.reduce((best, part) => part.beads > best.beads ? part : best);
    widest.beads -= 1;
    used -= 1;
  }
  return present.flatMap(part => Array<BeadState>(part.beads).fill(part.state));
}

function checksText(checks: StudioGitHubChecks) {
  if (checks.state === 'failing') return `${checks.failing} 项失败`;
  if (checks.state === 'pending') return `${checks.pending} 项运行中`;
  if (checks.state === 'passing') return checks.total === 1 ? '检查通过' : `${checks.total} 项通过`;
  return '无检查';
}

/** Used by StudioGitHub (inbox rows): a pull request's CI checks as beads plus a short label. */
export function GitHubCheckBeads({ checks, label = true }: { checks: StudioGitHubChecks; label?: boolean }) {
  const beads = beadRun(checks, BEAD_LIMIT);
  const spoken = checks.total ? `CI：${checks.failing} 项失败，${checks.pending} 项运行中，${checks.passing} 项通过` : 'CI：没有检查';
  return <span className={`gh-beads is-${checks.state}`} role="img" aria-label={spoken}>
    <span className="gh-bead-run" aria-hidden="true">
      {beads.length ? beads.map((state, index) => <i key={index} className={`gh-bead ${state}`} />) : <i className="gh-bead none" />}
    </span>
    {label && <span className="gh-beads-label" aria-hidden="true">{checksText(checks)}</span>}
  </span>;
}

/** Used by StudioGitHub (inbox rows) and StudioGitHubSheet (header): the pull request mark, tinted by its CI outcome. */
export function GitHubPullMark({ pull }: { pull: Pick<StudioGitHubPull, 'isDraft' | 'checks'> }) {
  const Icon = pull.isDraft ? IconGitPullRequestDraft : IconGitPullRequest;
  return <span className={`gh-mark ci-${pull.checks.state} ${pull.isDraft ? 'is-draft' : ''}`} aria-hidden="true">
    <Icon size={19} strokeWidth={1.8} />
  </span>;
}

/** Used by StudioGitHub and StudioGitHubSheet: the review decision as a small badge, or nothing when no review applies. */
export function GitHubReviewBadge({ decision }: { decision: StudioGitHubPull['reviewDecision'] }) {
  if (!decision) return null;
  const review = REVIEW_LABEL[decision];
  return <span className={`gh-badge ${review.tone}`}>{review.text}</span>;
}

/** Used by StudioGitHub and StudioGitHubSheet: a timestamp as 刚刚 / N 分钟前 / 昨天 / 9月30日, full time on hover. */
export function GitHubTime({ iso, prefix = '' }: { iso: string; prefix?: string }) {
  const now = useSyncExternalStore(subscribeClock, readClock);
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const text = minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : hours < 24 ? `${hours} 小时前` : days === 1 ? '昨天' : days < 7 ? `${days} 天前`
    : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(time);
  return <time dateTime={iso} title={new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(time)}>{prefix}{text}</time>;
}
