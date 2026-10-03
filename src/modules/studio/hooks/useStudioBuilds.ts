import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { api, readApiJson } from '@/shared/api';
import type { HubProject, StudioBuild, StudioHomeTile } from '@/shared/types';

// How often builds are polled while at least one is queued or running; nothing polls otherwise.
const POLL_MS = 3000;
// How long a finished icon keeps its overlay for the light-up moment (the sequence in studio-builds.css).
const LIGHT_UP_MS = 1700;
// The ring never sits empty while the agent plans, and never looks full before the build has really ended.
const PLANNING_FLOOR = 0.04;
const RUNNING_CEILING = 0.96;
const CANCELLED = '已取消';

const isActive = (build: StudioBuild) => build.state === 'queued' || build.state === 'building';
/**
 * The workbench session doing the work, where a tap on a building or failed icon goes: the workbench's
 * `/work/:projectId/s/:sessionId` route (IDE project id + app session id). A build without an IDE project id falls
 * back to `/session/:sessionId`, which the workbench resolves to its project and redirects.
 */
const workbenchUrl = (build: StudioBuild) => (build.ideProjectId
  ? `/work/${encodeURIComponent(build.ideProjectId)}/s/${encodeURIComponent(build.sessionId)}`
  : `/session/${encodeURIComponent(build.sessionId)}`);

// Checked-off steps, with half a step of credit for the one in progress so the arc keeps moving between ticks.
function ringValue(build: StudioBuild) {
  if (!build.total) return PLANNING_FLOOR;
  const value = (build.completed + (build.currentTask ? 0.5 : 0)) / build.total;
  return Math.min(RUNNING_CEILING, Math.max(PLANNING_FLOOR, value));
}

/**
 * Used by StudioPage for App Store-style AI builds on the home screen: polls `/api/studio/builds` every few seconds
 * only while a build is queued or running, turns each build into its tile's `progress` (and a workbench link while it
 * is unfinished), announces finished and failed builds, and runs stop and continue.
 */
