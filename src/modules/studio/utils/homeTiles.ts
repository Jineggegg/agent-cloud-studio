import type { StudioTileProgress } from '@/shared/types';

// True from the home screen's mount until it has filled for the first time (its projects loaded): only icons that mount
// by then rise in; anything mounting later (a page change, a new project, an icon back from the library) simply
// appears. Module state, not React state, because it is read once by each icon as it mounts and never drives a render.
let homeFilling = true;

/** Called by the home screen: true as it mounts, false once its projects have loaded. */
export function setHomeFilling(value: boolean) { homeFilling = value; }

/** Read by each icon once, as it mounts (StudioHomeTiles). */
export function isHomeFilling() { return homeFilling; }

/** The status an AI build gives its tile, in words, for the accessible name. */
export const buildStatusText = (progress: StudioTileProgress) => progress.label ?? `开发中 ${Math.round(progress.value * 100)}%`;
