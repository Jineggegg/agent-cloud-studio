import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Activity, AlertTriangle, KeyRound, Sparkle, X } from 'lucide-react';
import { toast } from 'sonner';

import { LazyMessageRow, useLazyRowObserver } from '@/modules/chat';
import { writeDeviceModelChoice } from '@/shared/modelDefaults';
import type {
  ChatMessage, Project, ProviderModelOption, StudioConversation, WorkbenchChatChrome, WorkbenchHandoffRequest, WorkbenchModelCatalogs,
  WorkbenchNewChatChoice, WorkbenchNewProvider, WorkbenchSessionItem,
} from '@/shared/types';
import { useDeepSeekConversation } from '@/modules/workbench/chat/hooks/useDeepSeekConversation';
import { useSpeechDictation } from '@/modules/workbench/chat/hooks/useSpeechDictation';
import { WorkbenchChatHeader } from '@/modules/workbench/chat/WorkbenchChatHeader';
import { WorkbenchMenu } from '@/modules/workbench/chat/WorkbenchMenu';
import { WorkbenchAssistantMessage, WorkbenchTurnLabel, WorkbenchUserMessage } from '@/modules/workbench/chat/WorkbenchMessageRow';
import { WorkbenchMicButton } from '@/modules/workbench/chat/WorkbenchMicButton';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { WorkbenchSendButton } from '@/modules/workbench/chat/WorkbenchSendButton';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { menuProvidersFor, oneModelMenuSections } from '@/modules/workbench/chat/utils/workbenchModelMenu';

// Used until the connector reports its models, matching the Studio DeepSeek app.
const FALLBACK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
// The field grows with its text up to this height, then scrolls.
const INPUT_MAX_HEIGHT = 320;
// Safari ends IME composition just before the confirming Enter arrives.
const IME_RACE_WINDOW_MS = 30;
// The server takes 16000 characters per message; a handoff's first message also carries the summary (≤ 7.5K).
const MAX_MESSAGE = 16000;
const MAX_HANDOFF_MESSAGE = 8000;

