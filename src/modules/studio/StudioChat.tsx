import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowUp, Check, Copy, MessagesSquare, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { StudioConversation } from '@/shared/types';

// The composer grows with its text up to roughly seven lines, then scrolls.
const COMPOSER_MAX_HEIGHT = 168;
// Safari ends IME composition just before the confirming Enter keydown arrives.
const IME_RACE_WINDOW_MS = 30;
// Copy confirmation reverts to the copy icon after this delay.
const COPIED_FEEDBACK_MS = 1600;

/** Used by StudioPage for persisted API conversations, explicit context sharing and request cancellation. */
export function StudioChat({ assistant = 'DeepSeek', tone = 'slate', active, models, sending, onSend, onStop }: {
  // Name of the chat app persona, e.g. 超级教授; the model provider is shown separately.
  assistant?: string;
  // Icon colour family of the owning home-screen app.
  tone?: string;
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
  const textarea = useRef<HTMLTextAreaElement>(null);
  const shownConversation = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);

  useEffect(() => {
    // Jump when switching conversations; glide when a message is appended.
    const switched = shownConversation.current !== active?.id;
    shownConversation.current = active?.id;
    bottom.current?.scrollIntoView({ behavior: switched ? 'instant' : 'smooth', block: 'end' });
  }, [active?.id, active?.messages?.length, sending]);

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const submit = async () => {
    const text = draft;
    if (!text.trim() || sending) return;
    setDraft('');
    if (!await onSend(text, active?.model ?? model, includeSnr)) setDraft(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Hardware keyboards send with Enter; touch keyboards keep Enter as a newline.
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    const imeActive = composing.current || event.nativeEvent.isComposing || event.keyCode === 229
      || performance.now() - compositionEndedAt.current < IME_RACE_WINDOW_MS;
    if (imeActive) return;
    event.preventDefault();
    void submit();
  };
  const copy = async (id: number, content: string) => {
    try { await navigator.clipboard.writeText(content); setCopied(id); } catch { setCopied(null); }
  };
  const activeModel = active?.model ?? model;

  return <section className="studio-chat" aria-label={`${assistant} 对话`}>
    <div className="studio-transcript" aria-live="polite" aria-busy={sending}>
      {!active?.messages?.length && !sending && <div className="studio-chat-empty">
        <span className={`home-icon large tone-${tone}`} aria-hidden="true"><MessagesSquare size={30} strokeWidth={1.6} /></span>
        <h2>开始一条新对话</h2>
        <p>{assistant} · {activeModel}</p>
      </div>}
      {active?.messages?.map(message => <article className={`studio-message ${message.role} ${message.status === 'error' ? 'failed' : ''}`} key={message.id}>
        {message.role === 'assistant' && <div className="message-meta">
          <span>{assistant}</span><span className="model-tag">{active.model}</span>
          {message.status !== 'error' && <button type="button" className="icon-button plain" aria-label="复制回复" title="复制回复" onClick={() => void copy(message.id, message.content)}>
            {copied === message.id ? <Check size={16} className="copied-pop" /> : <Copy size={16} />}
          </button>}
        </div>}
        {message.role === 'user' && <span className="studio-visually-hidden">你：</span>}
        <div className="bubble"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
      </article>)}
      {sending && <div className="studio-typing-wrap"><div className="studio-typing" role="status" aria-label="正在回复"><span /><span /><span /></div></div>}
      <div ref={bottom} />
    </div>
    <div className="studio-composer-wrap">
      <form className="studio-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="composer-field">
          <textarea ref={textarea} aria-label="消息" placeholder="输入消息" rows={1} maxLength={16000} value={draft} disabled={sending}
            enterKeyHint="send"
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; compositionEndedAt.current = performance.now(); }}
            onKeyDown={onKeyDown}
            onChange={event => setDraft(event.target.value)} />
          {sending
            ? <button type="button" className="send-button stop" title="停止回复" aria-label="停止回复" onClick={onStop}><Square size={14} fill="currentColor" /></button>
            : <button className="send-button" title="发送消息" aria-label="发送消息" disabled={!draft.trim()}><ArrowUp size={20} strokeWidth={2.6} /></button>}
        </div>
        <div className="composer-options">
          <select aria-label="对话模型" value={activeModel} disabled={sending || Boolean(active)} onChange={event => setModel(event.target.value)}>
            {models.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <label className="ios-switch-label">附上 SNR 状态
            <input type="checkbox" role="switch" className="ios-switch" checked={includeSnr} disabled={sending} onChange={event => setIncludeSnr(event.target.checked)} />
          </label>
        </div>
      </form>
    </div>
  </section>;
}
