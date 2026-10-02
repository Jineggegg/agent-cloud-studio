import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Save, X } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { HubProject, HubSession, HubTask, HubTaskInput, ScheduledMessage } from '@/shared/types';

/** Used by StudioProjectPage for automation drafts and explicit one-time scheduling to existing, project-matched agent sessions. */
export function StudioProjectTasks({ project }: { project: HubProject }) {
  // Stored drafts and existing sessions are reloaded after each confirmed operation.
  const [tasks, setTasks] = useState<HubTask[]>([]);
  // Session choices are confined to the owning project and enabled providers.
  const [sessions, setSessions] = useState<HubSession[]>([]);
  // Pending jobs come from the existing scheduler, not optimistic local labels.
  const [scheduled, setScheduled] = useState<ScheduledMessage[]>([]);
  // Task edits are not persisted until the user saves the draft.
  const [form, setForm] = useState<HubTaskInput>({ title: '', prompt: '', provider: project.providers[0] });
  // Retains the selected saved task while editing.
  const [editing, setEditing] = useState<string | undefined>();
  // Scheduling is a separate review step from saving instructions.
  const [review, setReview] = useState<HubTask | null>(null);
  // The user selects an existing native session and an explicit future time.
  const [targetSession, setTargetSession] = useState('');
  // Local datetime input is converted to an absolute instant on submission.
  const [when, setWhen] = useState('');
  // Blocks duplicate saves and scheduling requests.
  const [busy, setBusy] = useState(false);
  // Displays failures and confirms draft-only versus scheduled outcomes.
  const [feedback, setFeedback] = useState('');
  const load = useCallback(async () => {
    const [drafts, nativeSessions, jobs] = await Promise.all([
      api.studio.projects.tasks(project.id).then(readApiJson<HubTask[]>),
      api.studio.projects.sessions(project.id).then(readApiJson<HubSession[]>),
      api.scheduledMessages.list().then(readApiJson<{ data: ScheduledMessage[] }>),
    ]);
    setTasks(drafts); setSessions(nativeSessions);
    setScheduled(jobs.data.filter(job => nativeSessions.some(session => session.id === job.sessionId)));
  }, [project.id]);
  useEffect(() => {
    void load().catch(reason => setFeedback(reason instanceof Error ? reason.message : '任务加载失败'));
  }, [load]);
  async function operate(action: () => Promise<void>) {
    setBusy(true); setFeedback('');
    try { await action(); await load(); }
    catch (reason) { setFeedback(reason instanceof Error ? reason.message : '任务操作失败'); }
    finally { setBusy(false); }
  }
  const save = () => operate(async () => {
    await readApiJson(await api.studio.projects.saveTask(project.id, form, editing));
    setEditing(undefined); setForm({ title: '', prompt: '', provider: project.providers[0] });
    setFeedback('草稿已保存，尚未执行');
  });
  const schedule = () => operate(async () => {
    if (!review) return;
    await readApiJson(await api.studio.projects.scheduleTask(project.id, review.id, targetSession, new Date(when).toISOString()));
    setReview(null); setTargetSession(''); setWhen('');
    setFeedback('已安排一次执行');
  });
  return <section>
    {feedback && <p className="hub-status" role="status">{feedback}</p>}
    <div className="studio-section-heading"><h2>自动化草稿</h2><span>{tasks.length}</span></div>
    {tasks.map(task => <div className="hub-task-row" key={task.id}>
      <button className="hub-task-title" onClick={() => { setForm({ title: task.title, prompt: task.prompt, provider: task.provider }); setEditing(task.id); }}><strong>{task.title}</strong><small>{task.provider === 'claude' ? 'Claude' : 'GPT / Codex'} · 草稿</small></button>
      <button className="icon-button" aria-label={`安排 ${task.title}`} title="安排一次执行" disabled={busy || !project.modules.includes('agents') || !sessions.some(session => session.provider === task.provider)}
        onClick={() => { setReview(task); setTargetSession(''); setWhen(''); }}><CalendarClock size={19} /></button>
    </div>)}
    {!tasks.length && <p className="hub-status">暂无草稿</p>}
    {review && <form className="hub-form hub-schedule-review" onSubmit={event => { event.preventDefault(); void schedule(); }}>
      <header><h3>{review.title}</h3><button type="button" className="icon-button" aria-label="关闭安排" title="关闭安排" onClick={() => setReview(null)}><X size={19} /></button></header>
      <pre>{review.prompt}</pre>
      <label>执行会话<select required value={targetSession} onChange={event => setTargetSession(event.target.value)}><option value="">选择会话</option>{sessions.filter(session => session.provider === review.provider).map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
      <label>执行时间（{Intl.DateTimeFormat().resolvedOptions().timeZone}）<input required type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} /></label>
      <button type="submit" disabled={busy} className="command-button primary"><CalendarClock size={17} />确认安排一次执行</button>
    </form>}
    <form className="hub-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3>{editing ? '编辑草稿' : '新建草稿'}</h3>
      <label>名称<input required maxLength={120} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
      <label>助手<select value={form.provider} onChange={event => setForm({ ...form, provider: event.target.value as 'claude' | 'codex' })}>{project.providers.map(provider => <option key={provider} value={provider}>{provider === 'claude' ? 'Claude' : 'GPT / Codex'}</option>)}</select></label>
      <div className="hub-field"><label htmlFor={`task-prompt-${project.id}`}>任务指令</label><textarea id={`task-prompt-${project.id}`} required rows={6} maxLength={16000} value={form.prompt} onChange={event => setForm({ ...form, prompt: event.target.value })} /></div>
      <div className="hub-actions"><button type="submit" disabled={busy} className="command-button primary"><Save size={17} />保存草稿</button>
        {editing && <button className="command-button" type="button" onClick={() => { setEditing(undefined); setForm({ title: '', prompt: '', provider: project.providers[0] }); }}>取消编辑</button>}</div>
    </form>
    <div className="studio-section-heading"><h2>已安排的任务</h2><span>{scheduled.length}</span></div>
    {scheduled.map(job => <div key={job.id} className="hub-task-row"><div><strong>{job.content.slice(0, 60)}</strong><small>{new Date(job.scheduledFor).toLocaleString('zh-CN')} · {job.status === 'pending' ? '待执行' : job.status === 'failed' ? '失败' : job.status}</small>{job.failureReason && <p className="error">{job.failureReason}</p>}</div>
      <button type="button" className="icon-button" aria-label="取消已安排任务" title="取消已安排任务" disabled={busy} onClick={() => {
        if (window.confirm('取消这次已安排的执行？')) void operate(async () => { await readApiJson(await api.scheduledMessages.cancel(job.id)); });
      }}><X size={18} /></button>
    </div>)}
    {!scheduled.length && <p className="hub-status">暂无待执行任务</p>}
  </section>;
}
