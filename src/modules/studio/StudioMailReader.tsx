import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { m } from 'motion/react';
import { AlertTriangle, FileText, ShieldCheck } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { StudioMailAccount, StudioMailMessage, StudioMailMessageDetail } from '@/shared/types';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-mail.css';

const SHEET_SPRING = { type: 'spring', stiffness: 320, damping: 34 } as const;

function fullDate(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  // "10月2日 周五 12:18", with the year only when it is not this year.
  const day = date.toLocaleDateString('zh-CN', { year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
  return `${day} ${date.toLocaleDateString('zh-CN', { weekday: 'short' })} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function initial(name: string) {
  return (Array.from(name.trim())[0] ?? '?').toUpperCase();
}

/**
 * Used by StudioProjectMail to read one message in a sheet. The body is fetched only when the sheet opens and
 * is shown as plain text: no links are opened, no images load, and nothing is sent to a model from here unless
 * the user presses 保存摘要草稿.
 */
export function StudioMailReader({ message, account, summarizing, onSummarize, onClose }: {
  message: StudioMailMessage;
  account: StudioMailAccount | undefined;
  summarizing: boolean;
  onSummarize?: (content: string) => void;
  onClose: () => void;
}) {
  // The opened message's body and recipients; null while it loads.
  const [detail, setDetail] = useState<StudioMailMessageDetail | null>(null);
  // The body could not be read (provider, network, or the message is gone).
  const [error, setError] = useState('');
  const doneButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void api.studio.mail.message(message.accountId, message.id).then(readApiJson<StudioMailMessageDetail>)
      .then(value => { if (active) setDetail(value); })
      .catch(reason => { if (active) setError(reason instanceof Error && reason.message ? reason.message : '邮件读取失败'); });
    return () => { active = false; };
  }, [message.accountId, message.id]);

  useEffect(() => {
    // Focus starts on 完成 and returns to the tapped row when the sheet closes.
    const previous = document.activeElement as HTMLElement | null;
    doneButton.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // The list row is the reliable header source (legacy OAuth details carry no headers of their own).
  const sender = message.from || message.fromAddress || '未知发件人';
  const date = fullDate(message.date);
  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <m.div className="sheet-scrim" aria-hidden="true" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
    <m.div className="mail-reader" role="dialog" aria-modal="true" aria-labelledby="mail-reader-title"
      initial={{ opacity: 0, y: 56, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 40, transition: { duration: 0.2 } }} transition={SHEET_SPRING}>
      <header>
        <span className="mail-reader-account">{account ? account.email : ''}</span>
        <span className="mail-reader-actions">
          {onSummarize && <button type="button" className="ios-button tinted" disabled={!detail || summarizing}
            onClick={() => { if (detail) onSummarize(`${message.subject}\n${sender} ${message.fromAddress}\n${message.date}\n\n${detail.text}`); }}>
            {summarizing ? <StudioSpinner size={15} /> : <FileText size={16} aria-hidden="true" />}保存摘要草稿
          </button>}
          <button ref={doneButton} type="button" className="ios-button filled" onClick={onClose}>完成</button>
        </span>
      </header>
      <div className="mail-reader-scroll">
        <h2 id="mail-reader-title">{message.subject || '（无主题）'}</h2>
        <div className="mail-reader-meta">
          <span className="mail-avatar" aria-hidden="true">{initial(sender)}</span>
          <div>
            <strong>{sender}</strong>
            {message.fromAddress && message.fromAddress !== sender && <small>{message.fromAddress}</small>}
            {detail?.to && <small>收件人：{detail.to}</small>}
          </div>
          {date && <time dateTime={message.date}>{date}</time>}
        </div>
        {!detail && !error && <div className="mail-reader-state" role="status"><StudioSpinner size={24} />正在读取邮件…</div>}
        {error && <div className="mail-reader-state" role="alert"><AlertTriangle size={26} strokeWidth={1.6} aria-hidden="true" />{error}</div>}
        {detail && <m.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
          <div className="mail-reader-text">{detail.text || '（这封邮件没有可显示的文字内容）'}</div>
          {detail.truncated && <p className="mail-reader-truncated">邮件较长，这里只显示前面部分；完整内容请在邮箱应用中查看。</p>}
        </m.div>}
        <p className="mail-reader-boundary"><ShieldCheck size={14} aria-hidden="true" />邮件是外部资料：这里只显示纯文本，不打开链接、不加载图片，也不会自动发给 AI。打开邮件不会把它标记为已读。</p>
      </div>
    </m.div>
  </div>, document.body);
}
