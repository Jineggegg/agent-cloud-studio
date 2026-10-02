import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { toast } from 'sonner';
import { ChevronDown, ChevronLeft, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, GitMerge, RotateCw, TriangleAlert } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { readableErrorMessage } from '@/shared/utils';
import type { StudioGitHubCheck, StudioGitHubFile, StudioGitHubMergeMethod, StudioGitHubMergeResult, StudioGitHubPull, StudioGitHubPullDetail } from '@/shared/types';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { GitHubPullMark, GitHubReviewBadge, GitHubTime } from '@/modules/studio/StudioGitHubMarks';

type Step = 'detail' | 'merge' | 'done';
type Phase = 'idle' | 'merging' | 'merged' | 'queued';

const METHOD_COPY: Record<StudioGitHubMergeMethod, { label: string; hint: (base: string) => string }> = {
  squash: { label: '压缩合并', hint: base => `把全部提交压缩成一个，写入 ${base}` },
  merge: { label: '合并提交', hint: base => `保留全部提交，并在 ${base} 上创建一个合并提交` },
  rebase: { label: '变基合并', hint: base => `把提交逐个变基到 ${base}，不产生合并提交` },
};
// The last method chosen per repository, so a repository that always squashes opens on 压缩合并.
const METHOD_STORAGE_KEY = 'studio-github-merge-method-v1';
const FILES_PREVIEW = 8;
// The sheet unmounts when one of its CSS exit animations ends (iPad fade, phone slide-down).
const EXIT_ANIMATIONS = new Set(['gh-sheet-out', 'gh-sheet-down']);
// In case animationend never arrives; longer than the slowest exit (the phone's 380 ms slide).
const EXIT_FALLBACK_MS = 480;
// While a check runs, the open sheet re-reads the pull request this often so 合并 unlocks without closing it.
const PENDING_POLL_MS = 15_000;
// What Tab can reach inside the sheet (disabled buttons and hidden inputs are skipped).
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), [tabindex]:not([tabindex="-1"])';
// Server refusals that mean the sheet shows an outdated pull request; they offer 重新载入 instead of 重试.
const STALE_CODES = new Set([
  'HEAD_MOVED', 'BASE_MOVED', 'HEAD_BEHIND', 'MERGE_BLOCKED', 'CHECKS_FAILING', 'REQUIRED_CHECKS_FAILED', 'REQUIRED_CHECKS_PENDING',
  'PR_NOT_OPEN', 'PR_DRAFT', 'MERGE_CONFLICT', 'MERGE_OUTCOME_UNKNOWN', 'DELETE_BRANCH_UNSUPPORTED', 'GH_PARTIAL_RESPONSE',
]);
const CHANGE_MARK: Record<string, { letter: string; label: string }> = {
  added: { letter: 'A', label: '新增' }, modified: { letter: 'M', label: '修改' }, deleted: { letter: 'D', label: '删除' },
  renamed: { letter: 'R', label: '重命名' }, copied: { letter: 'C', label: '复制' }, changed: { letter: 'M', label: '变更' },
};
// Steps slide like a navigation push; the exit is short because mode="wait" holds the next step until it ends.
const STEP_VARIANTS = {
  enter: (direction: number) => ({ opacity: 0, x: 28 * direction }),
  center: { opacity: 1, x: 0, transition: { type: 'spring' as const, stiffness: 420, damping: 38 } },
  exit: (direction: number) => ({ opacity: 0, x: -28 * direction, transition: { duration: 0.14, ease: 'easeIn' as const } }),
};

