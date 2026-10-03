import { useCallback, useMemo, useState } from 'react';
import { LazyMotion, MotionConfig } from 'motion/react';

import type { WorkbenchChatChrome, WorkbenchChatProps, WorkbenchNewProvider, WorkbenchSessionItem } from '@/shared/types';
import { WorkbenchAgentChat } from '@/modules/workbench/chat/WorkbenchAgentChat';
import { WorkbenchDeepSeekChat } from '@/modules/workbench/chat/WorkbenchDeepSeekChat';
import { useWorkbenchModelCatalogs } from '@/modules/workbench/chat/hooks/useWorkbenchModelCatalogs';
import { newChatChoices, resolveNewChatProvider } from '@/modules/workbench/utils/workbenchRoutes';
import '@/modules/workbench/chat/workbench-chat.css';

const loadMotionFeatures = () => import('@/modules/workbench/chat/motionFeatures').then((module) => module.default);
// The Studio spring: iOS-like response, no visible overshoot.
const SPRING = { type: 'spring', stiffness: 158, damping: 25 } as const;

type WorkbenchChatColumnProps = WorkbenchChatProps & {
  // The shell's controls and project name for the column's title bar; absent when the column stands alone.
  chrome?: WorkbenchChatChrome;
};

/**
 * Used by the workbench shell (WorkbenchShell) as its centre column: one conversation with Claude Code, Codex or
 * DeepSeek. A new chat opens with the shell's preselection, and until its first message the one model menu (header
 * pill and composer chip) lists every provider's models, so picking a Codex or DeepSeek model switches the chat to
 * that provider in place. The first send creates the session and reports it through `onSessionCreated`; from then on
 * the provider is fixed and only its own models remain (a different provider means a new session).
 */
export function WorkbenchChat({ project, session, provider, hubProjectId, onSessionCreated, onOpenFile, chrome }: WorkbenchChatColumnProps) {
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
  // Bumped whenever the shell leaves a session for a new chat, telling the engine to drop the old view.
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);
  // Id of the session this column itself just created, so the shell routing to it is not mistaken for a switch.
  const [createdId, setCreatedId] = useState<string | null>(null);
  // DeepSeek model a new DeepSeek chat sends with, chosen in the model menu (also from the agent view); null: the first.
  const [deepseekModel, setDeepseekModel] = useState<string | null>(null);

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
    }
    if (currentSessionId === null) setNewSessionTrigger((value) => value + 1);
  }

  const handleSessionCreated = useCallback((item: WorkbenchSessionItem) => {
    setCreatedId(item.id);
    onSessionCreated(item);
  }, [onSessionCreated]);

  const onProviderChange = chrome?.onProviderChange;
  const selectProvider = useCallback((next: WorkbenchNewProvider) => {
    setDraftProvider(next);
    onProviderChange?.(next);
  }, [onProviderChange]);

  // What the model menu offers a new chat: the shell's rule (DeepSeek only with a hub project); null for an open session.
  const providerChoices = useMemo(() => (session ? null : newChatChoices(hubProjectId)), [hubProjectId, session]);

  const isDeepSeek = session ? session.kind === 'deepseek' : draftProvider === 'deepseek';
  const agentProvider = session && session.kind === 'agent'
    ? (session.provider === 'codex' ? 'codex' : 'claude')
    : draftProvider === 'deepseek' ? 'claude' : draftProvider;
  // The other providers' models, read only while a new chat can still switch to them.
  const catalogs = useWorkbenchModelCatalogs({ agents: !session && isDeepSeek, deepseek: !session && !isDeepSeek && Boolean(hubProjectId) });

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion="user" transition={SPRING}>
        <section className="wbc" aria-label={`${project.displayName} 对话`}>
          {isDeepSeek ? (
            <WorkbenchDeepSeekChat
              key={chatKey}
              project={project}
              conversationId={session?.kind === 'deepseek' ? session.id : null}
              title={session?.title ?? null}
              hubProjectId={hubProjectId}
              providerChoices={providerChoices}
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
              session={session?.kind === 'agent' ? session : null}
              draftProvider={agentProvider}
              newSessionTrigger={newSessionTrigger}
              providerChoices={providerChoices}
              catalogs={catalogs}
              onPickDeepSeekModel={setDeepseekModel}
              onSelectProvider={selectProvider}
              onSessionCreated={handleSessionCreated}
              onOpenFile={onOpenFile}
              chrome={chrome}
            />
          )}
        </section>
      </MotionConfig>
    </LazyMotion>
  );
}
