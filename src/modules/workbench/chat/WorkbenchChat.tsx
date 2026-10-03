import { useCallback, useMemo, useRef, useState } from 'react';
import { LazyMotion, MotionConfig } from 'motion/react';
import { toast } from 'sonner';

import { StudioConfirmSheet } from '@/modules/studio';
import { api, readApiJson } from '@/shared/api';
import type {
  WorkbenchChatChrome, WorkbenchChatProps, WorkbenchHandoff, WorkbenchHandoffRequest, WorkbenchNewProvider, WorkbenchSessionItem, WorkbenchThread,
  WorkbenchThreadSegment,
} from '@/shared/types';
import { WorkbenchAgentChat } from '@/modules/workbench/chat/WorkbenchAgentChat';
import { WorkbenchDeepSeekChat } from '@/modules/workbench/chat/WorkbenchDeepSeekChat';
import { WorkbenchHandoffPrelude } from '@/modules/workbench/chat/WorkbenchHandoffPrelude';
import { useWorkbenchModelCatalogs } from '@/modules/workbench/chat/hooks/useWorkbenchModelCatalogs';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import { appendHandoffContext, threadPosition } from '@/modules/workbench/chat/utils/workbenchHandoff';
import { newChatChoices, resolveNewChatProvider } from '@/modules/workbench/utils/workbenchRoutes';
import '@/modules/workbench/chat/workbench-chat.css';

const loadMotionFeatures = () => import('@/modules/workbench/chat/motionFeatures').then((module) => module.default);
// The Studio spring: iOS-like response, no visible overshoot.
const SPRING = { type: 'spring', stiffness: 158, damping: 25 } as const;
// A failed link between the sessions is tried once more after this pause.
const LINK_RETRY_MS = 1500;

type WorkbenchChatColumnProps = WorkbenchChatProps & {
  // The shell's controls and project name for the column's title bar; absent when the column stands alone.
  chrome?: WorkbenchChatChrome;
};

// The session a handoff leaves, as the column records it.
type HandoffSource = { kind: WorkbenchSessionItem['kind']; id: string; provider: WorkbenchNewProvider; modelLabel: string; title: string };

/**
 * A confirmed handoff, from the owner's yes until the next session is recorded as the conversation's next stretch.
 * `createdId` is the next session once its first send created it; `linked` once the server recorded the chain.
 */
type PendingHandoff = {
  id: number;
  from: HandoffSource;
  // The stretches the conversation went through so far, the session being left last.
  chain: WorkbenchThreadSegment[];
  to: { provider: WorkbenchNewProvider; modelLabel: string | null };
  summary: { status: 'loading' | 'ready' | 'error'; text: string | null; error: string | null };
  createdId: string | null;
  linked: boolean;
};

const readableError = (failure: unknown, fallback: string) => (failure instanceof Error && failure.message ? failure.message : fallback);

/**
 * Used by the workbench shell (WorkbenchShell) as its centre column: one conversation with Claude Code, Codex or
 * DeepSeek. A new chat opens with the shell's preselection, and until its first message the one model menu (header
 * pill and composer chip) lists every provider's models, so picking a Codex or DeepSeek model switches the chat to
 * that provider in place. The first send creates the session and reports it through `onSessionCreated`.
 *
 * Once the conversation has started, the same menu still lists the other providers: picking one asks to hand the
 * conversation over. On yes the column builds a summary of the conversation so far (server-side, from the stored
 * transcript), shows the earlier messages above a divider, and the owner's next message starts the other provider's
 * session in the same project with the summary appended. The new session is then recorded as the conversation's next
 * stretch (`onThreadChange`), so the history lists the chain as one conversation and reopening it shows it whole.
 * Same-provider model changes stay in place, as before.
 */
