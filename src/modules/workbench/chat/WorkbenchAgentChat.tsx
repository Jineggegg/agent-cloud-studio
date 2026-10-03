import { useCallback, useMemo, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { ArrowDown, AtSign, ImagePlus, Slash } from 'lucide-react';
import { toast } from 'sonner';

import {
  ChatDeliveryStatus,
  ChatRecoveryBanner,
  CommandResultModal,
  MarkdownWorkspaceContext,
  PermissionContext,
  TranscriptSessionContext,
} from '@/modules/chat';
import { useSuggestedPrompt } from '@/shared/hooks/useSuggestedPrompt';
import type {
  ChatMessage,
  LLMProvider,
  PendingPermissionRequest,
  Project,
  ProjectSession,
  PromptSuggestionTurn,
  WorkbenchChatChrome,
  WorkbenchHandoffRequest,
  WorkbenchModelCatalogs,
  WorkbenchNewChatChoice,
  WorkbenchNewProvider,
  WorkbenchSessionItem,
  WorkbenchTodoItem,
} from '@/shared/types';
import { useDockScrollPin } from '@/modules/workbench/chat/hooks/useDockScrollPin';
import { useWorkbenchAgentEngine } from '@/modules/workbench/chat/hooks/useWorkbenchAgentEngine';
import { WorkbenchChatHeader } from '@/modules/workbench/chat/WorkbenchChatHeader';
import { WorkbenchComposer } from '@/modules/workbench/chat/WorkbenchComposer';
import { WorkbenchPermissionSheet } from '@/modules/workbench/chat/WorkbenchPermissionSheet';
import { WorkbenchPlanCard } from '@/modules/workbench/chat/WorkbenchPlanCard';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { WorkbenchQuestionSheet } from '@/modules/workbench/chat/WorkbenchQuestionSheet';
import { WorkbenchRunStatus } from '@/modules/workbench/chat/WorkbenchRunStatus';
import { WorkbenchTokenRing } from '@/modules/workbench/chat/WorkbenchTokenRing';
import { WorkbenchTranscript } from '@/modules/workbench/chat/WorkbenchTranscript';
import { modelShortLabel, permissionModeCopy, providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import { menuProvidersFor, oneModelMenuSections } from '@/modules/workbench/chat/utils/workbenchModelMenu';
import {
  PLAN_TOOL_NAMES,
  TODO_TOOL_NAMES,
  describeCurrentActivity,
  describeToolCall,
  readTodos,
  readToolInput,
} from '@/modules/workbench/chat/utils/workbenchToolSummary';

/** What the run is blocked on, worded for the run status row: `等你允许运行 npm test`. */
function describeWaiting(request: PendingPermissionRequest): string {
  const call = describeToolCall(request.toolName, request.input);
  if (call.kind === 'other') return `等你允许使用 ${call.verb}`;
  return `等你允许${call.verb}${call.target ? ` ${call.target}` : ''}`;
}

/** The checklist of the turn in flight: the newest TodoWrite after the owner's last message, or null. */
function currentTurnTodos(messages: ChatMessage[]): WorkbenchTodoItem[] | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'user') return null;
    if (message.isToolUse && TODO_TOOL_NAMES.has(String(message.toolName))) {
      const todos = readTodos(message.toolInput);
      if (todos.length) return todos;
    }
  }
  return null;
}

// A handoff's first prompt carries the earlier conversation's summary; the suggestion only needs the owner's words.
const HANDOFF_BLOCK = /\n*<handoff>[\s\S]*<\/handoff>\s*$/;
// Tool calls in a row are folded into one line naming at most this many of the latest.
const TOOL_CALLS_PER_TURN = 5;

/**
 * The conversation as the suggested-next-message service reads it: the owner's messages, the agent's prose and,
 * between them, one line of what the agent did (编辑 App.tsx；运行 npm test). Thinking, local command output and
 * compaction rows are left out.
 */
