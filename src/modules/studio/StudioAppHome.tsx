import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';

import {
  IconAlertTriangle, IconArrowUp, IconExternalLink, IconRotateClockwise, IconSparkles, IconX,
} from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { HubProject, StudioAppStatus, StudioBuild, StudioReturnState, StudioTileProgress } from '@/shared/types';
import { StudioBuildProgress } from '@/modules/studio/StudioBuildProgress';
import { StudioProjectRecentSessions } from '@/modules/studio/StudioProjectAgents';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import '@/modules/studio/studio-app.css';

// Must match STUDIO_APP_SANDBOX on the server (app-gateway.service.ts): never allow-same-origin, so the app's own
// code cannot reach Studio's storage or API.
const APP_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';
// The longest change request (the builds API takes up to 8000 characters).
const MAX_REQUEST = 2000;
// The last lines of a failed start that go along with 让 AI 修复.
const FIX_LOG_LINES = 12;
// Below this width the AI sidebar becomes a sheet behind a floating button.
const SIDE_BY_SIDE_QUERY = '(min-width: 900px)';
const CANCELLED = '已取消';
const STAGE_FADE = { duration: 0.32, ease: [0.22, 0.8, 0.2, 1] } as const;

type AppView = { status: StudioAppStatus | null; loading: boolean; error: string };

// Whether the AI sidebar sits beside the app (iPad landscape, desktop) or in a sheet (portrait, phone).
function useSideBySide() {
  const read = () => typeof window.matchMedia === 'function' && window.matchMedia(SIDE_BY_SIDE_QUERY).matches;
  const [wide, setWide] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(SIDE_BY_SIDE_QUERY);
    const onChange = () => setWide(list.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, []);
  return wide;
}

