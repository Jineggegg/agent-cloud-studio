import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { IconChevronRight, IconTerminal2 } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { StudioBrand, StudioHarnessTask, StudioHarnessTasks } from '@/shared/types';
import { readableErrorMessage } from '@/shared/utils';
import { LaunchMark } from '@/shared/ui/LaunchScreen';
import { StudioBrandMark } from '@/modules/studio/brandIcons';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-project.css';
import '@/modules/studio/studio-harness.css';

// The computer is asked again this often while the app is open and visible (the server shares one scan per few seconds).
const POLL_MS = 5_000;

// Name, muted tone and official mark of each agent.
const AGENTS = {
  claude: { name: 'Claude Code', tone: 'clay', brand: 'claude' },
  codex: { name: 'Codex', tone: 'graphite', brand: 'openai' },
} as const satisfies Record<StudioHarnessTask['provider'], { name: string; tone: string; brand: StudioBrand }>;
const MACHINES: Record<StudioHarnessTask['machine'], string> = { wsl: 'WSL', windows: 'Windows' };

// 刚刚 · 12 分钟 · 1 小时 5 分钟: how long a turn has been running.
function formatElapsed(from: string | null, now: number): string {
  const start = Date.parse(from ?? '');
  if (!Number.isFinite(start)) return '';
  const minutes = Math.max(0, Math.floor((now - start) / 60_000));
  if (minutes < 1) return '刚开始';
  if (minutes < 60) return `已运行 ${minutes} 分钟`;
  return `已运行 ${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
}

// 刚刚 · 5 分钟前 · 14:05: when a quiet session last did something.
function formatAgo(value: string | null, now: number): string {
  const at = Date.parse(value ?? '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// The last folder of a WSL (`~/projects/site`) or Windows (`C:\Users\me\site`) path.
const folderName = (directory: string | null) => directory?.split(/[\\/]/).filter(Boolean).pop() ?? '';

function TaskRow({ task, now }: { task: StudioHarnessTask; now: number }) {
  const agent = AGENTS[task.provider];
  const running = task.state === 'running';
  const when = running ? formatElapsed(task.startedAt, now)
    : `${task.state === 'idle' ? '空闲' : '已完成'}${task.updatedAt ? ` · ${formatAgo(task.updatedAt, now)}` : ''}`;
  const where = [agent.name, MACHINES[task.machine], task.client].filter(Boolean).join(' · ');
  const body = <>
    <span className={`home-icon small tone-${agent.tone} project-session-mark`} data-running={running ? 'true' : undefined} aria-hidden="true">
      <StudioBrandMark brand={agent.brand} size={19} />
    </span>
    <span className="ios-row-body harness-task-body">
      <strong>{task.title}</strong>
      <small>{where}</small>
      {task.summary && <small className="harness-task-summary">{task.summary}</small>}
      {task.directory && <small className="harness-task-folder mono" title={task.directory}>{folderName(task.directory) || task.directory}</small>}
    </span>
    <span className={`harness-task-when ${running ? 'is-running' : ''}`}>
      {running && <span className="status-dot good" aria-hidden="true" />}{when}
    </span>
    {/* Rows without a link keep the chevron's room, so the times line up. */}
    {task.href ? <IconChevronRight size={18} className="chevron" aria-hidden="true" /> : <span className="harness-chevron-room" aria-hidden="true" />}
  </>;
  // Only WSL sessions Studio has indexed open in the workbench; the rest are shown as they are on the computer.
  return task.href
    ? <Link className="ios-row harness-task" to={task.href}>{body}</Link>
    : <div className="ios-row harness-task">{body}</div>;
}

/**
 * Used by StudioPage for the Harness app (/apps/harness), which Studio also opens on launch: Claude Code and Codex as
 * one harness. It starts a new workbench chat with either agent (`onStart`, where the model menu can still switch
 * between them) and lists what both agents are doing on the computer right now — on WSL and on Windows, in the
 * desktop apps, terminals or Studio — then what they finished or left open in the last few hours. `refreshing` is
 * StudioPage's navigation-bar refresh; each new one asks the computer again.
 */
export function StudioHarness({ refreshing = false, onStart }: { refreshing?: boolean; onStart: (provider: 'claude' | 'codex') => Promise<void> }) {
  // The last answer from the computer; null until the first one arrives.
  const [result, setResult] = useState<StudioHarnessTasks | null>(null);
  // A failed poll stays visible (the last list is kept under it) until one succeeds again.
  const [error, setError] = useState('');
  // The agent whose new chat is being opened; blocks a second tap while the workbench loads.
  const [starting, setStarting] = useState<'claude' | 'codex' | null>(null);
  // The clock the elapsed times are measured against, moved on by each poll so they stay current.
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const next = await api.studio.harness.tasks(controller.signal).then(readApiJson<StudioHarnessTasks>);
      setResult(next);
      setError('');
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(readableErrorMessage(failure, '读不到电脑上的任务'));
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      setNow(Date.now());
    }
  }, []);

  // Polls while visible, and at once when the owner comes back to the app.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); inFlight.current?.abort(); };
  }, [load]);

  const wasRefreshing = useRef(refreshing);
  useEffect(() => {
    if (refreshing && !wasRefreshing.current) void load();
    wasRefreshing.current = refreshing;
  }, [refreshing, load]);

  const start = async (provider: 'claude' | 'codex') => {
    setStarting(provider);
    try { await onStart(provider); } finally { setStarting(null); }
  };

  const tasks = result?.tasks ?? [];
  const running = tasks.filter(task => task.state === 'running');
  const recent = tasks.filter(task => task.state !== 'running');
  const count = (machine: StudioHarnessTask['machine']) => running.filter(task => task.machine === machine).length;
  const windowsRead = result?.machines.includes('windows') ?? true;

  return <div className="harness">
    <section className="ios-section first harness-hero" aria-label="概览">
      <div className="harness-hero-mark" aria-hidden="true"><LaunchMark /></div>
      <div className="harness-hero-text">
        <strong>Claude Code + Codex</strong>
        <small>{result === null ? '正在看电脑上的任务…'
          : running.length ? `${running.length} 个任务在跑 · WSL ${count('wsl')} · Windows ${count('windows')}` : '电脑上现在没有在跑的任务'}</small>
      </div>
    </section>

    <section className="ios-section harness-start" aria-label="新会话">
      <div className="harness-start-row">
        {(['claude', 'codex'] as const).map(provider => <button type="button" key={provider} className="project-new-session ios-press" disabled={starting !== null} onClick={() => void start(provider)}>
          <span className="project-new-icon" aria-hidden="true">{starting === provider ? <StudioSpinner size={18} /> : <StudioBrandMark brand={AGENTS[provider].brand} size={20} />}</span>
          <span className="project-new-text"><strong>{AGENTS[provider].name}</strong><small>新会话</small></span>
        </button>)}
        <Link className="project-terminal ios-press" to="/work" aria-label="工作台" title="回到工作台的会话">
          <IconTerminal2 size={20} strokeWidth={1.8} aria-hidden="true" /><span>工作台</span>
        </Link>
      </div>
      <p className="ios-section-footer">一个对话里可以随时在输入框的模型菜单换成另一家的模型。</p>
    </section>

    {error && <p className="studio-feedback error" role="alert">{error}</p>}

    <section className="ios-section" aria-label="正在运行">
      <div className="ios-section-header"><h2>正在运行</h2>{running.length > 0 && <span className="caption">{running.length} 个</span>}</div>
      <div className="ios-list">
        {result === null && <div className="ios-row no-icon" role="status"><StudioSpinner size={16} label="正在读取任务" /></div>}
        {running.map(task => <TaskRow key={task.id} task={task} now={now} />)}
        {result !== null && !running.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>没有在跑的任务。在电脑上或这里开始一个，它会出现在这里。</small></span></div>}
      </div>
    </section>

    {recent.length > 0 && <section className="ios-section" aria-label="最近">
      <div className="ios-section-header"><h2>最近</h2><span className="caption">开着的和刚完成的</span></div>
      <div className="ios-list">{recent.map(task => <TaskRow key={task.id} task={task} now={now} />)}</div>
    </section>}

    <p className="ios-section-footer harness-footer">
      每 5 秒读一次 WSL{windowsRead ? ' 和 Windows' : ''} 里 Claude Code、Codex 自己的会话记录（只读），桌面版、终端和 Studio 里开的都算。
      Studio 记录过的 WSL 会话点开会进工作台{windowsRead ? '；Windows 上的会话只能在电脑上打开' : '；没有找到 Windows 上的 Claude Code 或 Codex'}。
    </p>
  </div>;
}
