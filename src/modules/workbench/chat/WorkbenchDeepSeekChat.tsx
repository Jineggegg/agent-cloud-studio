import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Activity, AlertTriangle, KeyRound, X } from 'lucide-react';

import { LazyMessageRow, useLazyRowObserver } from '@/modules/chat';
import type {
  ChatMessage, Project, ProviderModelOption, StudioConversation, WorkbenchChatChrome, WorkbenchNewChatChoice, WorkbenchNewProvider,
  WorkbenchSessionItem,
} from '@/shared/types';
import { useDeepSeekConversation } from '@/modules/workbench/chat/hooks/useDeepSeekConversation';
import { WorkbenchChatHeader } from '@/modules/workbench/chat/WorkbenchChatHeader';
import { WorkbenchAssistantMessage, WorkbenchTurnLabel, WorkbenchUserMessage } from '@/modules/workbench/chat/WorkbenchMessageRow';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { WorkbenchSendButton } from '@/modules/workbench/chat/WorkbenchSendButton';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';

// Used until the connector reports its models, matching the Studio DeepSeek app.
const FALLBACK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
// The field grows with its text up to this height, then scrolls.
const INPUT_MAX_HEIGHT = 320;
// Safari ends IME composition just before the confirming Enter arrives.
const IME_RACE_WINDOW_MS = 30;

type WorkbenchDeepSeekChatProps = {
  project: Project;
  // The conversation the shell has open, or null for a new chat.
  conversationId: string | null;
  title: string | null;
  hubProjectId: string | null;
  // Agents a new chat may switch to before its first send; null once the shell has a conversation open.
  providerChoices: WorkbenchNewChatChoice[] | null;
  onSelectProvider: (provider: WorkbenchNewProvider) => void;
  onSessionCreated: (item: WorkbenchSessionItem) => void;
  // The shell's controls and project name for the title bar.
  chrome?: WorkbenchChatChrome;
};

function ThinkingRow({ since }: { since: number | null }) {
  // Clock for the elapsed seconds while the whole reply is pending.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return (
    <m.div
      className="wbc-row is-assistant wbc-thinking"
      role="status"
      aria-label="DeepSeek 正在思考"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
    >
      <WorkbenchTurnLabel provider="deepseek" />
      <div className="wbc-thinking-line">
        <WorkbenchSpinner size={15} />
        <span className="wbc-breathe">正在思考</span>
        {seconds > 1 && <span className="wbc-thinking-time">{seconds} 秒</span>}
      </div>
    </m.div>
  );
}

/**
 * Used by WorkbenchChat for DeepSeek: the same column (header pill, prose transcript, composer) over Studio's
 * conversation API in the project's space, or the general DeepSeek space when the project has no hub entry.
 * Replies arrive whole, so a thinking line with elapsed time stands in for streaming.
 */
