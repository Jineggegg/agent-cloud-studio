import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Copy, MessageSquare, Square, LoaderCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { StudioConversation } from '@/shared/types';

/** Used by StudioPage for persisted API conversations, explicit context sharing and request cancellation. */
export function StudioChat({ active, models, sending, onSend, onStop }: {
  active: StudioConversation | null; models: string[]; sending: boolean;
  onSend: (text: string, model: string, includeSnr: boolean) => Promise<boolean>;
  onStop: () => void;
}) {
  // Draft text stays on this device and is never sent without submission.
  const [draft, setDraft] = useState('');
  // New conversations choose a model; existing ones preserve their original model.
  const [model, setModel] = useState('deepseek-flash');
  // Sharing SNR's health summary is an explicit per-message opt-in.
  const [includeSnr, setIncludeSnr] = useState(false);
  // Clipboard feedback identifies which reply was copied successfully.
  const [copied, setCopied] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [active?.messages?.length, sending]);
  const submit = async () => {
    const text = draft;
    setDraft('');
    if (!await onSend(text, active?.model ?? model, includeSnr)) setDraft(text);
  };
  return <section className="studio-chat" aria-label="DeepSeek 对话">
    <div className="studio-chat-toolbar">
      <span className="studio-provider"><span className="provider-dot" />DeepSeek</span>
      <select aria-label="对话模型" value={active?.model ?? model} disabled={sending || Boolean(active)} onChange={event => setModel(event.target.value)}>
        {models.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    <div className="studio-transcript" aria-live="polite" aria-busy={sending}>
      {!active?.messages?.length && <div className="studio-chat-empty"><MessageSquare size={30} /><h2>开始一条新对话</h2><p>DeepSeek</p></div>}
      {active?.messages?.map(message => <article className={`studio-message ${message.role} ${message.status === 'error' ? 'failed' : ''}`} key={message.id}>
        <header>{message.role === 'user' ? '你' : 'DeepSeek'}
          {message.role === 'assistant' && message.status !== 'error' && <button className="icon-button" aria-label="复制回复" title="复制回复" onClick={async () => {
            try { await navigator.clipboard.writeText(message.content); setCopied(message.id); } catch { setCopied(null); }
          }}>{copied === message.id ? <Check size={16} /> : <Copy size={16} />}</button>}
        </header>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </article>)}
      {sending && <div className="studio-reply-pending"><LoaderCircle size={16} className="spin" />正在回复</div>}
      <div ref={bottom} />
    </div>
    <form className="studio-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea aria-label="消息" placeholder="输入消息..." rows={3} maxLength={16000} value={draft} disabled={sending}
        onChange={event => setDraft(event.target.value)} />
      <div className="studio-composer-actions">
        <label className="studio-check"><input type="checkbox" checked={includeSnr} disabled={sending} onChange={event => setIncludeSnr(event.target.checked)} />附上 SNR 状态</label>
        {sending ? <button type="button" className="icon-button primary" title="停止回复" aria-label="停止回复" onClick={onStop}><Square size={18} /></button>
          : <button className="icon-button primary" title="发送消息" aria-label="发送消息" disabled={!draft.trim()}><ArrowUp size={20} /></button>}
      </div>
    </form>
  </section>;
}