export function WorkbenchChat({
  project, session, provider, hubProjectId, onSessionCreated, onOpenFile, chrome, thread = null, onThreadChange,
}: WorkbenchChatColumnProps) {
  // DeepSeek needs a hub project; the same rule as the shell's, so a preselection it cannot honour starts Claude Code.
  const startProvider = resolveNewChatProvider(provider, hubProjectId);
  // Provider a new chat will start with; follows the shell's preselection and the model menu.
  const [draftProvider, setDraftProvider] = useState<WorkbenchNewProvider>(startProvider);
  // The shell's preselection last seen, so a change from the shell resets the draft (state adjusted during render).
  const [seenProvider, setSeenProvider] = useState<WorkbenchNewProvider>(startProvider);
  // Identity of the conversation on screen: kept when a new chat receives its id, renewed on any other switch,
  // so the DeepSeek view (and the agent transcript's entrance bookkeeping) start clean for each conversation.
  const [chatKey, setChatKey] = useState(() => session?.id ?? 'new-0');
  // The session id last seen from the shell, to detect switches during render.
  const [seenSessionId, setSeenSessionId] = useState<string | null>(session?.id ?? null);
  // Bumped whenever the column leaves a session for a new chat (the shell's new chat, or a handoff), telling the
  // engine to drop the old view.
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);
  // Id of the session this column itself just created, so the shell routing to it is not mistaken for a switch.
  const [createdId, setCreatedId] = useState<string | null>(null);
  // DeepSeek model a new DeepSeek chat sends with, chosen in the model menu (also from the agent view); null: the first.
  const [deepseekModel, setDeepseekModel] = useState<string | null>(null);
  // Another provider's model picked in a started chat, waiting for the owner's yes in the confirmation sheet.
  const [confirming, setConfirming] = useState<WorkbenchHandoffRequest | null>(null);
  // The handoff in progress (see PendingHandoff); null otherwise.
  const [handoff, setHandoff] = useState<PendingHandoff | null>(null);
  // The chain as the server recorded it after this column's handoff, until the shell's `thread` catches up.
  const [linkedThread, setLinkedThread] = useState<WorkbenchThread | null>(null);
  // The handoff summary's block for the next session's first prompt, by handoff id (a retry replaces it).
  const contextRef = useRef<{ id: number; from: HandoffSource; toProvider: WorkbenchNewProvider; promise: Promise<string> } | null>(null);
  const handoffSeq = useRef(0);

  if (startProvider !== seenProvider) {
    setSeenProvider(startProvider);
    setDraftProvider(startProvider);
  }

  const currentSessionId = session?.id ?? null;
  if (currentSessionId !== seenSessionId) {
    setSeenSessionId(currentSessionId);
    const isOwnNewSession = currentSessionId !== null && currentSessionId === createdId;
    if (!isOwnNewSession) {
      setChatKey(currentSessionId ?? `new-${newSessionTrigger + 1}`);
      setDraftProvider(startProvider);
      // Another session (or a new chat) opened from the shell abandons a handoff that has no session yet.
      if (handoff) setHandoff(null);
    }
    if (currentSessionId === null) setNewSessionTrigger((value) => value + 1);
  }
  // The handoff is over once the shell shows the new session and the chain is recorded.
  if (handoff?.linked && handoff.createdId === currentSessionId) setHandoff(null);

  // The session the views show: none while a handoff waits for its first message (the old one is in the prelude).
  const viewSession = handoff && handoff.createdId !== currentSessionId ? null : session;
  // Where the open session sits in its chain: the shell's thread, or the one this column just recorded.
  const knownThread = [thread, linkedThread].find((candidate) => threadPosition(candidate, viewSession)) ?? null;
  const position = threadPosition(knownThread, viewSession);

  const handleSessionCreated = useCallback((item: WorkbenchSessionItem) => {
    setCreatedId(item.id);
    if (handoff && !handoff.createdId) {
      const pending = handoff;
      setHandoff((previous) => (previous?.id === pending.id ? { ...previous, createdId: item.id } : previous));
      const link = async (attempt: number): Promise<void> => {
        try {
          const linked = await api.studio.workbench.linkThread({
            projectId: project.projectId,
            title: pending.from.title,
            from: { kind: pending.from.kind, id: pending.from.id, modelLabel: pending.from.modelLabel },
            to: { kind: item.kind, id: item.id, modelLabel: pending.to.modelLabel },
          }).then(readApiJson<WorkbenchThread>);
          setLinkedThread(linked);
          onThreadChange?.(linked);
          setHandoff((previous) => (previous?.id === pending.id ? { ...previous, linked: true } : previous));
        } catch {
          if (attempt === 0) {
            await new Promise((resolve) => { window.setTimeout(resolve, LINK_RETRY_MS); });
            return link(1);
          }
          toast.error('没能记录这次交接', { description: '新会话已经开始；历史里它会和原来的会话分开显示。' });
        }
      };
      void link(0);
    }
    onSessionCreated(item);
  }, [handoff, onSessionCreated, onThreadChange, project.projectId]);

  // Builds the summary of the session being left for `toProvider`; the column shows its progress and the next
  // session's first send waits for it.
  const startSummary = useCallback((id: number, from: HandoffSource, toProvider: WorkbenchNewProvider): Promise<string> => {
    setHandoff((previous) => (previous?.id === id ? { ...previous, summary: { status: 'loading', text: null, error: null } } : previous));
    const request = api.studio.workbench.handoff({
      projectId: project.projectId, from: { kind: from.kind, id: from.id, modelLabel: from.modelLabel }, toProvider,
    }).then(readApiJson<WorkbenchHandoff>);
    request
      .then((result) => setHandoff((previous) => (previous?.id === id ? { ...previous, summary: { status: 'ready', text: result.summary, error: null } } : previous)))
      .catch((failure: unknown) => setHandoff((previous) => (previous?.id === id
        ? { ...previous, summary: { status: 'error', text: null, error: readableError(failure, '没能整理交接摘要') } } : previous)));
    const promise = request.then((result) => result.context);
    contextRef.current = { id, from, toProvider, promise };
    return promise;
  }, [project.projectId]);

  // The next session's first prompt: the owner's text with the summary block; a failed summary is retried once here.
  const prepareHandoffMessage = useCallback(async (text: string): Promise<string> => {
    const pending = contextRef.current;
    if (!pending) return text;
    try {
      return appendHandoffContext(text, await pending.promise);
    } catch {
      try {
        return appendHandoffContext(text, await startSummary(pending.id, pending.from, pending.toProvider));
      } catch (failure) {
        throw new Error(`没能整理交接摘要：${readableError(failure, '请再试一次')}`);
      }
    }
  }, [startSummary]);

  const cancelHandoff = useCallback(() => {
    contextRef.current = null;
    setHandoff(null);
    setChatKey(currentSessionId ?? `new-${newSessionTrigger + 1}`);
  }, [currentSessionId, newSessionTrigger]);

  // Hands the conversation to `to` (the confirmed pick, or a different pick while the handoff waits).
  const beginHandoff = useCallback((from: HandoffSource, chain: WorkbenchThreadSegment[], to: PendingHandoff['to']) => {
    handoffSeq.current += 1;
    const id = handoffSeq.current;
    setHandoff({ id, from, chain, to, summary: { status: 'loading', text: null, error: null }, createdId: null, linked: false });
    setChatKey(`handoff-${id}`);
    setNewSessionTrigger((value) => value + 1);
    void startSummary(id, from, to.provider).catch(() => undefined);
  }, [startSummary]);

  const onProviderChange = chrome?.onProviderChange;
  const selectProvider = useCallback((next: WorkbenchNewProvider, modelLabel: string | null = null) => {
    // While a handoff waits for its first message, the menu retargets it; the original provider cancels it.
    if (handoff && !handoff.createdId) {
      if (next === handoff.from.provider) cancelHandoff();
      else if (next !== handoff.to.provider) beginHandoff(handoff.from, handoff.chain, { provider: next, modelLabel });
      return;
    }
    setDraftProvider(next);
    onProviderChange?.(next);
  }, [beginHandoff, cancelHandoff, handoff, onProviderChange]);

  const requestHandoff = useCallback((request: WorkbenchHandoffRequest) => {
    if (request.busy) { toast('等这一轮回复结束再交接'); return; }
    if (!request.from.id) { toast('第一条消息还没有送达，稍后再交接'); return; }
    setConfirming(request);
  }, []);

  const confirmHandoff = () => {
    const request = confirming;
    setConfirming(null);
    if (!request?.from.id) return;
    request.apply();
    const from: HandoffSource = {
      kind: request.from.kind, id: request.from.id, provider: request.from.provider, modelLabel: request.from.modelLabel,
      title: knownThread?.title ?? session?.title ?? '',
    };
    const chain = position
      ? [...position.earlier, position.current]
      : [{ kind: from.kind, provider: from.provider, sessionId: from.id, modelLabel: from.modelLabel, handoffAt: null }];
    beginHandoff(from, chain, { provider: request.provider, modelLabel: request.modelLabel });
  };

  // What the model menu offers besides the chat's own provider: the shell's rule (DeepSeek only with a hub project).
  const providerChoices = useMemo(() => newChatChoices(hubProjectId), [hubProjectId]);
  // An earlier stretch of a chain stays with its provider: only the latest one can be handed on.
  const canHandOff = !position || position.later.length === 0;

  const isDeepSeek = viewSession ? viewSession.kind === 'deepseek' : (handoff ? handoff.to.provider : draftProvider) === 'deepseek';
  const nextProvider = handoff ? handoff.to.provider : draftProvider;
  const agentProvider = viewSession && viewSession.kind === 'agent'
    ? (viewSession.provider === 'codex' ? 'codex' : 'claude')
    : nextProvider === 'deepseek' ? 'claude' : nextProvider;
  // The other providers' models for the one model menu (an agent chat holds both agents' catalogs itself).
  const catalogs = useWorkbenchModelCatalogs({ agents: isDeepSeek, deepseek: !isDeepSeek && Boolean(hubProjectId) });

  const waiting = handoff && !handoff.createdId ? handoff : null;
  const prelude = handoff ? (
    <WorkbenchHandoffPrelude
      project={project}
      segments={handoff.chain}
      next={{ provider: handoff.to.provider, modelLabel: handoff.to.modelLabel, handoffAt: null }}
      pending={waiting ? {
        status: waiting.summary.status,
        summary: waiting.summary.text,
        error: waiting.summary.error,
        onRetry: () => { void startSummary(waiting.id, waiting.from, waiting.to.provider).catch(() => undefined); },
        onCancel: cancelHandoff,
      } : null}
    />
  ) : position && position.earlier.length > 0 ? (
    <WorkbenchHandoffPrelude
      project={project}
      segments={position.earlier}
      next={{ provider: position.current.provider, modelLabel: position.current.modelLabel, handoffAt: position.current.handoffAt }}
    />
  ) : null;
  const prepare = waiting ? prepareHandoffMessage : undefined;
  const onRequestHandoff = canHandOff ? requestHandoff : undefined;

  const confirmTarget = confirming
    ? `${providerLabel(confirming.provider)}${confirming.modelLabel ? ` · ${confirming.modelLabel}` : ''}`
    : '';

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user" transition={SPRING}>
        <section className="wbc" aria-label={`${project.displayName} 对话`}>
          {isDeepSeek ? (
            <WorkbenchDeepSeekChat
              key={chatKey}
              project={project}
              conversationId={viewSession?.kind === 'deepseek' ? viewSession.id : null}
              title={viewSession?.title ?? (handoff?.from.title || null)}
              hubProjectId={hubProjectId}
              providerChoices={providerChoices}
              onRequestHandoff={onRequestHandoff}
              prepareFirstMessage={prepare}
              prelude={prelude}
              catalogs={catalogs}
              draftModel={deepseekModel}
              onDraftModelChange={setDeepseekModel}
              onSelectProvider={selectProvider}
              onSessionCreated={handleSessionCreated}
              chrome={chrome}
            />
          ) : (
            <WorkbenchAgentChat
              key={project.projectId}
              conversationKey={chatKey}
              project={project}
              session={viewSession?.kind === 'agent' ? viewSession : null}
              draftProvider={agentProvider}
              newSessionTrigger={newSessionTrigger}
              providerChoices={providerChoices}
              onRequestHandoff={onRequestHandoff}
              prepareNewSessionContent={prepare}
              prelude={prelude}
              title={handoff?.from.title || null}
              catalogs={catalogs}
              onPickDeepSeekModel={setDeepseekModel}
              onSelectProvider={selectProvider}
              onSessionCreated={handleSessionCreated}
              onOpenFile={onOpenFile}
              chrome={chrome}
            />
          )}
          {confirming && (
            <StudioConfirmSheet
              title={`交给 ${providerLabel(confirming.provider)} 继续？`}
              message={`前面的对话会整理成摘要交给 ${confirmTarget}，在这里接着聊。原来的会话会保留，随时可以回看。`}
              confirmLabel="交接"
              destructive={false}
              onCancel={() => setConfirming(null)}
              onConfirm={confirmHandoff}
            />
          )}
        </section>
      </MotionConfig>
    </LazyMotion>
  );
}
