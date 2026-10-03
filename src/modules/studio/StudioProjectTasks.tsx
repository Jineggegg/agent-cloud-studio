import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { toast } from 'sonner';

import { IconAlertTriangle, IconBell, IconMail, IconPencil, IconPlayerPlay, IconSparkles, IconTrash } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type {
  HubAutomation, HubAutomationAction, HubAutomationInput, HubAutomationPlan, HubAutomationRun, HubAutomationTrigger, HubProject, StudioMailAccount, StudioMailAccounts,
} from '@/shared/types';
import { StudioAgentDrafts } from '@/modules/studio/StudioAgentDrafts';
import { StudioAutomationForm } from '@/modules/studio/StudioAutomationForm';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioPushBanner } from '@/modules/studio/StudioPushBanner';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-automations.css';

// The automation under review: a plan from the owner's words (create) or an existing automation (edit).
type Review = { mode: 'create'; draft: HubAutomationInput; notes: string[] } | { mode: 'edit'; id: string; draft: HubAutomationInput };

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const RUN_STATUS: Record<HubAutomationRun['status'], string> = { notified: '已通知', quiet: '无需通知', skipped: '未发出', error: '出错' };
const NOTIFY_WHEN = { important: '有重要邮件时通知', new: '有新邮件就通知', always: '每次都发摘要' } as const;

