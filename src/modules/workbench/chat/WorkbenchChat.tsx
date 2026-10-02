import { useCallback, useState } from 'react';
import { LazyMotion, MotionConfig } from 'motion/react';

import type { WorkbenchChatProps, WorkbenchSessionItem } from '@/shared/types';
import { WorkbenchAgentChat } from '@/modules/workbench/chat/WorkbenchAgentChat';
import { WorkbenchDeepSeekChat } from '@/modules/workbench/chat/WorkbenchDeepSeekChat';
import '@/modules/workbench/chat/workbench-chat.css';

const loadMotionFeatures = () => import('@/modules/workbench/chat/motionFeatures').then((module) => module.default);
// The Studio spring: iOS-like response, no visible overshoot.
const SPRING = { type: 'spring', stiffness: 158, damping: 25 } as const;

/**
 * Used by the workbench shell (WorkbenchRoute) as its centre column: the conversation with Claude Code, Codex or
 * DeepSeek. Before a new chat's first message the provider can still change; the first send creates the session
 * and reports it through `onSessionCreated`, after which the provider is fixed and only the model can change.
 */
export function WorkbenchChat({ project, session, provider, hubProjectId, onSessionCreated, onOpenFile }: WorkbenchChatProps) {
  // Provider a new chat will start with; follows the shell's preselection and the header menu.
  const [draftProvider, setDraftProvider] = useState(provider);
  // The shell's preselection last seen, so a change from the shell resets the draft (state adjusted during render).
  const [seenProvider, setSeenProvider] = useState(provider);
  // Identity of the conversation on screen: kept when a new chat receives its id, renewed on any other switch,
  // so the DeepSeek view (and the agent transcript's entrance bookkeeping) start clean for each conversation.
  const [chatKey, setChatKey] = useState(() => session?.id ?? 'new-0');
  // The session id last seen from the shell, to detect switches during render.
  const [seenSessionId, setSeenSessionId] = useState<string | null>(session?.id ?? null);
  // Bumped whenever the shell leaves a session for a new chat, telling the engine to drop the old view.
  const [newSessionTrigger, setNewSessionTrigger] = useState(0);
  // Id of the session this column itself just created, so the shell routing to it is not mistaken for a switch.
  const [createdId, setCreatedId] = useState<string | null>(null);

  if (provider !== seenProvider) {
    setSeenProvider(provider);
    setDraftProvider(provider);
  }

  const currentSessionId = session?.id ?? null;
  if (currentSessionId !== seenSessionId) {
    setSeenSessionId(currentSessionId);
    const isOwnNewSession = currentSessionId !== null && currentSessionId === createdId;
    if (!isOwnNewSession) {
      setChatKey(currentSessionId ?? `new-${newSessionTrigger + 1}`);
      setDraftProvider(provider);
    }
    if (currentSessionId === null) setNewSessionTrigger((value) => value + 1);
  }

  const handleSessionCreated = useCallback((item: WorkbenchSessionItem) => {
    setCreatedId(item.id);
    onSessionCreated(item);
  }, [onSessionCreated]);

  const isDeepSeek = session ? session.kind === 'deepseek' : draftProvider === 'deepseek';
  const agentProvider = session && session.kind === 'agent' && session.provider !== 'deepseek'
    ? session.provider
    : draftProvider === 'codex' ? 'codex' : 'claude';

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
              allowProviderSwitch={!session}
              onSelectProvider={setDraftProvider}
              onSessionCreated={handleSessionCreated}
            />
          ) : (
            <WorkbenchAgentChat
              key={project.projectId}
              conversationKey={chatKey}
              project={project}
              session={session?.kind === 'agent' ? session : null}
              draftProvider={agentProvider}
              newSessionTrigger={newSessionTrigger}
              allowProviderSwitch={!session}
              onSelectProvider={setDraftProvider}
              onSessionCreated={handleSessionCreated}
              onOpenFile={onOpenFile}
            />
          )}
        </section>
      </MotionConfig>
    </LazyMotion>
  );
}
