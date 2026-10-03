import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { readableErrorMessage } from '@/shared/utils';
import type { StudioGitHubInbox } from '@/shared/types';

// The server caches the inbox for 45 s, so a two-minute poll costs GitHub at most one search per poll.
const GITHUB_REFRESH_MS = 2 * 60_000;

// Pull request ids merged from the GitHub app in this tab. The home widget and the inbox hide them at once instead
// of waiting for the next poll; an id is forgotten again once an answer from the server no longer lists it.
const mergedPullIds = new Set<string>();
const mergedListeners = new Set<(id: string) => void>();

/**
 * Used by StudioGitHub after GitHub finished a merge: the pull request leaves the home widget (mounted under the open
 * app) and every later inbox answer at once, even one that was already on its way.
 */
export function forgetMergedGitHubPull(id: string) {
  mergedPullIds.add(id);
  for (const listener of mergedListeners) listener(id);
}

/**
 * Used by StudioGitHub and this hook on every inbox from the server: drops pull requests merged in this tab, and
 * forgets the ones the server no longer lists (merged pull requests never come back, so that is final).
 */
export function hideMergedGitHubPulls(inbox: StudioGitHubInbox): StudioGitHubInbox {
  if (!mergedPullIds.size) return inbox;
  for (const id of mergedPullIds) if (!inbox.pulls.some(pull => pull.id === id)) mergedPullIds.delete(id);
  const pulls = inbox.pulls.filter(pull => !mergedPullIds.has(pull.id));
  return pulls.length === inbox.pulls.length ? inbox : { ...inbox, pulls };
}

/**
 * Used by StudioWidgets: loads the GitHub inbox once for the whole grid while a GitHub widget is placed. Polling stops
 * while an app covers the home screen or the tab is hidden; a merge made in the GitHub app removes its pull request
 * from the reading straight away. `problem` says why the latest read failed (gh signed out, GitHub unreachable).
 */
export function useGitHubReading(enabled: boolean, paused: boolean) {
  // The PR inbox (null until it first loads) and the latest failure; a failed poll keeps the last inbox.
  const [reading, setReading] = useState<{ inbox: StudioGitHubInbox | null; problem: string }>({ inbox: null, problem: '' });

  useEffect(() => {
    const onMerged = (id: string) => setReading(previous => previous.inbox?.pulls.some(pull => pull.id === id)
      ? { ...previous, inbox: { ...previous.inbox, pulls: previous.inbox.pulls.filter(pull => pull.id !== id) } }
      : previous);
    mergedListeners.add(onMerged);
    return () => { mergedListeners.delete(onMerged); };
  }, []);

  useEffect(() => {
    if (!enabled || paused) return;
    let active = true;
    const load = async () => {
      if (document.hidden) return;
      try {
        const inbox = await api.studio.github.pulls().then(readApiJson<StudioGitHubInbox>);
        if (active) setReading({ inbox: hideMergedGitHubPulls(inbox), problem: '' });
      } catch (failure) {
        if (active) setReading(previous => ({ inbox: previous.inbox, problem: readableErrorMessage(failure, 'GitHub 暂时读不到') }));
      }
    };
    const tick = () => { void load(); };
    tick();
    const timer = window.setInterval(tick, GITHUB_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [enabled, paused]);

  return reading;
}
