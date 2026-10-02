import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ServerEvent, TaskRecoveryRun } from '@/shared/types';

/** Chat uses this scoped list to offer reviewed continuation after a server restart. */
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

  useEffect(() => {
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribe = subscribe((event) => {
      if (event.kind === 'websocket_reconnected'
        || (event.sessionId === sessionId && (event.kind === 'protocol_error' || (event.kind === 'complete' && event.success === false)))) void refresh();
    });
    return () => {
      requestVersionRef.current += 1;
      unsubscribe();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, subscribe, sessionId]);

  const resolve = useCallback(async (runId: string) => {
    const response = await api.taskRecovery.resolve(runId);
    if (!response.ok) throw new Error('Recovery update failed');
    await refresh();
  }, [refresh]);

  return {
    runs: result.scope === scope ? result.runs : [],
    error: result.scope === scope && result.error,
    refresh,
    resolve,
  };
}
