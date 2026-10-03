import type { ChatRunActivityEvent } from '@/shared/types.js';

// One project's marks in the workbench project switcher. `attentionSessionIds` lets the history dot those rows too.
type ProjectActivity = { running: number; attention: number; attentionSessionIds: string[] };

// A DeepSeek reply starting or ending (studio.service observeReplies).
type ReplyEvent = { userId: number; conversationId: string; space: string; phase: 'started' | 'ended' };

// A finished run nobody has looked at yet: an agent session (its project is looked up when read) or a DeepSeek
// conversation, which belongs to the hub project of its space.
type UnseenRun = { kind: 'agent' } | { kind: 'deepseek'; userId: number; space: string };

type WorkbenchActivityDeps = {
  // Agent sessions working right now, background work included (providers sessionsService.listRunningSessions).
  listRunningSessions: () => Promise<{ sessionId: string }[]>;
  // Whether a session waits for the owner: a tool approval or a question.
  hasPendingApproval: (sessionId: string) => boolean;
  // Failed or interrupted runs the owner has not resolved or continued yet (task recovery's records).
  listUnresolvedRuns: (userId: number) => { runId: string; sessionId: string; projectPath: string | null }[];
  // The IDE project id of an agent session, or null when unknown or archived.
  sessionProjectId: (sessionId: string) => string | null;
  // The IDE project id registered for a directory, or null.
  projectIdOfPath: (projectPath: string) => string | null;
  // The user's DeepSeek conversations with a reply in progress, with their chat space.
  replyingConversations: (userId: number) => { id: string; space: string }[];
  // The IDE project each linked hub project lives in (hub id → IDE project id); DeepSeek spaces are hub projects.
  hubProjectIds: (userId: number) => Map<string, string>;
  // Whether some visible page shows the session right now (notifications session presence).
  isSessionInView: (sessionId: string) => boolean;
  // Tells every open page to read the activity again.
  broadcast: () => void;
  // Milliseconds to gather changes into one broadcast; tests pass 0.
  broadcastDelayMs?: number;
};

// Enough for every session that can finish between two looks; the oldest marks go first beyond it.
const MAX_UNSEEN = 500;
const PROJECT_SPACE = /^project:(.+)$/;

/**
 * Used by studio.module behind GET /api/studio/workbench/activity: which IDE projects have an agent turn or a
 * DeepSeek reply running, and which need the owner — a pending approval or question, a failed or interrupted run
 * not yet resolved, or a run that finished while its session was not on screen. Running state, approvals and
 * unresolved runs are read live; "finished, not seen yet" is remembered here (in memory) from the run registry's
 * activity until a page shows the session or it runs again. Every change is announced with one debounced
 * `workbench_activity` frame, and the pages read the counts again.
 */
export function createWorkbenchActivityService(deps: WorkbenchActivityDeps) {
  const unseen = new Map<string, UnseenRun>();
  let pendingBroadcast: ReturnType<typeof setTimeout> | null = null;

  const scheduleBroadcast = () => {
    if (pendingBroadcast) return;
    pendingBroadcast = setTimeout(() => {
      pendingBroadcast = null;
      try { deps.broadcast(); } catch (error) {
        console.error('[workbench-activity] broadcast failed', error instanceof Error ? error.message : error);
      }
    }, deps.broadcastDelayMs ?? 250);
    pendingBroadcast.unref?.();
  };

  const rememberUnseen = (sessionId: string, run: UnseenRun) => {
    unseen.delete(sessionId);
    unseen.set(sessionId, run);
    while (unseen.size > MAX_UNSEEN) unseen.delete(unseen.keys().next().value as string);
  };

  // A run that ended while nobody looked wants a look; a new run supersedes the mark.
  const runEnded = (sessionId: string, run: UnseenRun) => {
    if (!deps.isSessionInView(sessionId)) rememberUnseen(sessionId, run);
  };

  return {
    /** The run registry's lifecycle changes (chatRunRegistry.onActivity). */
    handleRunActivity(event: ChatRunActivityEvent) {
      if (event.change === 'started') unseen.delete(event.sessionId);
      else if (event.change === 'ended') runEnded(event.sessionId, { kind: 'agent' });
      scheduleBroadcast();
    },

    /** DeepSeek replies starting and ending (studio.service observeReplies). */
    handleReply(event: ReplyEvent) {
      if (event.phase === 'started') unseen.delete(event.conversationId);
      else runEnded(event.conversationId, { kind: 'deepseek', userId: event.userId, space: event.space });
      scheduleBroadcast();
    },

    /** Sessions a visible page now shows (notifications onSessionsViewed): their finished runs count as seen. */
    handleSessionsViewed(sessionIds: string[]) {
      let changed = false;
      for (const sessionId of sessionIds) changed = unseen.delete(sessionId) || changed;
      if (changed) scheduleBroadcast();
    },

    /** The user's projects with something running or waiting for them, keyed by IDE project id. */
    async snapshot(userId: number): Promise<{ projects: Record<string, ProjectActivity> }> {
      const buckets = new Map<string, { running: Set<string>; attention: Set<string> }>();
      const bucket = (projectId: string) => {
        let entry = buckets.get(projectId);
        if (!entry) buckets.set(projectId, entry = { running: new Set(), attention: new Set() });
        return entry;
      };
      // The hub links resolve directories, so they are read once and only when a DeepSeek conversation needs them.
      let hubs: Map<string, string> | null = null;
      const spaceProjectId = (space: string) => {
        const hubId = PROJECT_SPACE.exec(space)?.[1];
        if (!hubId) return null;
        hubs ??= deps.hubProjectIds(userId);
        return hubs.get(hubId) ?? null;
      };

      const running = new Set<string>();
      for (const { sessionId } of await deps.listRunningSessions()) {
        const projectId = deps.sessionProjectId(sessionId);
        if (!projectId) continue;
        running.add(sessionId);
        bucket(projectId).running.add(sessionId);
        if (deps.hasPendingApproval(sessionId)) bucket(projectId).attention.add(sessionId);
      }
      for (const conversation of deps.replyingConversations(userId)) {
        const projectId = spaceProjectId(conversation.space);
        if (!projectId) continue;
        running.add(conversation.id);
        bucket(projectId).running.add(conversation.id);
      }
      for (const run of deps.listUnresolvedRuns(userId)) {
        const projectId = run.sessionId ? deps.sessionProjectId(run.sessionId)
          : run.projectPath ? deps.projectIdOfPath(run.projectPath) : null;
        // A run that never got a session still counts for its project, under its own id.
        if (projectId) bucket(projectId).attention.add(run.sessionId || `run:${run.runId}`);
      }
      for (const [sessionId, run] of unseen) {
        if (running.has(sessionId)) continue;
        if (run.kind === 'deepseek' && run.userId !== userId) continue;
        const projectId = run.kind === 'agent' ? deps.sessionProjectId(sessionId) : spaceProjectId(run.space);
        if (projectId) bucket(projectId).attention.add(sessionId);
      }

      const projects: Record<string, ProjectActivity> = {};
      for (const [projectId, entry] of buckets) {
        projects[projectId] = {
          running: entry.running.size,
          attention: entry.attention.size,
          attentionSessionIds: [...entry.attention].filter(id => !id.startsWith('run:')),
        };
      }
      return { projects };
    },
  };
}
