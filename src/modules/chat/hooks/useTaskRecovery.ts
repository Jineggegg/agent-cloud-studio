import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ServerEvent, TaskRecoveryRun } from '@/shared/types';

/** Chat and the workbench chat engine use this scoped list to offer reviewed continuation after a server restart. */
export function useTaskRecovery({ projectPath, sessionId, subscribe }: {
  projectPath: string;
  sessionId: string | null;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
}) {
  const scope = JSON.stringify([projectPath, sessionId]);
  const activeScopeRef = useRef(scope);
  useLayoutEffect(() => { activeScopeRef.current = scope; }, [scope]);
  const requestVersionRef = useRef(0);
  // Each response keeps its scope so a previous conversation never flashes in the next one.
  const [result, setResult] = useState<{ scope: string; runs: TaskRecoveryRun[]; error: boolean }>({ scope, runs: [], error: false });

  const refresh = useCallback(async () => {
    if (!projectPath || activeScopeRef.current !== scope) return;
    const requestVersion = ++requestVersionRef.current;
    try {
      const response = await api.taskRecovery.list(projectPath, sessionId);
      if (!response.ok) throw new Error('Recovery lookup unavailable');
      const body = await response.json();
      if (activeScopeRef.current !== scope || requestVersion !== requestVersionRef.current) return;
      const runs = Array.isArray(body.runs) ? body.runs.filter((run: TaskRecoveryRun) =>
        run.projectPath === projectPath && (run.state === 'interrupted' || run.state === 'failed')
        && (sessionId ? run.sessionId === sessionId : !run.sessionId)) : [];
      setResult({ scope, runs, error: false });
    } catch {
      if (activeScopeRef.current === scope && requestVersion === requestVersionRef.current) {
        setResult((previous) => ({ scope, runs: previous.scope === scope ? previous.runs : [], error: true }));
      }
    }
  }, [projectPath, sessionId, scope]);

  // Close a card the server no longer offers at once, then confirm with a fresh list. The refresh
  // also supersedes any lookup started before the claim, so a stale response cannot bring it back.
  const dismiss = useCallback(async (runId: string) => {
    setResult((previous) => (previous.scope === scope && previous.runs.some((run) => run.runId === runId)
      ? { ...previous, runs: previous.runs.filter((run) => run.runId !== runId) }
      : previous));
    await refresh();
  }, [refresh, scope]);

  useEffect(() => {
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    // The last live run seen in this conversation: a different run id means a run (possibly a
    // continuation started on another device) began, so the server list may have changed.
    let lastSeenRunId: string | null = null;
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'websocket_reconnected') { void refresh(); return; }
      // A continuation's receipt names the run it claimed. Run ids are unique, so this needs no
      // session match: a continuation of an unassigned run receipts under its new conversation.
      if (event.kind === 'run_accepted' && typeof event.recoveryOfRunId === 'string') {
        void dismiss(event.recoveryOfRunId);
        return;
      }
      if (!sessionId || event.sessionId !== sessionId) return;
      const runId = typeof event.runId === 'string' && event.runId ? event.runId : null;
      const runStarted = runId !== null && runId !== lastSeenRunId;
      if (runId) lastSeenRunId = runId;
      if (runStarted || event.kind === 'run_accepted' || event.kind === 'complete' || event.kind === 'protocol_error'
        || (event.kind === 'chat_subscribed' && event.isProcessing === true)) void refresh();
    });
    return () => {
      requestVersionRef.current += 1;
      unsubscribe();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, dismiss, subscribe, sessionId]);

  const resolve = useCallback(async (runId: string) => {
    const response = await api.taskRecovery.resolve(runId);
    // 200 with alreadyHandled (claimed by a continuation or resolved elsewhere) and 404 (gone)
    // both leave nothing to review here, so the card closes without an error.
    if (!response.ok && response.status !== 404) throw new Error('Recovery update failed');
    await dismiss(runId);
  }, [dismiss]);

  return {
    runs: result.scope === scope ? result.runs : [],
    error: result.scope === scope && result.error,
    refresh,
    resolve,
  };
}