// 快速让 AI 改: one sentence to the app's build session, which changes the app and commits; Enter sends (not mid-IME).
function QuickChange({ busy, onSend }: { busy: boolean; onSend: (message: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || sending || busy) return;
    setSending(true);
    if (await onSend(message)) setDraft('');
    setSending(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };
  return <form className="app-side-section app-quick" onSubmit={submit} aria-label="快速让 AI 改">
    <div className="app-side-header"><h2>快速让 AI 改</h2>{busy && <span className="app-side-note"><StudioSpinner size={13} />AI 正在改</span>}</div>
    <div className="app-quick-field">
      <textarea value={draft} onChange={event => setDraft(event.target.value.slice(0, MAX_REQUEST))} onKeyDown={onKeyDown} rows={3}
        placeholder={busy ? '等这次改完再说下一句' : '说一句想改的，比如：给笔记加上标签筛选'} aria-label="想让 AI 改什么" disabled={busy} />
      <button type="submit" className="app-quick-send ios-press" disabled={!draft.trim() || sending || busy} aria-label="交给 AI">
        {sending ? <StudioSpinner size={16} /> : <IconArrowUp size={18} strokeWidth={2.4} aria-hidden="true" />}
      </button>
    </div>
  </form>;
}

/**
 * Used by StudioPage as an AI-built app's 主页 tab, the page the app opens on: the app itself, started by Studio and
 * shown in a sandboxed iframe, with the AI beside it (新建会话, the newest sessions, 快速让 AI 改). While the AI is
 * building or changing the app its progress shows here; when it finishes, the app restarts on the new commit and
 * reloads in place. A failed start shows the app's own output and offers 让 AI 修复.
 */
export function StudioAppHome({ project, build, progress, workbenchUrl, onChange, onContinue, onOpenChat, onShowSessions }: {
  project: HubProject;
  build: StudioBuild | null;
  // The home tile's ring for the build in progress (useStudioBuilds.tileFor), so both draw the same arc.
  progress: StudioTileProgress | undefined;
  // The workbench session doing the build, for 查看过程.
  workbenchUrl: string | null;
  onChange: (message: string) => Promise<boolean>;
  onContinue: () => void;
  onOpenChat: (conversationId?: string) => void;
  onShowSessions: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // 查看开发过程 opens the build's session in the workbench, whose back control then returns to this 主页.
  const openWorkbench = (url: string) => navigate(url, { state: { studioReturn: { path: `${location.pathname}${location.search}`, title: project.name } } satisfies StudioReturnState });
  const sideBySide = useSideBySide();
  const [view, setView] = useState<AppView>({ status: null, loading: true, error: '' });
  // Bumped to reload the iframe (a restart on a new commit, or 重新载入).
  const [frameKey, setFrameKey] = useState(0);
  // The iframe has painted its first page; until then the stage shows the launch spinner over it.
  const [frameReady, setFrameReady] = useState(false);
  // The AI sheet on narrow screens.
  const [sheetOpen, setSheetOpen] = useState(false);
  const building = build?.state === 'queued' || build?.state === 'building';
  const projectId = project.id;
  // Opens are sequenced: an answer for an older request never overwrites a newer one.
  const sequence = useRef(0);

  const open = useCallback(async (restart = false) => {
    const ticket = ++sequence.current;
    setView(previous => ({ ...previous, loading: true, error: '' }));
    try {
      const status = await api.studio.apps.open(projectId, restart).then(readApiJson<StudioAppStatus>);
      if (ticket !== sequence.current) return;
      setView({ status, loading: false, error: '' });
      setFrameReady(false);
      setFrameKey(key => key + 1);
    } catch (failure) {
      if (ticket !== sequence.current) return;
      setView(previous => ({ ...previous, loading: false, error: failure instanceof Error ? failure.message : '应用打开失败' }));
    }
  }, [projectId]);

  // The app opens with its 主页; the server restarts it when the repository has a newer commit.
  useEffect(() => { void open(); }, [open]);
  // When the AI finishes building or changing the app, it opens again on the new code and reloads in place.
  const lastState = useRef(build?.state ?? null);
  useEffect(() => {
    const before = lastState.current;
    lastState.current = build?.state ?? null;
    if ((before === 'queued' || before === 'building') && build?.state === 'done') void open();
  }, [build?.state, open]);

  const status = view.status;
  const running = status?.state === 'running' && Boolean(status.url);
  // A first build has nothing to run yet (and a start that failed meanwhile is the half-written app): show progress.
  const firstBuild = building && !running;
  const failedBuild = build?.state === 'failed' && build.error !== CANCELLED;
  const fixMessage = status?.state === 'failed'
    ? `应用在 Studio 里启动失败：${status.error ?? '原因未知'}\n${status.log.slice(-FIX_LOG_LINES).join('\n')}\n请修复，让它能用 npm start 在 PORT 端口启动（按 STUDIO_DESIGN.md 的运行约定）。`
    : '';

  const stage = () => {
    if (firstBuild) {
      return <m.div key="building" className="app-state" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={STAGE_FADE}>
        <StudioTileIcon tone={project.tone} glyph={project.glyph} size={34}>{progress && <StudioBuildProgress progress={progress} />}</StudioTileIcon>
        <strong>{build?.state === 'queued' ? '排队等待开发' : 'AI 正在开发'}</strong>
        <span>{build?.currentTask ?? (build?.total ? `${build.completed} / ${build.total} 步` : '正在规划步骤')}</span>
        {workbenchUrl && <button type="button" className="ios-button tinted" onClick={() => openWorkbench(workbenchUrl)}>查看开发过程</button>}
      </m.div>;
    }
    if (view.error) {
      return <m.div key="error" className="app-state" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={STAGE_FADE}>
        <IconAlertTriangle size={30} strokeWidth={1.6} aria-hidden="true" />
        <strong>打不开这个应用</strong><span>{view.error}</span>
        <button type="button" className="ios-button tinted" onClick={() => void open()}>重试</button>
      </m.div>;
    }
    if (status?.state === 'failed') {
      return <m.div key="failed" className="app-state" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={STAGE_FADE}>
        <IconAlertTriangle size={30} strokeWidth={1.6} aria-hidden="true" />
        <strong>应用没能启动</strong><span>{status.error}</span>
        {status.log.length > 0 && <pre className="app-log mono">{status.log.slice(-FIX_LOG_LINES).join('\n')}</pre>}
        <div className="app-state-actions">
          <button type="button" className="ios-button" onClick={() => void open(true)}>重试</button>
          {build && <button type="button" className="ios-button filled" disabled={building} onClick={() => void onChange(fixMessage)}>让 AI 修复</button>}
        </div>
      </m.div>;
    }
    if (failedBuild && !running) {
      return <m.div key="unfinished" className="app-state" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={STAGE_FADE}>
        <StudioTileIcon tone={project.tone} glyph={project.glyph} size={34} />
        <strong>还没有开发完</strong><span>{build?.error}</span>
        <button type="button" className="ios-button filled" onClick={onContinue}>继续开发</button>
      </m.div>;
    }
    if (running && status?.url) {
      return <m.div key="app" className="app-frame-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={STAGE_FADE}>
        <iframe key={frameKey} className="app-frame" data-ready={frameReady || undefined} src={status.url} title={project.name}
          sandbox={APP_SANDBOX} referrerPolicy="no-referrer" allow="clipboard-write" onLoad={() => setFrameReady(true)} />
        {!frameReady && <div className="app-frame-pending" role="status"><StudioSpinner size={22} label={`正在打开「${project.name}」`} /></div>}
      </m.div>;
    }
    return <m.div key="starting" className="app-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={STAGE_FADE} role="status">
      <StudioSpinner size={24} /><span>正在启动「{project.name}」</span>
    </m.div>;
  };

  const side = <>
    <StudioProjectRecentSessions project={project} onOpenChat={onOpenChat} onShowAll={() => { setSheetOpen(false); onShowSessions(); }} />
    {build && <QuickChange busy={building} onSend={onChange} />}
    {running && <div className="app-side-tools">
      <button type="button" className="app-side-link ios-press" onClick={() => void open(true)}><IconRotateClockwise size={15} aria-hidden="true" />重新启动</button>
      {status?.url && <a className="app-side-link ios-press" href={status.url} target="_blank" rel="noopener noreferrer"><IconExternalLink size={15} aria-hidden="true" />新标签打开</a>}
    </div>}
  </>;

  return <div className="app-home">
    <section className="app-stage" aria-label={project.name}>
      <AnimatePresence initial={false}>
        {running && building && <m.div key="banner" className="app-banner" role="status"
          initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={STAGE_FADE}>
          <StudioSpinner size={14} /><span>AI 正在修改{build?.currentTask ? `：${build.currentTask}` : ''}</span>
          {build?.total ? <small>{build.completed} / {build.total}</small> : null}
          {workbenchUrl && <button type="button" className="app-banner-link" onClick={() => openWorkbench(workbenchUrl)}>查看</button>}
        </m.div>}
      </AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>{stage()}</AnimatePresence>
      {view.loading && running && <div className="app-frame-pending is-overlay" role="status"><StudioSpinner size={22} label="正在重新启动" /></div>}
    </section>

    {sideBySide ? <aside className="app-side" aria-label="AI">{side}</aside> : <>
      <button type="button" className="app-side-fab glass-icon ios-press" aria-label="打开 AI 侧栏" onClick={() => setSheetOpen(true)}>
        <IconSparkles size={20} aria-hidden="true" />{building && <span className="app-side-fab-dot" aria-hidden="true" />}
      </button>
      <AnimatePresence>
        {sheetOpen && <>
          <m.div key="scrim" className="app-sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSheetOpen(false)} />
          <m.aside key="sheet" className="app-side app-sheet" role="dialog" aria-label="AI" aria-modal="true"
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', stiffness: 320, damping: 34 }}>
            <div className="app-sheet-head"><span className="app-sheet-grabber" aria-hidden="true" />
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setSheetOpen(false)}><IconX size={18} aria-hidden="true" /></button></div>
            {side}
          </m.aside>
        </>}
      </AnimatePresence>
    </>}
  </div>;
}

/**
 * Used by StudioPage in an AI-built app's 设置 tab: whether the app is running, and restarting or stopping it.
 */
export function StudioAppRunSettings({ project }: { project: HubProject }) {
  const [status, setStatus] = useState<StudioAppStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useCallback(async () => {
    setStatus(await api.studio.apps.status(project.id).then(readApiJson<StudioAppStatus>).catch(() => null));
  }, [project.id]);
  useEffect(() => { void read(); }, [read]);
  const act = async (action: 'restart' | 'stop') => {
    setBusy(true);
    try {
      setStatus(await (action === 'stop' ? api.studio.apps.stop(project.id) : api.studio.apps.open(project.id, true)).then(readApiJson<StudioAppStatus>));
    } catch { await read(); } finally { setBusy(false); }
  };
  const label = !status ? '正在读取' : status.state === 'running' ? '运行中' : status.state === 'starting' ? '正在启动' : status.state === 'failed' ? '启动失败' : '未运行';
  return <section className="ios-section first" aria-labelledby={`app-run-${project.id}`}>
    <div className="ios-section-header"><h2 id={`app-run-${project.id}`}>应用</h2></div>
    <div className="ios-list">
      <div className="ios-row no-icon">
        <span className="ios-row-body"><strong>运行状态</strong>{status?.state === 'failed' && status.error && <small>{status.error}</small>}</span>
        <span className={`status-badge ${status?.state === 'running' ? 'good' : ''}`}>{label}</span>
      </div>
      <button type="button" className="ios-row action left no-icon" disabled={busy} onClick={() => void act('restart')}>{status?.state === 'running' ? '重新启动' : '启动'}</button>
      {status?.state === 'running' && <button type="button" className="ios-row action left destructive no-icon" disabled={busy} onClick={() => void act('stop')}>停止</button>}
    </div>
  </section>;
}