function suggestionTurns(messages: ChatMessage[]): PromptSuggestionTurn[] {
  const turns: PromptSuggestionTurn[] = [];
  let tools: string[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    const shown = tools.slice(-TOOL_CALLS_PER_TURN).join('；');
    turns.push({ role: 'tool', text: tools.length > TOOL_CALLS_PER_TURN ? `（共 ${tools.length} 步，最近的：）${shown}` : shown });
    tools = [];
  };
  for (const message of messages) {
    if (message.isThinking || message.isLocalCommand || message.isLocalCommandStdout || message.isCompactSummary || message.compact) continue;
    if (message.isToolUse && message.toolName) {
      const call = describeToolCall(String(message.toolName), message.toolInput);
      tools.push(call.target ? `${call.verb} ${call.target}` : call.verb);
      continue;
    }
    const text = (message.content ?? '').replace(HANDOFF_BLOCK, '').trim();
    if (!text || (message.type !== 'user' && message.type !== 'assistant')) continue;
    flushTools();
    turns.push({ role: message.type, text });
  }
  flushTools();
  return turns;
}

type WorkbenchAgentChatProps = {
  // Identity of the conversation on screen (kept when a new chat receives its id), for the transcript's entrances.
  conversationKey: string;
  project: Project;
  session: WorkbenchSessionItem | null;
  // Provider a new chat sends under.
  draftProvider: LLMProvider;
  newSessionTrigger: number;
  // Providers the model menu offers besides this one (switched to before the first send, handed over to after it);
  // null when the provider cannot change here.
  providerChoices: WorkbenchNewChatChoice[] | null;
  // Another provider's model picked once the conversation has started: the column confirms and hands it over.
  // Absent where a handoff is not possible, and the menu then keeps to this provider.
  onRequestHandoff?: (request: WorkbenchHandoffRequest) => void;
  // A handoff's first prompt: the owner's message with the earlier conversation's summary appended.
  prepareNewSessionContent?: (content: string) => Promise<string>;
  // Earlier stretches of a handed-over conversation, shown above this session's transcript.
  prelude?: ReactNode;
  // The conversation's title while a handoff waits for its first message (the session itself has none yet).
  title?: string | null;
  // The other providers' models for the one model menu.
  catalogs: WorkbenchModelCatalogs;
  // A DeepSeek model picked here; the column switches to DeepSeek with it.
  onPickDeepSeekModel: (model: string) => void;
  // Another provider picked before the first send (with the picked model's label, when there is one).
  onSelectProvider: (provider: WorkbenchNewProvider, modelLabel?: string | null) => void;
  onSessionCreated: (item: WorkbenchSessionItem) => void;
  onOpenFile: (path: string) => void;
  // The shell's controls and project name for the title bar.
  chrome?: WorkbenchChatChrome;
};

/**
 * Used by WorkbenchChat for Claude Code and Codex chats: the inherited chat engine under a new presentation — header
 * pill, transcript with tool stacks, and the dock: run status row, inline permission and question sheets, composer. Its
 * one model menu also lists the other providers' models until the first send.
 */