export function WorkbenchDeepSeekChat({
  project,
  conversationId,
  title,
  hubProjectId,
  providerChoices,
  onSelectProvider,
  onSessionCreated,
  chrome,
}: WorkbenchDeepSeekChatProps) {
  const space = hubProjectId ? `project:${hubProjectId}` as const : 'deepseek' as const;
  const handleCreated = useCallback((created: StudioConversation, firstMessage: string) => {
    const fallbackTitle = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话';
    onSessionCreated({
      id: created.id,
      kind: 'deepseek',
      provider: 'deepseek',
      title: created.title?.trim() && created.title !== '新对话' ? created.title : fallbackTitle,
      updatedAt: created.updated_at ?? new Date().toISOString(),
    });
  }, [onSessionCreated]);
  const chat = useDeepSeekConversation({ conversationId, space, onCreated: handleCreated });

  // Draft text; restored when a send fails so nothing typed is lost.
  const [draft, setDraft] = useState('');
  // Model for a new conversation; a started conversation keeps the model it was created with.
  const [draftModel, setDraftModel] = useState(FALLBACK_MODELS[0]);
  // Sharing SNR's health summary is an explicit per-message opt-in, as in the Studio DeepSeek app.
  const [includeSnr, setIncludeSnr] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const lazyRows = useLazyRowObserver(scrollRef);

  const models = chat.status?.deepseek.models?.length ? chat.status.deepseek.models : FALLBACK_MODELS;
  const modelOptions = useMemo<ProviderModelOption[]>(() => models.map((value) => ({ value, label: value })), [models]);
  const activeModel = chat.conversation?.model ?? (models.includes(draftModel) ? draftModel : models[0]);
  const started = Boolean(chat.conversation) || chat.sending;
  const configured = chat.status ? chat.status.deepseek.configured : true;

  const messages = useMemo<ChatMessage[]>(() => (chat.conversation?.messages ?? []).map((message) => ({
    type: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
    // The API keeps no per-message time, so rows show none rather than a misleading one.
    timestamp: '',
    id: String(message.id),
    failed: message.status === 'error',
  })), [chat.conversation?.messages]);

  // Jump to the end when a conversation opens; glide when a message or the thinking line is added.
  const shownCountRef = useRef(0);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const jump = shownCountRef.current === 0;
    shownCountRef.current = messages.length;
    if (jump || typeof container.scrollTo !== 'function') container.scrollTop = container.scrollHeight;
    else container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [messages.length, chat.sending]);

  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [draft]);

  const submit = async () => {
    const text = draft;
    if (!text.trim() || chat.sending) return;
    setDraft('');
    if (!await chat.send(text, activeModel, includeSnr)) setDraft(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    const imeActive = composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229
      || performance.now() - compositionEndedAtRef.current < IME_RACE_WINDOW_MS;
    if (imeActive) return;
    event.preventDefault();
    void submit();
  };

  const emptyState = configured ? (
    <div className="wbc-empty">
      <WorkbenchProviderMark provider="deepseek" size={60} />
      <h2 className="wbc-empty-title">{project.displayName}</h2>
      <p className="wbc-empty-sub">DeepSeek · {activeModel} · {hubProjectId ? '保存在这个项目里' : '保存在 DeepSeek 应用里'}</p>
      <p className="wbc-empty-note">适合提问、写作和整理思路；它看不到项目文件，也不会运行命令。</p>
    </div>
  ) : (
    <div className="wbc-empty">
      <span className="wbc-empty-icon" aria-hidden="true"><KeyRound size={26} strokeWidth={1.8} /></span>
      <h2 className="wbc-empty-title">还没有 DeepSeek 密钥</h2>
      <p className="wbc-empty-note">到 Studio 主屏的「连接」里添加 API 密钥，回来就能对话。</p>
    </div>
  );

  return (
    <div className="wbc-body">
      <WorkbenchChatHeader
        provider="deepseek"
        modelLabel={activeModel}
        title={title}
        providerChoices={started ? null : providerChoices}
        onSelectProvider={onSelectProvider}
        models={modelOptions}
        currentModel={activeModel}
        onSelectModel={started ? undefined : setDraftModel}
        chrome={chrome}
      />

      <div ref={scrollRef} className="wbc-scroll" aria-busy={chat.loading || chat.sending}>
        <div className="wbc-thread" role="log" aria-live="polite" aria-relevant="additions">
          {chat.loading && (
            <div className="wbc-skeleton" role="status" aria-label="正在载入对话">
              <span className="wbc-skel is-bubble" />
              <span className="wbc-skel is-line" />
              <span className="wbc-skel is-line is-long" />
            </div>
          )}
          {!chat.loading && messages.length === 0 && !chat.sending && emptyState}
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            return (
              <LazyMessageRow key={String(message.id)} lazyRows={lazyRows} timestamp={undefined} initiallyNearViewport={index >= messages.length - 30}>
                <div className={`wbc-item is-${message.type}`}>
                  {message.type === 'user'
                    ? <WorkbenchUserMessage message={message} projectId={project.projectId} failed={Boolean(message.failed)} />
                    : <WorkbenchAssistantMessage message={{ ...message, model: activeModel }} provider="deepseek" turnStart={previous?.type !== 'assistant'} />}
                </div>
              </LazyMessageRow>
            );
          })}
          <AnimatePresence>{chat.sending && <ThinkingRow key="thinking" since={chat.sendingSince} />}</AnimatePresence>
        </div>
      </div>

      <div className="wbc-dock">
        <AnimatePresence>
          {chat.error && (
            <m.div key="error" className="wbc-dock-error" role="alert" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{chat.error}</span>
              <button type="button" className="wbc-row-action" aria-label="关闭提示" onClick={chat.clearError}><X size={14} /></button>
            </m.div>
          )}
        </AnimatePresence>
        <div className="wbc-composer-wrap">
          <form className="wbc-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <textarea
              ref={inputRef}
              className="wbc-input"
              rows={1}
              dir="auto"
              aria-label="消息"
              enterKeyHint="send"
              maxLength={16000}
              placeholder={configured ? '给 DeepSeek 发消息' : '先添加 DeepSeek 密钥'}
              value={draft}
              disabled={chat.sending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; compositionEndedAtRef.current = performance.now(); }}
            />
            <div className="wbc-composer-bar">
              <button
                type="button"
                role="switch"
                aria-checked={includeSnr}
                className={`wbc-chip${includeSnr ? ' is-on' : ''}`}
                onClick={() => setIncludeSnr((value) => !value)}
                disabled={chat.sending}
                title="把 SNR 实验室的健康摘要附在这条消息里"
              >
                <Activity size={13} strokeWidth={2.2} aria-hidden="true" />
                <span>附上 SNR 状态</span>
              </button>
              <span className="wbc-composer-spacer" />
              <WorkbenchSendButton
                mode={chat.sending ? 'stop' : 'send'}
                disabled={chat.sending ? false : !draft.trim()}
                onStop={chat.stop}
              />
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
