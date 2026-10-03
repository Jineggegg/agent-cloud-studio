import NumberFlow from '@number-flow/react';
import { m } from 'motion/react';

import type { StudioTileProgress } from '@/shared/types';
import '@/modules/studio/studio-builds.css';

// Critically damped, so the arc glides to each new step and never swings back past it.
const RING_SPRING = { type: 'spring', stiffness: 70, damping: 18, mass: 1 } as const;
// While queued the arc is a short segment that circles (studio-builds.css spins it).
const QUEUED_ARC = 0.22;

/**
 * Used by StudioHomeScreen for the words under a building icon: the progress's own label (排队中, 规划中, 未完成 …),
 * or 开发中 with a percentage whose digits roll as the agent checks steps off.
 */
export function StudioBuildStatus({ progress }: { progress: StudioTileProgress }) {
  return <span className={`home-status build-status is-${progress.state}`}>
    {progress.label ?? <>开发中 <NumberFlow value={Math.round(progress.value * 100)} suffix="%" /></>}
  </span>;
}

/**
 * Used by StudioHomeScreen and StudioBuildComposer as the children of StudioTileIcon, to show an AI build on the icon's
 * face the App Store way: the icon dims under a dark veil while a thin ring fills (queued builds circle, a planning
 * build breathes); a finished build completes the ring, the veil lifts and a light sweeps across; a failed one keeps a
 * soft veil (StudioBuildBadge marks it). Purely visual: the tile carries the accessible status.
 */
export function StudioBuildProgress({ progress }: { progress: StudioTileProgress }) {
  const value = progress.state === 'done' ? 1 : Math.min(1, Math.max(0, progress.value));
  const offset = progress.state === 'queued' ? 1 - QUEUED_ARC : 1 - value;
  // A building ring with its own label has no numbers yet: the agent is still writing its plan.
  const planning = progress.state === 'building' && Boolean(progress.label);
  return <span className="build-overlay" data-state={progress.state} data-planning={planning || undefined} aria-hidden="true">
    <span className="build-veil" />
    {progress.state !== 'failed' && <svg className="build-ring" viewBox="0 0 40 40" focusable="false">
      <circle className="build-ring-track" cx="20" cy="20" r="15.5" pathLength={1} />
      <m.circle className="build-ring-arc" cx="20" cy="20" r="15.5" pathLength={1} strokeDasharray="1 1"
        initial={false} animate={{ strokeDashoffset: offset }} transition={RING_SPRING} />
    </svg>}
    {progress.state === 'done' && <span className="build-sheen" />}
  </span>;
}

/** Used by StudioHomeScreen beside the icon of a build that did not finish, like an iOS badge: it needs a look. */
export function StudioBuildBadge() {
  return <span className="build-badge" aria-hidden="true">
    <svg viewBox="0 0 16 16" focusable="false"><path d="M8 4.3v4.5" /><circle cx="8" cy="11.7" r="1.1" /></svg>
  </span>;
}
