import { useCallback, useMemo } from 'react';
import type { KeyboardEvent } from 'react';
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
import type {
  ChatMessage,
  LLMProvider,
  PendingPermissionRequest,
  Project,
  ProjectSession,
  WorkbenchChatChrome,
  WorkbenchNewChatChoice,
  WorkbenchNewProvider,
  WorkbenchSessionItem,
  WorkbenchTodoItem,
} from '@/shared/types';
import { useWorkbenchAgentEngine } from '@/modules/workbench/chat/hooks/useWorkbenchAgentEngine';
import { WorkbenchChatHeader } from '@/modules/workbench/chat/WorkbenchChatHeader';
import { WorkbenchComposer } from '@/modules/workbench/chat/WorkbenchComposer';
import { WorkbenchPermissionSheet } from '@/modules/workbench/chat/WorkbenchPermissionSheet';
import { WorkbenchPlanCard } from '@/modules/workbench/chat/WorkbenchPlanCard';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { WorkbenchQuestionSheet } from '@/modules/workbench/chat/WorkbenchQuestionSheet';
import { WorkbenchRunIsland } from '@/modules/workbench/chat/WorkbenchRunIsland';
import { WorkbenchTokenRing } from '@/modules/workbench/chat/WorkbenchTokenRing';
import { WorkbenchTranscript } from '@/modules/workbench/chat/WorkbenchTranscript';
import { modelShortLabel, permissionModeCopy, providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import {
  PLAN_TOOL_NAMES,
  TODO_TOOL_NAMES,
  describeCurrentActivity,
  describeToolCall,
  readTodos,
  readToolInput,
} from '@/modules/workbench/chat/utils/workbenchToolSummary';

/** What the run is blocked on, worded for the run island: `等你允许运行 npm test`. */
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

type WorkbenchAgentChatProps = {
  // Identity of the conversation on screen (kept when a new chat receives its id), for the transcript's entrances.
  conversationKey: string;
  project: Project;
  session: WorkbenchSessionItem | null;
  // Provider a new chat sends under.
  draftProvider: LLMProvider;
  newSessionTrigger: number;
  // Agents a new chat may switch to before its first send; null once the shell has a session open.
  providerChoices: WorkbenchNewChatChoice[] | null;
  onSelectProvider: (provider: WorkbenchNewProvider) => void;
  onSessionCreated: (item: WorkbenchSessionItem) => void;
  onOpenFile: (path: string) => void;
  // The shell's controls and project name for the title bar.
  chrome?: WorkbenchChatChrome;
};

/**
 * Used by WorkbenchChat for Claude Code, Codex, Cursor and OpenCode chats: the inherited chat engine
 * under a new presentation — header pill, run island, transcript with tool stacks, inline permission and question
 * sheets, and the composer dock.
 */
export function WorkbenchAgentChat({
  conversationKey,
  project,
  session,
  draftProvider,
  newSessionTrigger,
  providerChoices: newChatProviderChoices,
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
  });
  const { provider: providerState, session: sessionState, composer, recovery } = engine;
  const provider = providerState.provider;
  const messages = sessionState.chatMessages;
  const pending = providerState.pendingPermissionRequests;
  const isProcessing = sessionState.isProcessing;
  // A send the server has not confirmed yet blocks another send (and recovery), as ChatComposer does.
  const deliveryPending = composer.delivery?.state === 'sending' || composer.delivery?.state === 'unknown';

  const started = Boolean(engine.sessionId) || messages.length > 0;
  const providerChoices = started ? null : newChatProviderChoices;
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
  // The dots stand for the model composing; a running tool row already shows its own spinner.
  const toolInFlight = Boolean(lastMessage?.isToolUse && !lastMessage.toolResult && lastMessage.toolStatus !== 'completed');
  const showTyping = isProcessing && pending.length === 0 && !lastMessage?.isStreaming && !toolInFlight;

  const handleSelectModel = useCallback((model: string) => {
    engine.selectModel(model).catch(() => toast.error('没能切换模型，请再试一次'));
  }, [engine]);
  const handleSelectEffort = useCallback((effort: string) => {
    engine.selectEffort(effort).catch(() => toast.error('没能切换思考强度，请再试一次'));
  }, [engine]);

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
          title={session?.title}
          providerChoices={providerChoices}
          onSelectProvider={onSelectProvider}
          models={providerState.currentProviderModelOptions}
          currentModel={providerState.currentProviderModel}
          onSelectModel={handleSelectModel}
          end={<WorkbenchTokenRing usage={sessionState.tokenBudget} onOpen={composer.showCostModal} />}
          chrome={chrome}
        />

        <WorkbenchRunIsland
          active={isProcessing}
          activity={activity}
          waiting={waitingFor !== null}
          startedAt={sessionState.sessionActivity?.startedAt ?? null}
          todos={todos}
          canStop={sessionState.canAbortSession}
          onStop={composer.handleAbortSession}
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
              showTyping={showTyping}
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
              emptyState={emptyState}
            />
          </TranscriptSessionContext.Provider>
        </MarkdownWorkspaceContext.Provider>

        <div className="wbc-dock">
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
              onSelectModel={handleSelectModel}
              effort={providerState.currentProviderEffort}
              effortOptions={providerState.currentProviderEffortOptions}
              onSelectEffort={handleSelectEffort}
              isProcessing={isProcessing}
              canAbort={sessionState.canAbortSession}
              onAbort={composer.handleAbortSession}
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