function readMethod(repoKey: string): StudioGitHubMergeMethod | null {
  try {
    const saved = JSON.parse(localStorage.getItem(METHOD_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const value = saved[repoKey];
    return value === 'squash' || value === 'merge' || value === 'rebase' ? value : null;
  } catch { return null; }
}
function writeMethod(repoKey: string, method: StudioGitHubMergeMethod) {
  try {
    const saved = JSON.parse(localStorage.getItem(METHOD_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(METHOD_STORAGE_KEY, JSON.stringify({ ...saved, [repoKey]: method }));
  } catch { /* Private mode: the choice lasts for this sheet only. */ }
}
function exitFallback() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_FALLBACK_MS;
}
// GitHub's mergeability in words for the 可合并 row, with the tone it is drawn in.
function mergeability(detail: StudioGitHubPullDetail): { label: string; tone: '' | 'ci-failing' | 'ci-pending' } {
  if (detail.state !== 'open') return { label: detail.state === 'merged' ? '已合并' : '已关闭', tone: '' };
  if (detail.mergeable === 'conflicting' || detail.mergeState === 'dirty') return { label: '有冲突', tone: 'ci-failing' };
  if (detail.mergeState === 'behind') return { label: '落后于目标分支', tone: 'ci-failing' };
  if (detail.mergeState === 'blocked') return { label: '被分支保护阻止', tone: 'ci-failing' };
  if (detail.mergeState === 'unstable') return { label: '有检查未通过', tone: 'ci-pending' };
  return { label: detail.mergeable === 'mergeable' ? '没有冲突' : 'GitHub 正在计算', tone: '' };
}
// The server's machine-readable error code (ApiRequestError.code), or '' when there is none.
function errorCode(reason: unknown) {
  return reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string' ? reason.code : '';
}
const number = (value: number) => value.toLocaleString('zh-CN');

/**
 * The merge, drawn as git draws it: the head branch runs along the top and bends into the base lane. While GitHub
 * merges, light runs down the head lane; once merged the lane fills green and the merge commit lands on the base.
 */
function MergeConfluence({ head, base, sha, phase }: { head: string; base: string; sha: string; phase: Phase }) {
  // A 320×108 drawing: the head lane at y 28 bends into the base lane at y 70; the labels sit at the same proportions.
  const headPath = 'M 22 28 H 150 C 196 28 206 70 252 70';
  const settled = phase === 'merged' || phase === 'queued';
  return <figure className={`gh-confluence is-${phase}`} aria-label={`${head} 合并到 ${base}，头提交 ${sha}`}>
    <div className="gh-confluence-art">
      <svg viewBox="0 0 320 108" aria-hidden="true">
        <path className="gh-lane base" d="M 8 70 H 312" />
        <circle className="gh-node past" cx="46" cy="70" r="4" />
        <circle className="gh-node past" cx="100" cy="70" r="4" />
        <path className="gh-lane head" d={headPath} />
        {phase === 'merging' && <path className="gh-lane flow" d={headPath} />}
        {settled && <m.path className="gh-lane landed" d={headPath} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }} />}
        <circle className="gh-node tip" cx="150" cy="28" r="6.5" />
        <m.g className="gh-node target" style={{ transformOrigin: '252px 70px', transformBox: 'view-box' }}
          animate={settled ? { scale: [0.6, 1.18, 1] } : { scale: 1 }} transition={{ duration: 0.55, delay: settled ? 0.55 : 0 }}>
          <circle cx="252" cy="70" r="9" />
          {settled && <path className="gh-target-mark" d={phase === 'merged' ? 'M 247.6 70.4 L 250.8 73.4 L 256.6 66.8' : 'M 252 65.5 V 70.5 L 255 72.5'} />}
        </m.g>
      </svg>
      <figcaption>
        <code className="gh-confluence-head" title={head}>{head}</code>
        <code className="gh-confluence-sha">{sha}</code>
        <code className="gh-confluence-base" title={base}>{base}</code>
      </figcaption>
    </div>
  </figure>;
}

function CheckIcon({ state }: { state: StudioGitHubCheck['state'] }) {
  if (state === 'failing') return <CircleX size={18} className="gh-check-icon failing" aria-hidden="true" />;
  if (state === 'pending') return <CircleDashed size={18} className="gh-check-icon pending" aria-hidden="true" />;
  if (state === 'skipped') return <CircleMinus size={18} className="gh-check-icon skipped" aria-hidden="true" />;
  return <CircleCheck size={18} className="gh-check-icon passing" aria-hidden="true" />;
}
const CHECK_STATE_LABEL: Record<StudioGitHubCheck['state'], string> = { failing: '失败', pending: '运行中', passing: '通过', skipped: '已跳过' };

// GitHub's five-square diffstat: additions and deletions in proportion, grey when nothing changed.
function DiffBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  const green = total ? Math.round(additions / total * 5) : 0;
  const red = total ? 5 - green : 0;
  return <span className="gh-diff-blocks" aria-hidden="true">
    {Array.from({ length: 5 }, (_, index) => <i key={index} className={index < green ? 'add' : index < green + red ? 'del' : ''} />)}
  </span>;
}

