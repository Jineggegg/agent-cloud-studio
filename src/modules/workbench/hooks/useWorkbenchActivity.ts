import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { WorkbenchProjectActivity } from '@/shared/types';

// Frames that arrive together (a run ending and settling) are read once.
const FRAME_DEBOUNCE_MS = 150;
// Fallback when frames may be missed: slow while the socket is up, quicker while it is down.
const POLL_CONNECTED_MS = 30_000;
const POLL_DISCONNECTED_MS = 10_000;

type ActivityPayload = { projects?: Record<string, Partial<WorkbenchProjectActivity>> };

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// Keeps the projects with something to show, in the shape the switcher reads; anything malformed reads as idle.
function parseActivity(payload: ActivityPayload): Record<string, WorkbenchProjectActivity> {
  const projects: Record<string, WorkbenchProjectActivity> = {};
  for (const [projectId, entry] of Object.entries(payload.projects ?? {})) {
    const running = count(entry?.running);
    const attention = count(entry?.attention);
    if (!running && !attention) continue;
    const ids = Array.isArray(entry?.attentionSessionIds) ? entry.attentionSessionIds.filter((id): id is string => typeof id === 'string') : [];
    projects[projectId] = { running, attention, attentionSessionIds: ids };
  }
  return projects;
}

/**
 * Used by the workbench shell for the project switcher's marks: which projects run something now and which need
 * the owner, keyed by IDE project id (null until the first read). Read on mount and whenever the chat socket
 * (re)connects, again on every `workbench_activity` frame, and by a slow poll only as a fallback.
 */
export function useWorkbenchActivity(): Record<string, WorkbenchProjectActivity> | null {
  const { subscribe, isConnected } = useWebSocket();
  // The latest marks; replaced only when they change, so an unchanged read does not re-render the sidebar.
  const [activity, setActivity] = useState<Record<string, WorkbenchProjectActivity> | null>(null);
  // The newest read wins: an older response that lands last is dropped.
  const generation = useRef(0);
  const lastKey = useRef('');

  const load = useCallback(async () => {
    const requested = ++generation.current;
    try {
      const response = await api.studio.workbench.activity();
      const next = parseActivity(await readApiJson<ActivityPayload>(response));
      if (requested !== generation.current) return;
      const key = JSON.stringify(next);
      if (key === lastKey.current) return;
      lastKey.current = key;
      setActivity(next);
    } catch {
      // Offline or signed out: the marks keep their last state until a read succeeds.
    }
  }, []);

  // On mount and after every reconnect (frames sent while the socket was down are lost).
  useEffect(() => {
    if (isConnected === false) return undefined;
    // Scheduled rather than called in the effect body, so a quick reconnect flap reads once.
    const read = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(read);
  }, [isConnected, load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(event => {
      if (event.kind !== 'workbench_activity') return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), FRAME_DEBOUNCE_MS);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [subscribe, load]);

  useEffect(() => {
    const readIfVisible = () => { if (document.visibilityState === 'visible') void load(); };
    const interval = window.setInterval(readIfVisible, isConnected === false ? POLL_DISCONNECTED_MS : POLL_CONNECTED_MS);
    document.addEventListener('visibilitychange', readIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', readIfVisible);
    };
  }, [isConnected, load]);

  return activity;
}