function message(failure: unknown, fallback: string) {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

function describeTrigger(trigger: HubAutomationTrigger, localZone: string) {
  if (trigger.kind === 'event') return '这个项目的 AI 开发失败时';
  const zone = trigger.timeZone !== localZone ? `（${trigger.timeZone}）` : '';
  if (trigger.repeat === 'hourly') return `每小时第 ${Number(trigger.time.slice(3))} 分${zone}`;
  if (trigger.repeat === 'once') {
    const [, month, day] = (trigger.date ?? '').split('-').map(Number);
    return `${month}月${day}日 ${trigger.time}（一次）${zone}`;
  }
  const days = trigger.repeat === 'daily' ? '每天' : trigger.repeat === 'weekdays' ? '工作日' : `每${WEEKDAYS[trigger.weekday ?? 1]}`;
  return `${days} ${trigger.time}${zone}`;
}

function describeAction(action: HubAutomationAction, accounts: StudioMailAccount[]) {
  if (action.kind === 'notify') return `通知：${action.message}`;
  const mailbox = accounts.find(account => account.id === action.accountId)?.email ?? '已移除的邮箱';
  const topic = action.query ? ` 里「${action.query.replace(/^from:/, '')}」相关` : ' ';
  return `读取 ${mailbox}${topic}的新邮件 · ${NOTIFY_WHEN[action.notifyWhen]}`;
}

// iOS-style moment: 今天 08:00, 明天 08:00, 昨天 08:00, else 10月6日 08:00.
function moment(value: string) {
  const date = new Date(value);
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((date.getTime() - midnight.getTime()) / 86_400_000);
  const day = days === 0 ? '今天' : days === 1 ? '明天' : days === -1 ? '昨天' : `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${day} ${clock}`;
}

function inputOf(automation: HubAutomation): HubAutomationInput {
  return { title: automation.title, prompt: automation.prompt, trigger: automation.trigger, action: automation.action };
}

/**
 * Used by StudioPage as a project's 自动化 tab: the owner says in plain words what to automate, reviews what Studio
 * understood, and manages the project's automations (on/off, next and last run, run now, edit, delete). A check at
 * the top says whether notifications reach this device. Older agent instruction drafts stay folded below.
 */
export function StudioProjectTasks({ project }: { project: HubProject }) {
  const formId = useId();
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The project's automations; null until the first load answers.
  const [automations, setAutomations] = useState<HubAutomation[] | null>(null);
  // The owner's connected mailboxes, for choosing and naming the mailbox of a mail digest.
  const [accounts, setAccounts] = useState<StudioMailAccount[]>([]);
  // What the owner typed into the plain-words box.
  const [text, setText] = useState('');
  // The automation being reviewed before it is created or saved; null when none.
  const [review, setReview] = useState<Review | null>(null);
  // Locks the box and the review form while the server plans or saves.
  const [busy, setBusy] = useState(false);
  // Why planning failed, shown under the box (e.g. a request that would act outside Studio).
  const [planError, setPlanError] = useState('');
  // Why saving the reviewed automation failed, shown in its form.
  const [saveError, setSaveError] = useState('');
  // Automations with a request in flight (switch, run now), so their controls wait.
  const [pending, setPending] = useState<string[]>([]);
  // An automation awaiting delete confirmation.
  const [deleting, setDeleting] = useState<HubAutomation | null>(null);
  // The folded agent drafts load only once the owner opens them.
  const [draftsOpen, setDraftsOpen] = useState(false);

  const examples = [
    `每天早上读一下我邮箱里${project.name}相关的邮件，有重要的就通知我`,
    '这个项目构建失败时给我发通知',
    '每周一上午 9 点提醒我写周报',
  ];

  useEffect(() => {
    let active = true;
    void api.studio.automations.list(project.id).then(readApiJson<HubAutomation[]>)
      .then(value => { if (active) setAutomations(value); })
      .catch(failure => {
        if (!active) return;
        setAutomations(previous => previous ?? []);
        toast.error(message(failure, '自动化加载失败'));
      });
    void api.studio.mail.accounts().then(readApiJson<StudioMailAccounts>).then(value => { if (active) setAccounts(value.accounts); }).catch(() => {});
    return () => { active = false; };
  }, [project.id]);

  const replace = (updated: HubAutomation) => setAutomations(previous => previous?.map(item => item.id === updated.id ? updated : item) ?? [updated]);
  async function withPending(id: string, work: () => Promise<void>) {
    setPending(previous => [...previous, id]);
    try { await work(); } finally { setPending(previous => previous.filter(item => item !== id)); }
  }

  async function plan(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setPlanError(''); setSaveError('');
    try {
      const planned = await api.studio.automations.plan(project.id, text.trim(), localZone).then(readApiJson<HubAutomationPlan>);
      setReview({ mode: 'create', draft: planned.draft, notes: planned.notes });
    } catch (failure) { setPlanError(message(failure, '没能理解这句话，请换个说法')); }
    finally { setBusy(false); }
  }

  async function save(input: HubAutomationInput) {
    if (!review) return;
    setBusy(true); setSaveError('');
    try {
      if (review.mode === 'create') {
        const created = await api.studio.automations.create(project.id, input).then(readApiJson<HubAutomation>);
        setAutomations(previous => [...(previous ?? []), created]);
        setText('');
        toast.success(`已创建「${created.title}」`);
      } else {
        replace(await api.studio.automations.update(review.id, input).then(readApiJson<HubAutomation>));
        toast.success('已保存');
      }
      setReview(null);
    } catch (failure) { setSaveError(message(failure, '保存失败')); }
    finally { setBusy(false); }
  }

  const toggle = (automation: HubAutomation, enabled: boolean) => withPending(automation.id, async () => {
    try { replace(await api.studio.automations.setEnabled(automation.id, enabled).then(readApiJson<HubAutomation>)); }
    catch (failure) { toast.error(message(failure, '没能切换')); }
  });
  const runNow = (automation: HubAutomation) => withPending(automation.id, async () => {
    try {
      const ran = await api.studio.automations.run(automation.id).then(readApiJson<HubAutomation>);
      replace(ran);
      if (ran.lastRun) toast(`${RUN_STATUS[ran.lastRun.status]}：${ran.lastRun.summary.slice(0, 80)}`);
    } catch (failure) { toast.error(message(failure, '运行失败')); }
  });
  async function remove(automation: HubAutomation) {
    try {
      await api.studio.automations.remove(automation.id).then(readApiJson);
      setAutomations(previous => previous?.filter(item => item.id !== automation.id) ?? []);
      if (review?.mode === 'edit' && review.id === automation.id) setReview(null);
    } catch (failure) { toast.error(message(failure, '删除失败')); }
  }

  return <section className="automation-tab">
    <StudioPushBanner />

    <form className="automation-composer" onSubmit={event => void plan(event)}>
      <div className="ios-section-header"><h2 id={`${formId}-ask`}>想自动化什么</h2><span className="caption">用一句话告诉 AI</span></div>
      <div className="ios-list">
        <textarea className="automation-prompt" aria-labelledby={`${formId}-ask`} rows={3} maxLength={500} disabled={busy} value={text}
          placeholder={`比如：${examples[0]}`} onChange={event => setText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void plan(event); }} />
      </div>
      <div className="automation-examples" aria-label="示例">
        {examples.map(example => <button type="button" key={example} className="automation-example" disabled={busy} onClick={() => setText(example)}>{example}</button>)}
      </div>
      {planError && <p role="alert" className="studio-feedback error">{planError}</p>}
      <div className="automation-composer-actions">
        <button type="submit" className="ios-button filled" disabled={busy || !text.trim()}>
          {busy && !review ? <StudioSpinner size={16} /> : <IconSparkles size={17} aria-hidden="true" />}生成自动化</button>
      </div>
    </form>

    {review && <StudioAutomationForm key={review.mode === 'edit' ? review.id : review.draft.prompt} draft={review.draft}
      notes={review.mode === 'create' ? review.notes : []} accounts={accounts}
      heading={review.mode === 'create' ? '确认自动化' : '编辑自动化'} submitLabel={review.mode === 'create' ? '创建' : '保存'}
      busy={busy} error={saveError} onSubmit={input => void save(input)} onCancel={() => { setReview(null); setSaveError(''); }} />}

    <div className="studio-section-heading"><h2>自动化</h2><span>{automations?.length ?? ''}</span></div>
    {automations === null
      ? <div className="studio-skeleton" role="status" aria-label="正在加载自动化"><div className="skeleton-block" style={{ height: 72 }} /></div>
      : automations.length === 0
        ? <p className="hub-status">还没有自动化。在上面用一句话说想让 Studio 做什么，确认后就会按时运行。</p>
        : <ul className="automation-list" aria-label="自动化列表">
          {automations.map(automation => {
            const waiting = pending.includes(automation.id);
            const Icon = automation.trigger.kind === 'event' ? IconAlertTriangle : automation.action.kind === 'mail-digest' ? IconMail : IconBell;
            return <li key={automation.id} className={`automation-row ${automation.enabled ? '' : 'is-off'}`}>
              <span className="automation-icon" aria-hidden="true"><Icon size={18} /></span>
              <div className="automation-body">
                <strong>{automation.title}</strong>
                <small>{describeTrigger(automation.trigger, localZone)} · {describeAction(automation.action, accounts)}</small>
                <small className="automation-times">
                  {automation.enabled ? automation.nextRunAt ? `下次 ${moment(automation.nextRunAt)}` : automation.trigger.kind === 'event' ? '等待触发' : '' : '已关闭'}
                  {automation.lastRun && ` · 上次 ${moment(automation.lastRun.at)} ${RUN_STATUS[automation.lastRun.status]}`}
                </small>
                {automation.lastRun?.summary && <p className={`automation-last is-${automation.lastRun.status}`}>{automation.lastRun.summary}</p>}
              </div>
              <div className="automation-controls">
                <input type="checkbox" role="switch" className="ios-switch" aria-label={`启用「${automation.title}」`} checked={automation.enabled}
                  disabled={waiting} onChange={event => void toggle(automation, event.target.checked)} />
                <div className="automation-actions">
                  <button type="button" className="icon-button" aria-label={`立即运行「${automation.title}」`} title="立即运行" disabled={waiting} onClick={() => void runNow(automation)}>
                    {waiting ? <StudioSpinner size={16} /> : <IconPlayerPlay size={18} aria-hidden="true" />}</button>
                  <button type="button" className="icon-button" aria-label={`编辑「${automation.title}」`} title="编辑" disabled={waiting}
                    onClick={() => { setSaveError(''); setReview({ mode: 'edit', id: automation.id, draft: inputOf(automation) }); }}><IconPencil size={18} aria-hidden="true" /></button>
                  <button type="button" className="icon-button danger" aria-label={`删除「${automation.title}」`} title="删除" disabled={waiting} onClick={() => setDeleting(automation)}>
                    <IconTrash size={18} aria-hidden="true" /></button>
                </div>
              </div>
            </li>;
          })}
        </ul>}

    <details className="automation-advanced" onToggle={event => setDraftsOpen(event.currentTarget.open)}>
      <summary>发给 AI 助手的指令</summary>
      <p className="hub-status">保存给 Claude Code、Codex 等助手的指令草稿，并安排在某个会话里执行一次。</p>
      {draftsOpen && <StudioAgentDrafts project={project} />}
    </details>

    {deleting && <StudioConfirmSheet title={`删除「${deleting.title}」？`} message="删除后它不会再运行，这个操作无法撤销。" confirmLabel="删除"
      onCancel={() => setDeleting(null)} onConfirm={() => { const target = deleting; setDeleting(null); void remove(target); }} />}
  </section>;
}