export function WorkbenchAgentChat({
  conversationKey,
  project,
  session,
  draftProvider,
  newSessionTrigger,
  providerChoices: newChatProviderChoices,
  onRequestHandoff,
  prepareNewSessionContent,
  prelude,
  title,
  catalogs,
  onPickDeepSeekModel,
  onSelectProvider,
  onSessionCreated,
  onOpenFile,
  chrome,
}: WorkbenchAgentChatProps) {
  const { projectId, displayName, fullPath } = project;
  const projectPath = project.path;
  // The engine's effects key on object identity, so both shapes stay stable across unrelated shell re-renders.
  const engineProject = useMemo<Project>(
    () => ({ projectId, displayName, fullPath, path: projectPath }),
    [displayName, fullPath, projectId, projectPath],
  );
  const sessionId = session?.id ?? null;
  const sessionProvider = session?.provider ?? null;
  const engineSession = useMemo<ProjectSession | null>(
    () => (sessionId ? { id: sessionId, __provider: sessionProvider as LLMProvider, __projectId: projectId } : null),
    [projectId, sessionId, sessionProvider],
  );

  const engine = useWorkbenchAgentEngine({
    project: engineProject,
    session: engineSession,
    draftProvider,
    newSessionTrigger,
    onSessionCreated,
    onOpenFile,
    prepareNewSessionContent,
  });
  const { provider: providerState, session: sessionState, composer, recovery } = engine;
  const provider = providerState.provider;
  const messages = sessionState.chatMessages;
  const pending = providerState.pendingPermissionRequests;
  const isProcessing = sessionState.isProcessing;
  // A send the server has not confirmed yet blocks another send (and recovery), as ChatComposer does.
  const deliveryPending = composer.delivery?.state === 'sending' || composer.delivery?.state === 'unknown';

  // An open session counts as started even before its history arrives, so the menu never offers an instant switch.
  const started = Boolean(session) || Boolean(engine.sessionId) || messages.length > 0;
  // Before the first send another provider's model switches this chat; afterwards it hands the conversation over.
  const switchMode = !newChatProviderChoices ? 'locked' : !started ? 'switch' : onRequestHandoff ? 'handoff' : 'locked';
  const providerChoices = switchMode === 'locked' ? null : newChatProviderChoices;
  const modelName = modelShortLabel(providerState.currentProviderModel, providerState.currentProviderModelOptions);

  const planRequest = pending.find((request) => PLAN_TOOL_NAMES.has(request.toolName)) ?? null;
  const questionRequest = pending.find((request) => request.toolName === 'AskUserQuestion') ?? null;
  const actionableRequests = pending.filter((request) => !PLAN_TOOL_NAMES.has(request.toolName) && request.toolName !== 'AskUserQuestion');
  const planRowShown = sessionState.visibleMessages.some((message) => message.isToolUse && PLAN_TOOL_NAMES.has(String(message.toolName)));
  const todos = useMemo(() => currentTurnTodos(messages), [messages]);
  // A run blocked on the owner says so instead of claiming to think: the sheet below is where to look.
  const waitingFor = questionRequest ? '等你回答问题'
    : actionableRequests.length > 0 ? describeWaiting(actionableRequests[0])
      : planRequest ? '等你批准计划' : null;
  const activity = waitingFor ?? describeCurrentActivity(messages) ?? sessionState.sessionActivity?.statusText ?? '正在思考';
  const lastMessage = messages[messages.length - 1];
  // The run status row's glyph: the typing dots while the model composes, the spinner while a tool runs, a hand
  // while a sheet waits on the owner.
  const toolInFlight = Boolean(lastMessage?.isToolUse && !lastMessage.toolResult && lastMessage.toolStatus !== 'completed');
  const runPhase = waitingFor !== null ? 'waiting' : toolInFlight ? 'working' : 'composing';
  const dockRef = useRef<HTMLDivElement>(null);
  useDockScrollPin({ dockRef, scrollRef: sessionState.scrollContainerRef, pinned: !sessionState.isUserScrolledUp });
  const conversationTurns = useMemo(() => suggestionTurns(messages), [messages]);
  // The faint next message in the empty composer, asked for once the run has finished and nothing waits on the owner.
  const nextPrompt = useSuggestedPrompt({
    conversationKey: engine.sessionId,
    assistant: provider === 'codex' ? 'codex' : 'claude',
    turns: conversationTurns,
    ready: !isProcessing && !deliveryPending && pending.length === 0 && !composer.preparedRecovery && !lastMessage?.isStreaming,
  });

  const handleSelectModel = useCallback((model: string) => {
    engine.selectModel(model).catch(() => toast.error('没能切换模型，请再试一次'));
  }, [engine]);
  const handleSelectEffort = useCallback((effort: string) => {
    engine.selectEffort(effort).catch(() => toast.error('没能切换思考强度，请再试一次'));
  }, [engine]);
  // Records another provider's model as that provider's pick on this device (DeepSeek's in the column), which the
  // chat shows once it is that provider's.
  const recordPick = useCallback((target: WorkbenchNewProvider, model: string | null) => {
    if (!model) return;
    if (target === 'deepseek') onPickDeepSeekModel(model);
    else void providerState.selectProviderModel(target, model, null);
  }, [onPickDeepSeekModel, providerState]);
  // Another provider's model: before the first send the chat becomes that provider's at once; afterwards the column
  // asks to hand the conversation over, and the pick is recorded only if the owner agrees.
  const handleSwitch = useCallback((target: WorkbenchNewProvider, model: string | null, modelLabel: string | null) => {
    if (started && onRequestHandoff) {
      onRequestHandoff({
        provider: target, model, modelLabel,
        from: { kind: 'agent', id: engine.sessionId ?? session?.id ?? null, provider: provider === 'codex' ? 'codex' : 'claude', modelLabel: modelName },
        busy: isProcessing || deliveryPending,
        apply: () => recordPick(target, model),
      });
      return;
    }
    recordPick(target, model);
    onSelectProvider(target, modelLabel);
  }, [deliveryPending, engine.sessionId, isProcessing, modelName, onRequestHandoff, onSelectProvider, provider, recordPick, session?.id, started]);
  const menuProvider = provider === 'codex' ? 'codex' : 'claude';
  // The engine already holds both agents' catalogs (with the user's hidden models removed); DeepSeek's come from the column.
  const agentCatalog = providerState.providerModelCatalog;
  const menuCatalogs = {
    ...catalogs,
    claude: agentCatalog.claude?.OPTIONS ?? catalogs.claude,
    codex: agentCatalog.codex?.OPTIONS ?? catalogs.codex,
  };
  const menuSections = oneModelMenuSections({
    providers: menuProvidersFor({ choices: providerChoices, current: menuProvider, currentOptions: providerState.currentProviderModelOptions, catalogs: menuCatalogs }),
    current: menuProvider,
    currentModel: providerState.currentProviderModel,
    mode: switchMode,
    onSelectModel: handleSelectModel,
    onSwitch: handleSwitch,
    emptyNote: '正在读取模型…',
  });

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests: pending,
    handlePermissionDecision: composer.handlePermissionDecision,
  }), [composer.handlePermissionDecision, pending]);
  const markdownWorkspaceValue = useMemo(() => ({ projectId }), [projectId]);
  const transcriptSessionValue = useMemo(() => ({ sessionId: engine.sessionId }), [engine.sessionId]);

  // Escape stops the run from anywhere in the column, unless a menu or the composer already used the key.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat || !sessionState.canAbortSession) return;
    event.preventDefault();
    composer.handleAbortSession();
  };

  const modeCopy = permissionModeCopy(providerState.permissionMode);
  const emptyState = (
    <div className="wbc-empty">
      <WorkbenchProviderMark provider={provider} size={60} />
      <h2 className="wbc-empty-title">{displayName}</h2>
      <p className="wbc-empty-sub">{providerLabel(provider)} · {modelName} · {modeCopy.label}</p>
      {providerChoices && <p className="wbc-empty-note">可以在模型菜单里换成 Claude、Codex 或 DeepSeek 的任一模型；对话开始后换服务，前面的内容会整理成摘要交给它。</p>}
      <ul className="wbc-empty-hints" aria-label="小提示">
        <li><Slash size={14} aria-hidden="true" /><span>输入 / 调用命令和技能</span></li>
        <li><AtSign size={14} aria-hidden="true" /><span>输入 @ 引用项目里的文件</span></li>
        <li><ImagePlus size={14} aria-hidden="true" /><span>拖入或粘贴图片一起发送</span></li>
      </ul>
    </div>
  );

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="wbc-body" onKeyDown={onKeyDown}>
        <WorkbenchChatHeader
          provider={provider}
          modelLabel={modelName}
          title={session?.title ?? title}
          menuSections={menuSections}
          end={<WorkbenchTokenRing usage={sessionState.tokenBudget} onOpen={composer.showCostModal} />}
          chrome={chrome}
        />

        <MarkdownWorkspaceContext.Provider value={markdownWorkspaceValue}>
          <TranscriptSessionContext.Provider value={transcriptSessionValue}>
            {/* In-chat file links (Markdown) call the palette ops the shell registers, which keep the line number and
                reveal folders in the file tree; a PaletteOpsProvider nested here would shadow them. */}
            <WorkbenchTranscript
              sessionKey={conversationKey}
              isNewChat={!session}
              messages={sessionState.visibleMessages}
              provider={provider}
              project={engineProject}
              scrollRef={sessionState.scrollContainerRef}
              onScrollIntent={sessionState.handleScroll}
              isLoading={sessionState.isLoadingSessionMessages}
              runActive={isProcessing}
              hiddenCount={Math.max(0, messages.length - sessionState.visibleMessages.length)}
              onShowEarlier={sessionState.loadEarlierMessages}
              hasMoreHistory={sessionState.hasMoreMessages && !sessionState.allMessagesLoaded}
              isLoadingHistory={sessionState.isLoadingMoreMessages || sessionState.isLoadingAllMessages}
              onLoadAllHistory={sessionState.loadAllMessages}
              createDiff={sessionState.createDiff}
              onOpenFile={onOpenFile}
              pendingPlanRequest={planRequest}
              onDecision={composer.handlePermissionDecision}
              onEditMessage={providerState.supportsMessageEditing && !isProcessing ? composer.beginEditMessage : undefined}
              emptyState={prelude ? null : emptyState}
              prelude={prelude}
            />
          </TranscriptSessionContext.Provider>
        </MarkdownWorkspaceContext.Provider>

        <div className="wbc-dock" ref={dockRef}>
          <AnimatePresence>
            {sessionState.isUserScrolledUp && messages.length > 0 && (
              <m.button
                key="to-bottom"
                type="button"
                className="wbc-to-bottom"
                aria-label="回到最新"
                title="回到最新"
                onClick={sessionState.scrollToBottomAndReset}
                initial={{ opacity: 0, y: 8, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.8 }}
              >
                <ArrowDown size={17} strokeWidth={2.4} />
              </m.button>
            )}
          </AnimatePresence>

          {/* The transcript's last line, right above the composer (or the sheet standing in for it). */}
          <WorkbenchRunStatus
            active={isProcessing}
            activity={activity}
            phase={runPhase}
            startedAt={sessionState.sessionActivity?.startedAt ?? null}
            todos={todos}
            canStop={sessionState.canAbortSession}
            onStop={composer.handleAbortSession}
          />

          {/* One sheet at a time: the answered one sinks away before the next rises. */}
          <AnimatePresence mode="wait">
            {questionRequest ? (
              <WorkbenchQuestionSheet
                key={questionRequest.requestId}
                request={questionRequest}
                provider={provider}
                onDecision={composer.handlePermissionDecision}
              />
            ) : actionableRequests.length > 0 ? (
              <WorkbenchPermissionSheet
                key={actionableRequests[0].requestId}
                requests={actionableRequests}
                allRequests={pending}
                provider={provider}
                onDecision={composer.handlePermissionDecision}
                onGrant={composer.handleGrantToolPermission}
                createDiff={sessionState.createDiff}
              />
            ) : planRequest && !planRowShown ? (
              <m.div key={planRequest.requestId} className="wbc-dock-plan" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
                <WorkbenchPlanCard
                  plan={String(readToolInput(planRequest.input).plan ?? '')}
                  pendingRequest={planRequest}
                  onDecision={composer.handlePermissionDecision}
                />
              </m.div>
            ) : null}
          </AnimatePresence>

          {/* Durable sends and task recovery, as in ChatInterface: interrupted runs are offered for reviewed
              continuation, and a send stays visibly unconfirmed until the server's receipt arrives. */}
          {!questionRequest && <ChatRecoveryBanner
            runs={recovery.runs}
            error={recovery.error}
            disabled={isProcessing || deliveryPending || Boolean(composer.preparedRecovery)}
            onRefresh={recovery.refresh}
            onViewRecords={(run) => { if (run.sessionId) void sessionState.requestLatestMessages(run.sessionId, true).then(sessionState.scrollToBottomAndReset); }}
            onPrepare={composer.prepareRecovery}
            onResolve={recovery.resolve}
          />}
          {!questionRequest && composer.delivery && <ChatDeliveryStatus delivery={composer.delivery} pendingContent={composer.pendingContent}
            isConnected={engine.isConnected} onCheck={() => void composer.checkDelivery()} onRetry={() => void composer.retryDelivery()} />}
          {!questionRequest && composer.preparedRecovery && <div role="status" className="wbc-recovery-note">
            <span>已准备续接草稿。请先核对已生效的操作，编辑确认后再发送。</span>
            <button type="button" onClick={composer.cancelPreparedRecovery}>取消续接关联</button>
          </div>}

          {!questionRequest && (
            <WorkbenchComposer
              composer={composer}
              provider={provider}
              permissionMode={providerState.permissionMode}
              permissionModes={providerState.availablePermissionModes}
              onSelectPermissionMode={providerState.selectPermissionMode}
              model={providerState.currentProviderModel}
              modelOptions={providerState.currentProviderModelOptions}
              modelSections={menuSections}
              effort={providerState.currentProviderEffort}
              effortOptions={providerState.currentProviderEffortOptions}
              onSelectEffort={handleSelectEffort}
              isProcessing={isProcessing}
              canAbort={sessionState.canAbortSession}
              onAbort={composer.handleAbortSession}
              suggestion={nextPrompt.suggestion}
              onSuggestionUsed={nextPrompt.dismiss}
            />
          )}
        </div>

        <CommandResultModal
          payload={composer.commandModalPayload}
          onClose={composer.closeCommandModal}
          providerModelCatalog={providerState.providerModelCatalog}
          providerModelActions={providerState.providerModelActions}
          activeProvider={provider}
          activeProviderModel={providerState.currentProviderModel}
          currentSessionId={engine.sessionId}
          onSelectProviderModel={providerState.selectProviderModel}
        />
      </div>
    </PermissionContext.Provider>
  );
}