function FileRow({ file }: { file: StudioGitHubFile }) {
  const slash = file.path.lastIndexOf('/');
  const mark = CHANGE_MARK[file.change] ?? CHANGE_MARK.changed;
  return <li className="gh-file">
    <span className={`gh-file-change ${file.change}`} title={mark.label}><span aria-hidden="true">{mark.letter}</span><span className="studio-visually-hidden">{mark.label}</span></span>
    <span className="gh-file-path mono" title={file.path}>
      {slash >= 0 && <span className="gh-file-dir">{file.path.slice(0, slash + 1)}</span>}
      <span className="gh-file-name">{file.path.slice(slash + 1)}</span>
    </span>
    <span className="gh-diff mono"><ins>+{number(file.additions)}</ins><del>−{number(file.deletions)}</del></span>
  </li>;
}

/**
 * Used by StudioGitHub for one pull request: checks, files and description, then 合并 → method → a destructive
 * confirmation naming the repository, PR and short SHA → spinner → success toast. Errors stay in the sheet, and the
 * server re-checks everything (head SHA, required checks, blockers) before it runs gh pr merge.
 */
export function StudioGitHubSheet({ pull, canMerge, onClose, onChanged }: {
  pull: StudioGitHubPull;
  // False when the server's gh token cannot merge (no repo scope); merging is then not offered.
  canMerge: boolean;
  onClose: () => void;
  // Called after every merge attempt that reached the server, so the inbox and merge history refresh.
  onChanged: (result: StudioGitHubMergeResult | null) => void;
}) {
  const repoKey = `${pull.owner}/${pull.repo}`.toLowerCase();
  // The pull request with checks and files; null while the first read is in flight.
  const [detail, setDetail] = useState<StudioGitHubPullDetail | null>(null);
  // Why reading the pull request failed; shown with 重试.
  const [loadError, setLoadError] = useState('');
  // Which screen of the sheet is shown.
  const [step, setStep] = useState<Step>('detail');
  // +1 pushes forward, -1 goes back; steers the slide direction.
  const [direction, setDirection] = useState(1);
  // The method the user picked; null follows the repository's last choice or its first allowed method.
  const [methodChoice, setMethodChoice] = useState<StudioGitHubMergeMethod | null>(() => readMethod(repoKey));
  // Delete the head branch after merging; off until the user turns it on (offered only where it changes something).
  const [deleteChoice, setDeleteChoice] = useState(false);
  // The head commit whose failing checks the user accepted (branch protection does not require them); a new head
  // commit has new checks, so the acknowledgement lapses with it.
  const [acknowledgedSha, setAcknowledgedSha] = useState<string | null>(null);
  // The destructive confirmation alert is open.
  const [confirming, setConfirming] = useState(false);
  // The merge request is in flight; the sheet cannot be closed meanwhile.
  const [merging, setMerging] = useState(false);
  // The last merge failure and its server code; kept visible until the next attempt.
  const [mergeError, setMergeError] = useState<{ message: string; code: string } | null>(null);
  // The successful merge, shown on the done screen.
  const [result, setResult] = useState<StudioGitHubMergeResult | null>(null);
  // All files instead of the first few.
  const [allFiles, setAllFiles] = useState(false);
  // The full description excerpt instead of six lines.
  const [bodyOpen, setBodyOpen] = useState(false);
  // The exit animation runs before the sheet unmounts.
  const [closing, setClosing] = useState(false);
  // The header's refresh is reading the pull request again; its icon spins meanwhile.
  const [refreshing, setRefreshing] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // onClose runs once, from whichever comes first: the exit animation's end or its fallback timer.
  const closed = useRef(false);

  // Resolves with the pull request, or null when the read failed. A quiet read (the background poll) keeps the
  // current error line rather than adding one.
  const load = useCallback(async (refresh: boolean, quiet = false) => {
    try {
      const next = await api.studio.github.pull(pull.owner, pull.repo, pull.number, refresh).then(readApiJson<StudioGitHubPullDetail>);
      setDetail(next);
      setLoadError('');
      return next;
    } catch (failure) {
      if (!quiet) setLoadError(readableErrorMessage(failure, '读取 PR 失败'));
      return null;
    }
  }, [pull.owner, pull.repo, pull.number]);
  useEffect(() => {
    // The server may hold a copy older than the inbox row; a different head commit means it is stale.
    void load(false).then(loaded => { if (loaded && loaded.headSha !== pull.headSha) void load(true); });
  }, [load, pull.headSha]);
  // While a check runs, keep the detail current so a finished required check unlocks 合并 in place.
  const checksRunning = Boolean(detail?.checkItems.some(check => check.state === 'pending'));
  useEffect(() => {
    if (!checksRunning || step !== 'detail' || merging || closing) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(true, true); }, PENDING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [checksRunning, step, merging, closing, load]);

  useEffect(() => {
    // Focus moves into the sheet and returns to the row that opened it.
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const finishClose = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };
  const close = () => {
    if (merging || closing) return;
    setClosing(true);
    window.setTimeout(finishClose, exitFallback());
  };
  const refresh = async () => {
    // Ignored while one runs; the button stays enabled so keyboard focus does not fall out of the sheet.
    if (refreshing) return;
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };
  // Each screen starts at its top, like a navigation push.
  const go = (next: Step, towards: 1 | -1) => {
    setDirection(towards);
    setStep(next);
    if (body.current) body.current.scrollTop = 0;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // The confirmation alert handles its own keys while it is open.
    if (confirming) return;
    if (event.key === 'Tab') {
      // A modal sheet keeps keyboard focus inside itself, wrapping at either end.
      const focusable = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === sheet.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (step === 'merge' && !merging) go('detail', -1); else close();
  };

  const shown = detail;
  const method = shown ? (methodChoice && shown.mergeMethods.includes(methodChoice) ? methodChoice : shown.mergeMethods[0]) : undefined;
  // Deleting is offered only where the flag changes something: GitHub already deletes on auto-delete, a fork's
  // branch is out of reach, and a merge queue cannot delete.
  const offerDelete = shown ? !shown.isCrossRepository && !shown.deleteBranchOnMerge && !shown.mergeQueue : false;
  const deleteBranch = offerDelete && deleteChoice;
  const failing = shown?.checkItems.filter(check => check.state === 'failing') ?? [];
  const pending = shown?.checkItems.filter(check => check.state === 'pending') ?? [];
  // GitHub's UNSTABLE covers checks that do not pass even when none is listed as failing; both need the user's word.
  const needsAcknowledgement = failing.length > 0 || shown?.mergeState === 'unstable';
  const blockers = [...(shown?.blockers ?? []), ...(canMerge ? [] : [{ code: 'NO_SCOPE', message: 'gh 令牌缺少 repo 权限：在服务器上运行 gh auth refresh -s repo' }])];
  const short = (shown?.headSha ?? pull.headSha).slice(0, 7);
  const acknowledged = Boolean(shown && acknowledgedSha === shown.headSha);
  const ready = Boolean(shown && method && !blockers.length && (!needsAcknowledgement || acknowledged));
  const phase: Phase = result ? (result.outcome === 'merged' ? 'merged' : 'queued') : merging ? 'merging' : 'idle';

  const submit = async () => {
    if (!shown || !method) return;
    setMerging(true);
    setMergeError(null);
    try {
      const merged = await api.studio.github.merge(pull.owner, pull.repo, pull.number, {
        method, expectedHeadSha: shown.headSha, deleteBranch, acknowledgeFailing: needsAcknowledgement && acknowledged,
      }).then(readApiJson<StudioGitHubMergeResult>);
      writeMethod(repoKey, method);
      setResult(merged);
      go('done', 1);
      toast.success(merged.outcome === 'merged' ? `已合并 #${pull.number}` : `#${pull.number} 已进入合并队列`);
      onChanged(merged);
    } catch (failure) {
      setMergeError({ message: readableErrorMessage(failure, '合并失败'), code: errorCode(failure) });
      onChanged(null);
    } finally {
      setMerging(false);
    }
  };
  const reload = async () => {
    setMergeError(null);
    setAcknowledgedSha(null);
    await load(true);
    go('detail', -1);
  };

  const header = <header className="gh-sheet-header">
    {step === 'merge'
      ? <button type="button" className="gh-sheet-nav" disabled={merging} onClick={() => go('detail', -1)}><ChevronLeft size={22} aria-hidden="true" />返回</button>
      : <button type="button" className="gh-sheet-nav" disabled={merging} onClick={close}>关闭</button>}
    <h2 id="gh-sheet-title">{step === 'merge' ? '合并' : step === 'done' ? (result?.outcome === 'queued' ? '已排队' : '已合并') : `#${pull.number}`}</h2>
    <div className="gh-sheet-actions">
      {step === 'detail' && shown && <button type="button" className={`icon-button gh-sheet-refresh ${refreshing ? 'refreshing' : ''}`}
        aria-busy={refreshing || undefined} aria-label="刷新 PR" title="刷新" onClick={() => void refresh()}>
        <RotateCw size={19} aria-hidden="true" />
      </button>}
      <a className="icon-button" href={pull.url} target="_blank" rel="noreferrer" aria-label="在 GitHub 上打开" title="在 GitHub 上打开">
        <ExternalLink size={19} aria-hidden="true" />
      </a>
    </div>
  </header>;

  const loading = <div className="gh-sheet-step" role="status" aria-label="正在读取 PR">
    <div className="gh-sheet-intro"><GitHubPullMark pull={pull} /><div><p className="gh-sheet-repo">{pull.owner}/{pull.repo}</p><h3>{pull.title}</h3></div></div>
    <div className="skeleton-block" style={{ height: 132 }} />
    <div className="skeleton-block" style={{ height: 196 }} />
  </div>;

  const failed = <div className="gh-sheet-step">
    <div className="gh-callout bad" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span>{loadError}</span></div>
    <button type="button" className="ios-button tinted" onClick={() => { setLoadError(''); void load(true); }}><RotateCw size={16} aria-hidden="true" />重试</button>
  </div>;

  const visibleFiles = shown ? (allFiles ? shown.files : shown.files.slice(0, FILES_PREVIEW)) : [];
  const detailStep = shown && <m.div key="detail" className="gh-sheet-step" custom={direction} variants={STEP_VARIANTS} initial="enter" animate="center" exit="exit">
    {loadError && <div className="gh-callout bad" role="alert"><TriangleAlert size={18} aria-hidden="true" /><span>{loadError}</span></div>}
    <div className="gh-sheet-intro">
      <GitHubPullMark pull={shown} />
      <div>
        <p className="gh-sheet-repo">{shown.owner}/{shown.repo}</p>
        <h3>{shown.title}</h3>
        <p className="gh-sheet-byline">{shown.author} · <GitHubTime iso={shown.updatedAt} prefix="更新于 " /></p>
      </div>
    </div>
    <div className="gh-branches">
      <code title={shown.headRef}>{shown.headRef}</code><span aria-label="合并到">→</span><code title={shown.baseRef}>{shown.baseRef}</code>
      <span className="gh-sha mono" title={shown.headSha}>{short}</span>
    </div>

    <ul className="ios-list gh-facts">
      <li><span>检查</span><span className={`gh-fact-value ci-${shown.checks.state}`}>
        {shown.checks.total ? [shown.checks.failing && `${shown.checks.failing} 项失败`, shown.checks.pending && `${shown.checks.pending} 项运行中`, shown.checks.passing && `${shown.checks.passing} 项通过`].filter(Boolean).join(' · ') : '没有检查'}
      </span></li>
      <li><span>审查</span><span className="gh-fact-value">{shown.reviewDecision ? <GitHubReviewBadge decision={shown.reviewDecision} /> : '不需要审查'}</span></li>
      <li><span>改动</span><span className="gh-fact-value"><span className="gh-diff mono"><ins>+{number(shown.additions)}</ins><del>−{number(shown.deletions)}</del></span><DiffBlocks additions={shown.additions} deletions={shown.deletions} /></span></li>
      <li><span>可合并</span><span className={`gh-fact-value ${mergeability(shown).tone}`}>{mergeability(shown).label}</span></li>
    </ul>

    {shown.checkItems.length > 0 && <section className="gh-sheet-section" aria-labelledby="gh-checks-title">
      <h4 id="gh-checks-title">检查</h4>
      <ul className="ios-list gh-checks">
        {shown.checkItems.map(check => <li key={`${check.workflow ?? ''}/${check.name}`} className="gh-check">
          <CheckIcon state={check.state} />
          <span className="gh-check-body"><strong>{check.name}</strong><small>{[check.workflow, CHECK_STATE_LABEL[check.state]].filter(Boolean).join(' · ')}</small></span>
          {check.required && <span className="gh-badge">必需</span>}
          {check.url && <a className="icon-button plain gh-check-link" href={check.url} target="_blank" rel="noreferrer" aria-label={`查看 ${check.name} 的日志`}><ExternalLink size={16} aria-hidden="true" /></a>}
        </li>)}
      </ul>
      {shown.checksTruncated && <p className="ios-section-footer">只列出前 100 项检查。</p>}
    </section>}

    {shown.files.length > 0 && <section className="gh-sheet-section" aria-labelledby="gh-files-title">
      <h4 id="gh-files-title">文件 <span>{number(shown.filesTotal)} 个</span></h4>
      <ul className="ios-list gh-files">{visibleFiles.map(file => <FileRow key={file.path} file={file} />)}</ul>
      {shown.files.length > FILES_PREVIEW && <button type="button" className="gh-more" aria-expanded={allFiles} onClick={() => setAllFiles(open => !open)}>
        {allFiles ? '收起' : `显示全部 ${shown.files.length} 个文件`}<ChevronDown size={16} aria-hidden="true" />
      </button>}
      {shown.filesTotal > shown.files.length && allFiles && <p className="ios-section-footer">只列出前 100 个文件，其余请在 GitHub 上查看。</p>}
    </section>}

    {shown.body && <section className="gh-sheet-section" aria-labelledby="gh-body-title">
      <h4 id="gh-body-title">描述</h4>
      <div className={`gh-body ${bodyOpen ? 'is-open' : ''}`}><p>{shown.body}</p></div>
      <button type="button" className="gh-more" aria-expanded={bodyOpen} onClick={() => setBodyOpen(open => !open)}>
        {bodyOpen ? '收起' : '展开描述'}<ChevronDown size={16} aria-hidden="true" />
      </button>
    </section>}
  </m.div>;

  const mergeStep = shown && method && <m.div key="merge" className="gh-sheet-step" custom={direction} variants={STEP_VARIANTS} initial="enter" animate="center" exit="exit">
    <MergeConfluence head={shown.headRef} base={shown.baseRef} sha={short} phase={phase} />
    <div className="ios-list gh-merge-options">
      <div className="gh-merge-row">
        <span id="gh-merge-method">方式</span>
        <div className="segmented gh-segmented" role="radiogroup" aria-labelledby="gh-merge-method">
          {shown.mergeMethods.map(item => <button key={item} type="button" role="radio" aria-checked={method === item} disabled={merging}
            onClick={() => setMethodChoice(item)}>{METHOD_COPY[item].label}</button>)}
        </div>
      </div>
      <p className="gh-merge-hint">{METHOD_COPY[method].hint(shown.baseRef)}</p>
      {offerDelete && <label className="gh-merge-row gh-switch-row">
        <span>合并后删除 <code>{shown.headRef}</code></span>
        <input type="checkbox" role="switch" className="ios-switch" checked={deleteBranch} disabled={merging} onChange={event => setDeleteChoice(event.target.checked)} />
      </label>}
      {!shown.isCrossRepository && shown.deleteBranchOnMerge && <div className="gh-merge-row gh-fixed-row">
        <span>GitHub 会在合并后自动删除 <code>{shown.headRef}</code></span>
      </div>}
    </div>
    {needsAcknowledgement && <div className="gh-callout warn">
      <TriangleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{failing.length ? `${failing.length} 项检查没有通过` : '检查没有全部通过'}</strong>
        <span>{failing.length
          ? <>{failing.slice(0, 4).map(check => check.name).join('、')}{failing.length > 4 ? ' 等' : ''} 没有通过；分支保护不要求这些检查，GitHub 仍允许合并。</>
          : 'GitHub 报告这个 PR 有检查没有通过或还在运行，可能不在上面的列表里；分支保护不要求它们，GitHub 仍允许合并。'}</span>
        <label className="gh-acknowledge">
          <input type="checkbox" role="switch" className="ios-switch" checked={acknowledged} disabled={merging} onChange={event => setAcknowledgedSha(event.target.checked ? shown.headSha : null)} />
          我已了解，仍要合并
        </label>
      </div>
    </div>}
    {pending.length > 0 && <p className="gh-note">{pending.length} 项检查还在运行，合并不会等待它们。</p>}
    {shown.mergeQueue && <p className="gh-note">这个仓库使用合并队列：PR 会进入队列，由 GitHub 按顺序检查并合并。</p>}
    {shown.reviewDecision === 'review_required' && <p className="gh-note">这个 PR 还没有通过审查；如果分支保护要求审查，GitHub 会拒绝合并。</p>}
    {shown.reviewDecision === 'changes_requested' && <p className="gh-note">审查者要求修改；如果分支保护要求审查，GitHub 会拒绝合并。</p>}
    <dl className="gh-merge-facts">
      <div><dt>仓库</dt><dd>{shown.owner}/{shown.repo}</dd></div>
      <div><dt>PR</dt><dd>#{shown.number}</dd></div>
      <div><dt>头提交</dt><dd className="mono">{short}</dd></div>
      <div><dt>目标分支</dt><dd className="mono">{shown.baseRef}</dd></div>
    </dl>
    {mergeError && <div className="gh-callout bad" role="alert">
      <TriangleAlert size={18} aria-hidden="true" />
      <div>
        <strong>{mergeError.code === 'MERGE_OUTCOME_UNKNOWN' ? '合并结果未知' : '没有合并'}</strong>
        <span>{mergeError.message}</span>
        {STALE_CODES.has(mergeError.code) && <button type="button" className="ios-button tinted" onClick={() => void reload()}><RotateCw size={15} aria-hidden="true" />重新载入 PR</button>}
      </div>
    </div>}
  </m.div>;

  const doneStep = shown && result && <m.div key="done" className="gh-sheet-step is-done" custom={direction} variants={STEP_VARIANTS} initial="enter" animate="center" exit="exit">
    <MergeConfluence head={shown.headRef} base={shown.baseRef} sha={short} phase={phase} />
    <div className="gh-done">
      <h3>{result.outcome === 'merged' ? `#${shown.number} 已合并` : `#${shown.number} 已进入合并队列`}</h3>
      <p>{result.message}</p>
      {result.mergeCommitSha && <p className="gh-done-sha">合并提交 <span className="mono">{result.mergeCommitSha.slice(0, 7)}</span></p>}
    </div>
  </m.div>;

  const footer = shown && <footer className="gh-sheet-footer">
    {step === 'detail' && (blockers.length
      ? <><p className="gh-blocker" role="note">{blockers[0].message}</p><button type="button" className="ios-button filled gh-primary" disabled>合并</button></>
      : <button type="button" className="ios-button filled gh-primary" onClick={() => go('merge', 1)}><GitMerge size={18} aria-hidden="true" />合并…</button>)}
    {step === 'merge' && <button type="button" className="ios-button gh-primary gh-danger" disabled={!ready || merging} onClick={() => setConfirming(true)}>
      {merging ? <><StudioSpinner size={17} />正在合并…</> : <><GitMerge size={18} aria-hidden="true" />合并 #{shown.number}</>}
    </button>}
    {step === 'done' && <button type="button" className="ios-button filled gh-primary" onClick={close}>完成</button>}
  </footer>;

  return createPortal(
    <div className={`studio-layer ${closing ? 'closing' : ''}`} onKeyDown={onKeyDown}>
      <div className="sheet-scrim" aria-hidden="true" onClick={close} />
      <div ref={sheet} tabIndex={-1} className="gh-sheet" role="dialog" aria-modal="true" aria-labelledby="gh-sheet-title" aria-busy={merging || undefined}
        onAnimationEnd={event => { if (closing && event.target === event.currentTarget && EXIT_ANIMATIONS.has(event.animationName)) finishClose(); }}>
        <div className="gh-sheet-grabber" aria-hidden="true" />
        {header}
        <div ref={body} className="gh-sheet-body">
          {!shown ? (loadError ? failed : loading)
            : <AnimatePresence mode="wait" initial={false} custom={direction}>
              {step === 'detail' ? detailStep : step === 'merge' ? mergeStep : doneStep}
            </AnimatePresence>}
        </div>
        {footer}
      </div>
      {confirming && shown && method && <StudioConfirmSheet
        title={`合并 #${shown.number} 到 ${shown.baseRef}？`}
        message={`${shown.owner}/${shown.repo} · ${METHOD_COPY[method].label} · 头提交 ${short}${deleteBranch ? ` · 合并后删除 ${shown.headRef}` : ''}。合并后无法在 Studio 里撤销。`}
        confirmLabel="合并"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void submit(); }} />}
    </div>,
    document.body,
  );
}