type WorkbenchDeepSeekChatProps = {
  project: Project;
  // The conversation the shell has open, or null for a new chat.
  conversationId: string | null;
  title: string | null;
  hubProjectId: string | null;
  // Providers the model menu offers besides DeepSeek (switched to before the first send, handed over to after it);
  // null when the provider cannot change here.
  providerChoices: WorkbenchNewChatChoice[] | null;
  // Another provider's model picked once the conversation has started: the column confirms and hands it over.
  onRequestHandoff?: (request: WorkbenchHandoffRequest) => void;
  // A handoff's first message: the owner's text with the earlier conversation's summary appended.
  prepareFirstMessage?: (text: string) => Promise<string>;
  // Earlier stretches of a handed-over conversation, shown above this conversation's messages.
  prelude?: ReactNode;
  // The Claude Code and Codex models for the one model menu.
  catalogs: WorkbenchModelCatalogs;
  // The DeepSeek model a new conversation sends with (picked here or in the agent view); null: the first offered.
  draftModel: string | null;
  onDraftModelChange: (model: string) => void;
  // Another provider picked before the first send (with the picked model's label, when there is one).
  onSelectProvider: (provider: WorkbenchNewProvider, modelLabel?: string | null) => void;
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
 * Used by WorkbenchChat for DeepSeek: the same column (header pill, prose transcript, composer with the one model
 * menu and dictation) over Studio's conversation API in the project's space, or the general DeepSeek space when the
 * project has no hub entry. Until the first send the model menu also offers Claude Code and Codex models, which
 * switch the chat to that agent. Replies arrive whole, so a thinking line with elapsed time stands in for streaming.
 */
export function WorkbenchDeepSeekChat({
  project,
  conversationId,
  title,
  hubProjectId,
  providerChoices,
  onRequestHandoff,
  prepareFirstMessage,
  prelude,
  catalogs,
  draftModel,
  onDraftModelChange,
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
  // Sharing SNR's health summary is an explicit per-message opt-in, as in the Studio DeepSeek app.
  const [includeSnr, setIncludeSnr] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const lazyRows = useLazyRowObserver(scrollRef);

  const models = chat.status?.deepseek.models?.length ? chat.status.deepseek.models : FALLBACK_MODELS;
  const modelOptions = useMemo<ProviderModelOption[]>(() => models.map((value) => ({ value, label: value })), [models]);
  const activeModel = chat.conversation?.model ?? (draftModel && models.includes(draftModel) ? draftModel : models[0]);
  // An open conversation counts as started while it loads, so the menu never offers an instant switch for it.
  const started = Boolean(conversationId) || Boolean(chat.conversation) || chat.sending;
  const configured = chat.status ? chat.status.deepseek.configured : true;
  const dictation = useSpeechDictation({ text: draft, onText: setDraft, onError: (message) => toast.error(message) });

  // Before the first send another provider's model switches this chat; afterwards it hands the conversation over.
  const switchMode = !providerChoices ? 'locked' : !started ? 'switch' : onRequestHandoff ? 'handoff' : 'locked';
  // Claude Code or Codex picked: that agent starts on this device with the chosen model — at once before the first
  // send, or once the owner agrees to hand the conversation over.
  const switchProvider = (target: WorkbenchNewProvider, model: string | null, modelLabel: string | null) => {
    const recordPick = () => { if (target !== 'deepseek' && model) writeDeviceModelChoice(target, model); };
    if (started && onRequestHandoff) {
      onRequestHandoff({
        provider: target, model, modelLabel,
        from: { kind: 'deepseek', id: chat.conversation?.id ?? null, provider: 'deepseek', modelLabel: activeModel },
        busy: chat.sending,
        apply: recordPick,
      });
      return;
    }
    recordPick();
    onSelectProvider(target, modelLabel);
  };
  const menuSections = oneModelMenuSections({
    providers: menuProvidersFor({ choices: switchMode === 'locked' ? null : providerChoices, current: 'deepseek', currentOptions: modelOptions, catalogs }),
    current: 'deepseek',
    currentModel: activeModel,
    mode: switchMode,
    onSelectModel: started ? undefined : onDraftModelChange,
    onSwitch: switchProvider,
  });
  const pickable = menuSections.some((section) => section.items.length > 0);

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
    let message = text;
    // A handoff's first message carries the summary; without one the send waits for the owner to retry.
    if (prepareFirstMessage && !chat.conversation) {
      try {
        message = await prepareFirstMessage(text);
      } catch (failure) {
        toast.error(failure instanceof Error && failure.message ? failure.message : '没能整理交接摘要，请再试一次');
        setDraft(text);
        return;
      }
    }
    if (!await chat.send(message, activeModel, includeSnr)) setDraft(text);
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
      <p className="wbc-empty-note">适合提问、写作和整理思路；它看不到项目文件，也不会运行命令。{providerChoices && '可以在模型菜单里换成 Claude Code 或 Codex；对话开始后换服务，前面的内容会整理成摘要交给它。'}</p>
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
        menuSections={menuSections}
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
          {prelude}
          {!prelude && !chat.loading && messages.length === 0 && !chat.sending && emptyState}
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
              maxLength={prepareFirstMessage && !chat.conversation ? MAX_HANDOFF_MESSAGE : MAX_MESSAGE}
              placeholder={configured ? '给 DeepSeek 发消息' : '先添加 DeepSeek 密钥'}
              value={draft}
              disabled={chat.sending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; compositionEndedAtRef.current = performance.now(); }}
            />
            <div className="wbc-composer-bar">
              {dictation.supported && <WorkbenchMicButton listening={dictation.listening} disabled={chat.sending} onToggle={dictation.toggle} />}
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
              {pickable ? (
                <WorkbenchMenu
                  label={`模型 ${activeModel}`}
                  triggerClassName="wbc-chip"
                  placement="up"
                  width={320}
                  trigger={<><Sparkle size={13} strokeWidth={2.2} aria-hidden="true" /><span>{activeModel}</span></>}
                  sections={menuSections}
                />
              ) : (
                <span className="wbc-chip is-static" aria-label={`模型 ${activeModel}（已固定）`}>
                  <Sparkle size={13} strokeWidth={2.2} aria-hidden="true" /><span>{activeModel}</span>
                </span>
              )}
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
