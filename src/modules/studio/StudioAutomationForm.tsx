import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import type { HubAutomationInput, HubAutomationNotifyWhen, HubAutomationRepeat, HubAutomationTrigger, StudioMailAccount } from '@/shared/types';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

type ScheduleTrigger = Extract<HubAutomationTrigger, { kind: 'schedule' }>;

const REPEATS: { id: HubAutomationRepeat; label: string }[] = [
  { id: 'once', label: '一次' }, { id: 'hourly', label: '每小时' }, { id: 'daily', label: '每天' }, { id: 'weekdays', label: '工作日' }, { id: 'weekly', label: '每周' },
];
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const NOTIFY_WHEN: { id: HubAutomationNotifyWhen; label: string }[] = [
  { id: 'important', label: '重要邮件' }, { id: 'new', label: '有新邮件' }, { id: 'always', label: '每次都发' },
];
const MINUTES = Array.from({ length: 12 }, (_, index) => String(index * 5).padStart(2, '0'));

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Switching how often keeps what still makes sense: the clock time (hourly keeps only its minute).
function withRepeat(trigger: ScheduleTrigger, repeat: HubAutomationRepeat): ScheduleTrigger {
  const time = repeat === 'hourly' ? `00:${trigger.time.slice(3)}` : trigger.repeat === 'hourly' ? '08:00' : trigger.time;
  return { ...trigger, repeat, time, weekday: repeat === 'weekly' ? trigger.weekday ?? 1 : null, date: repeat === 'once' ? trigger.date ?? today() : null };
}

/**
 * Used by the 自动化 tab (StudioProjectTasks) to review an automation planned from the owner's words before it is
 * created, and to edit one later: name, when it runs, and what it does (mailbox, keywords, when to notify, or the
 * notification text). Nothing is stored until the owner confirms.
 */
