import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { StudioGitHubBranchPull } from '@/shared/types';

// The chip re-reads at most this often while the page is visible; the server caches the branch lookup for 30 s.
const BRANCH_PULL_POLL_MS = 60_000;

/**
 * Used by WorkbenchPullChip: the open pull request of the project's current branch (null when there is none, the
 * project is not a GitHub checkout or gh is signed out). It reads on open, when the window regains focus or the tab
 * becomes visible, every minute while visible, and past the server's cache when an agent run in the open session
 * finishes (`running` goes from true to false), since the agent may just have pushed or opened the PR.
 */
export function useWorkbenchBranchPull(projectId: string, running: boolean) {
  // The last answer and the project it belongs to, so another project's PR never shows while the new one loads.
  // A failed read keeps it: a passing network blip should not make the chip blink.
  const [reading, setReading] = useState<{ projectId: string; value: StudioGitHubBranchPull | null } | null>(null);
  // Only the newest read may write, so a slow early answer never overwrites a later one.
  const latest = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const id = ++latest.current;
    try {
      const value = await api.studio.github.branchPull(projectId, refresh).then(readApiJson<StudioGitHubBranchPull | null>);
      if (id === latest.current) setReading({ projectId, value });
    } catch {
      if (id === latest.current) setReading(previous => (previous?.projectId === projectId ? previous : { projectId, value: null }));
    }
  }, [projectId]);

  useEffect(() => {
    void load(false);
    const onVisible = () => { if (!document.hidden) void load(false); };
    const timer = window.setInterval(onVisible, BRANCH_PULL_POLL_MS);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // A run that just finished may have pushed commits or opened the PR: look past the server's cache.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void load(true);
    wasRunning.current = running;
  }, [running, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { branchPull: reading?.projectId === projectId ? reading.value : null, refresh };
}