export function useStudioBuilds(projects: HubProject[] | null) {
  // The signed-in user's builds as last polled; null until the first answer.
  const [builds, setBuilds] = useState<StudioBuild[] | null>(null);
  // Hub projects whose build just finished: their icon keeps its overlay while the ring completes and the veil lifts.
  const [lightingUp, setLightingUp] = useState<string[]>([]);
  // A running build waiting for the owner to confirm stopping it.
  const [pendingStop, setPendingStop] = useState<StudioBuild | null>(null);
  // Last state seen per build, so only transitions witnessed in this visit are announced (never old results).
  const seen = useRef(new Map<string, StudioBuild['state']>());
  // Project names for announcements, read when a poll lands rather than re-creating the poll on every project change.
  const projectsRef = useRef(projects);
  // Light-up timers, cleared if the home screen unmounts mid-moment.
  const timers = useRef<number[]>([]);
  // When this page last changed each build (start, continue, stop): a poll sent before that knows less than we do.
  const changedAt = useRef(new Map<string, number>());
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);

  const nameOf = useCallback((build: StudioBuild) => projectsRef.current?.find(item => item.id === build.hubProjectId)?.name ?? '项目', []);

  const track = useCallback((build: StudioBuild) => {
    seen.current.set(build.id, build.state);
    changedAt.current.set(build.id, Date.now());
    setBuilds(previous => [...(previous ?? []).filter(item => item.id !== build.id), build]);
  }, []);

  const resume = useCallback(async (build: StudioBuild) => {
    try {
      track(await api.studio.builds.resume(build.id).then(readApiJson<StudioBuild>));
      toast(`继续开发「${nameOf(build)}」`);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : '无法继续开发');
    }
  }, [nameOf, track]);

  const lightUp = useCallback((hubProjectId: string) => {
    setLightingUp(previous => [...previous, hubProjectId]);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    timers.current.push(window.setTimeout(() => setLightingUp(previous => previous.filter(id => id !== hubProjectId)), reduced ? 700 : LIGHT_UP_MS));
  }, []);

  // `requestedAt` is when the poll left: builds this page changed since then keep their newer local copy (a slow
  // poll that answered after 开始开发 must not take the new icon's ring away, nor revive a build just stopped).
  const apply = useCallback((next: StudioBuild[], requestedAt: number) => {
    const newerHere = (id: string) => (changedAt.current.get(id) ?? -Infinity) >= requestedAt;
    for (const build of next) {
      if (newerHere(build.id)) continue;
      const before = seen.current.get(build.id);
      if (before === 'queued' || before === 'building') {
        if (build.state === 'done') {
          toast.success(`「${nameOf(build)}」已开发完成`);
          lightUp(build.hubProjectId);
        } else if (build.state === 'failed' && build.error !== CANCELLED) {
          toast(`「${nameOf(build)}」没有完成`, {
            description: build.error ?? undefined,
            action: { label: '继续开发', onClick: () => void resume(build) },
            duration: 8000,
          });
        }
      }
      seen.current.set(build.id, build.state);
    }
    setBuilds(previous => {
      const listed = new Set(next.map(build => build.id));
      const merged = next.map(build => (newerHere(build.id) ? previous?.find(item => item.id === build.id) ?? build : build));
      return [...merged, ...(previous ?? []).filter(build => !listed.has(build.id) && newerHere(build.id))];
    });
  }, [lightUp, nameOf, resume]);

  const load = useCallback(async () => {
    const requestedAt = Date.now();
    try {
      // Called through a promise so a server (or test double) without the builds API simply has no builds.
      const next = await Promise.resolve().then(() => api.studio.builds.list()).then(readApiJson<StudioBuild[]>);
      if (Array.isArray(next)) apply(next, requestedAt);
    } catch {
      // Rings are an overlay on the home screen: a failed poll keeps the last known state and tries again.
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);
  const polling = Boolean(builds?.some(isActive));
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, POLL_MS);
    // Coming back to the tab catches up at once instead of waiting for the next tick.
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [polling, load]);

  const byProject = useMemo(() => new Map((builds ?? []).map(build => [build.hubProjectId, build])), [builds]);

  // What a project's tile shows for its build; an empty patch once it is an ordinary app.
  const tileFor = useCallback((hubProjectId: string): Pick<StudioHomeTile, 'progress' | 'href'> => {
    if (lightingUp.includes(hubProjectId)) return { progress: { value: 1, state: 'done', label: '已完成' } };
    const build = byProject.get(hubProjectId);
    if (!build || build.state === 'done') return {};
    const href = workbenchUrl(build);
    if (build.state === 'queued') return { href, progress: { value: 0, state: 'queued', label: '排队中' } };
    if (build.state === 'building') {
      return { href, progress: build.total ? { value: ringValue(build), state: 'building' } : { value: PLANNING_FLOOR, state: 'building', label: '规划中' } };
    }
    return { href, progress: { value: build.total ? build.completed / build.total : 0, state: 'failed', label: build.error === CANCELLED ? '已停止' : '未完成' } };
  }, [byProject, lightingUp]);

  const act = useCallback((hubProjectId: string, action: 'stop' | 'resume') => {
    const build = byProject.get(hubProjectId);
    if (!build) return;
    if (action === 'stop') setPendingStop(build); else void resume(build);
  }, [byProject, resume]);

  const confirmStop = useCallback(async () => {
    const build = pendingStop;
    setPendingStop(null);
    if (!build) return;
    try {
      track(await api.studio.builds.cancel(build.id).then(readApiJson<StudioBuild>));
      toast(`已停止开发「${nameOf(build)}」`);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : '无法停止开发');
    }
  }, [nameOf, pendingStop, track]);
  const cancelStop = useCallback(() => setPendingStop(null), []);

  return {
    tileFor, track, act, confirmStop, cancelStop,
    // The build awaiting a stop confirmation and its project name, for the alert.
    pendingStop: pendingStop ? { build: pendingStop, name: projects?.find(item => item.id === pendingStop.hubProjectId)?.name ?? '项目' } : null,
  };
}