export function StudioAutomationForm({ draft, notes = [], accounts, heading, submitLabel, busy, error, onSubmit, onCancel }: {
  draft: HubAutomationInput; notes?: string[]; accounts: StudioMailAccount[]; heading: string; submitLabel: string; busy: boolean; error: string;
  onSubmit: (input: HubAutomationInput) => void; onCancel: () => void;
}) {
  const formId = useId();
  // The automation as edited so far; sent only on submit.
  const [form, setForm] = useState<HubAutomationInput>(draft);
  const trigger = form.trigger;
  const action = form.action;
  const setTrigger = (patch: Partial<ScheduleTrigger>) => { if (trigger.kind === 'schedule') setForm({ ...form, trigger: { ...trigger, ...patch } }); };
  const mailMissing = action.kind === 'mail-digest' && !accounts.some(account => account.id === action.accountId);
  const ready = Boolean(form.title.trim()) && !mailMissing && (action.kind !== 'notify' || Boolean(action.message.trim()));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (ready) onSubmit({ ...form, title: form.title.trim() });
  }

  return <form className="automation-form" onSubmit={submit} aria-label={heading}>
    <header className="automation-form-head">
      <h3>{heading}</h3>
      {form.prompt && <p>你说的：“{form.prompt}”</p>}
    </header>
    <fieldset disabled={busy}>
      <div className="ios-list">
        <div className="ios-field"><label htmlFor={`${formId}-title`}>名称</label>
          <input id={`${formId}-title`} required maxLength={40} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></div>
      </div>

      <h4 className="automation-form-label">什么时候</h4>
      <div className="ios-list">
        {trigger.kind === 'event'
          ? <div className="ios-field"><span className="automation-form-static">这个项目的 AI 开发失败时</span></div>
          : <>
            <div className="ios-field automation-repeat"><span className="automation-form-key" id={`${formId}-repeat`}>重复</span>
              <div className="segmented small" role="radiogroup" aria-labelledby={`${formId}-repeat`}>
                {REPEATS.map(item => <button type="button" role="radio" key={item.id} aria-checked={trigger.repeat === item.id}
                  onClick={() => setForm({ ...form, trigger: withRepeat(trigger, item.id) })}>{item.label}</button>)}
              </div></div>
            {trigger.repeat === 'once' && <div className="ios-field"><label htmlFor={`${formId}-date`}>日期</label>
              <input id={`${formId}-date`} type="date" required value={trigger.date ?? ''} onChange={event => setTrigger({ date: event.target.value })} /></div>}
            {trigger.repeat === 'weekly' && <div className="ios-field"><label htmlFor={`${formId}-weekday`}>星期</label>
              <select id={`${formId}-weekday`} value={trigger.weekday ?? 1} onChange={event => setTrigger({ weekday: Number(event.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 0].map(day => <option key={day} value={day}>{WEEKDAYS[day]}</option>)}
              </select></div>}
            {trigger.repeat === 'hourly'
              ? <div className="ios-field"><label htmlFor={`${formId}-minute`}>分钟</label>
                <select id={`${formId}-minute`} value={trigger.time.slice(3)} onChange={event => setTrigger({ time: `00:${event.target.value}` })}>
                  {[...new Set([...MINUTES, trigger.time.slice(3)])].sort().map(minute => <option key={minute} value={minute}>每小时第 {Number(minute)} 分</option>)}
                </select></div>
              : <div className="ios-field"><label htmlFor={`${formId}-time`}>时间</label>
                <input id={`${formId}-time`} type="time" required value={trigger.time} onChange={event => setTrigger({ time: event.target.value })} /></div>}
          </>}
      </div>

      <h4 className="automation-form-label">做什么</h4>
      {action.kind === 'mail-digest' ? <div className="ios-list">
        <div className="ios-field"><label htmlFor={`${formId}-mailbox`}>邮箱</label>
          <select id={`${formId}-mailbox`} required value={mailMissing ? '' : action.accountId}
            onChange={event => setForm({ ...form, action: { ...action, accountId: event.target.value } })}>
            <option value="" disabled>{accounts.length ? '选择邮箱' : '还没有连接邮箱'}</option>
            {accounts.map(account => <option key={account.id} value={account.id}>{account.email}</option>)}
          </select></div>
        <div className="ios-field"><label htmlFor={`${formId}-query`}>关键词</label>
          <input id={`${formId}-query`} maxLength={60} placeholder="留空就读所有新邮件" value={action.query}
            onChange={event => setForm({ ...form, action: { ...action, query: event.target.value } })} /></div>
        <div className="ios-field automation-repeat"><span className="automation-form-key" id={`${formId}-when`}>通知</span>
          <div className="segmented small" role="radiogroup" aria-labelledby={`${formId}-when`}>
            {NOTIFY_WHEN.map(item => <button type="button" role="radio" key={item.id} aria-checked={action.notifyWhen === item.id}
              onClick={() => setForm({ ...form, action: { ...action, notifyWhen: item.id } })}>{item.label}</button>)}
          </div></div>
        <label className="ios-row no-icon switch-row">
          <span className="ios-row-body"><strong>用 DeepSeek 判断和总结</strong><small>只发送发件人、主题和预览，不发送正文</small></span>
          <input type="checkbox" role="switch" className="ios-switch" checked={action.useAi}
            onChange={event => setForm({ ...form, action: { ...action, useAi: event.target.checked } })} />
        </label>
      </div> : <div className="ios-list">
        <div className="ios-field"><label htmlFor={`${formId}-message`}>通知内容</label>
          <input id={`${formId}-message`} required maxLength={120} value={action.message}
            onChange={event => setForm({ ...form, action: { ...action, message: event.target.value } })} /></div>
      </div>}
      <p className="ios-section-footer">{action.kind === 'mail-digest'
        ? '只读取这个邮箱，不会回复、转发、删除或标记已读；总结和提醒只发给你自己。'
        : '通知只推送到你开启了通知的设备。'}</p>
      {notes.length > 0 && <ul className="automation-notes">{notes.map(note => <li key={note}>{note}</li>)}</ul>}
    </fieldset>
    {error && <p role="alert" className="studio-feedback error">{error}</p>}
    <div className="project-form-actions">
      <button className="ios-button" type="button" disabled={busy} onClick={onCancel}>取消</button>
      <button className="ios-button filled" type="submit" disabled={busy || !ready}>{busy && <StudioSpinner size={16} />}{submitLabel}</button>
    </div>
  </form>;
}
