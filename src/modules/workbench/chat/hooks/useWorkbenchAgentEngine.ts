import { useCallback, useEffect, useRef } from 'react';

import {
  useChatComposerState,
  useChatProviderState,
  useChatRealtimeHandlers,
  useChatSessionState,
  useSessionStore,
} from '@/modules/chat';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { useProcessingSessions, useSessionProtectionActions } from '@/shared/context/SessionProtectionContext';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider, Project, ProjectSession, SessionEstablishedContext, WorkbenchSessionItem } from '@/shared/types';

type UseWorkbenchAgentEngineArgs = {
  project: Project;
  // The open session in the chat engine's shape, or null for a new chat.
  session: ProjectSession | null;
  // Provider a new chat sends under; ignored once a session is open (its row fixes the provider).
  draftProvider: LLMProvider;
  // Bumped by the column when the shell leaves a session for a new chat, so the engine drops the old view.
  newSessionTrigger: number;
  onSessionCreated: (item: WorkbenchSessionItem) => void;
  onOpenFile: (path: string) => void;
};

/**
 * Used by WorkbenchAgentChat: the inherited chat engine (provider, session, realtime and composer hooks) wired
 * exactly as ChatInterface wires it, minus ChatInterface's presentation, palette registration and scheduling.
 * Everything that talks to the WebSocket or the session store stays in those hooks; this only joins them.
 */
export function useWorkbenchAgentEngine({
  project,
  session,
  draftProvider,
  newSessionTrigger,
  onSessionCreated,
  onOpenFile,
}: UseWorkbenchAgentEngineArgs) {
  const { ws, sendMessage, subscribe } = useWebSocket();
  const processingSessions = useProcessingSessions();
  const {
    markSessionProcessing,
    markSessionIdle,
    markSessionBackground,
    getSessionActivity,
  } = useSessionProtectionActions();
  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const providerState = useChatProviderState({ selectedSession: session, selectedProject: project });
  const { provider, setProvider } = providerState;

  // A new chat follows the column's provider choice; an open session's provider is set by the hook itself.
  useEffect(() => {
    if (session || provider === draftProvider) return;
    setProvider(draftProvider);
    writeSelectedProvider(draftProvider);
  }, [draftProvider, provider, session, setProvider]);

  const sessionState = useChatSessionState({
    isActive: true,
    selectedProject: project,
    selectedSession: session,
    ws,
    sendMessage,
    newSessionTrigger,
    processingSessions,
    onSessionIdle: markSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });
  const { setCurrentSessionId, requestLatestMessages } = sessionState;

  // The first send of a new chat allocates the session (POST /api/providers/sessions) before the WebSocket send;
  // the shell learns about it here and routes to it, after which `session` carries the same id.
  const handleSessionEstablished = useCallback((sessionId: string, context: SessionEstablishedContext) => {
    setCurrentSessionId(sessionId);
    onSessionCreated({
      id: sessionId,
      kind: 'agent',
      provider: context.provider,
      title: context.summary?.trim() || '新对话',
      updatedAt: new Date().toISOString(),
      running: true,
    });
  }, [onSessionCreated, setCurrentSessionId]);

  const composer = useChatComposerState({
    selectedProject: project,
    selectedSession: session,
    currentSessionId: sessionState.currentSessionId,
    provider,
    permissionMode: providerState.permissionMode,
    cyclePermissionMode: providerState.cyclePermissionMode,
    currentProviderModel: providerState.currentProviderModel,
    currentProviderEffort: providerState.currentProviderEffort,
    isLoading: sessionState.isProcessing,
    processingSessions,
    canAbortSession: sessionState.canAbortSession,
    tokenBudget: sessionState.tokenBudget,
    sendMessage,
    onSessionProcessing: markSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onFileOpen: onOpenFile,
    scrollToBottom: sessionState.scrollToBottom,
    addMessage: sessionState.addMessage,
    setIsUserScrolledUp: sessionState.setIsUserScrolledUp,
    setPendingPermissionRequests: providerState.setPendingPermissionRequests,
    resolvePermissionModeForProvider: providerState.resolvePermissionModeForProvider,
  });

  // After a dropped socket: sync the persisted tail, then re-subscribe so the ack restores the run state and
  // replays the live events this client missed.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!session) return;
    await requestLatestMessages(session.id, true);
    statusCheckSentAtRef.current.set(session.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{ sessionId: session.id, lastSeq: lastSeqRef.current.get(session.id) ?? 0 }],
    });
  }, [requestLatestMessages, sendMessage, session]);

  useChatRealtimeHandlers({
    isActive: true,
    subscribe,
    provider,
    selectedSession: session,
    currentSessionId: sessionState.currentSessionId,
    setTokenBudget: sessionState.setTokenBudget,
    pendingPermissionRequests: providerState.pendingPermissionRequests,
    setPendingPermissionRequests: providerState.setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing: markSessionProcessing,
    onSessionIdle: markSessionIdle,
    onSessionBackground: markSessionBackground,
    getSessionActivity,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => () => resetStreamingState(), [resetStreamingState]);

  const sessionId = sessionState.currentSessionId || session?.id || null;
  const { selectProviderModel, selectProviderEffort } = providerState;

  // A pick becomes the provider default for new chats and, with a session open, that session's model.
  const selectModel = useCallback(async (model: string) => {
    await selectProviderModel(provider, model, sessionId);
  }, [provider, selectProviderModel, sessionId]);

  const selectEffort = useCallback(async (effort: string) => {
    await selectProviderEffort(provider, effort, sessionId);
  }, [provider, selectProviderEffort, sessionId]);

  // The three hook results are fresh objects every render, so memoising this bundle would buy nothing.
  return { provider: providerState, session: sessionState, composer, sessionId, sendMessage, selectModel, selectEffort };
}
