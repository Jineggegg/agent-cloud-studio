/**
 * The four-pointed spark (the Studio's launch mark): its geometry, and the small pieces of maths and DOM work behind its
 * "star window" zoom. Used by the launch screen (LaunchScreen.tsx, with the markup and styles inline in index.html) and
 * by the studio module when an app opens from its icon (StudioAppLaunch). The star's lines draw in, it turns in quarter
 * turns while something loads, and then it grows into a star-shaped window through which the destination shows, its
 * outline riding the window's edge as a thin line.
 */

// viewBox 0 0 100 100, centre 50 50: the star in one closed stroke, and the two arcs of the halo round it.
export const STAR_PATH = 'M50 16 C53 40 60 47 84 50 C60 53 53 60 50 84 C47 60 40 53 16 50 C40 47 47 40 50 16 Z';
export const HALO_PATHS = ['M50 4 A46 46 0 0 1 96 50', 'M50 96 A46 46 0 0 1 4 50'] as const;
// How far the star's tips reach from the centre, in viewBox units.
export const STAR_TIP = 34;
// The stroke gradient, top left to bottom right: blue, mint, orange (index.html spells the same stops out).
export const STAR_GRADIENT = [['0', '#2f8cff'], ['.5', '#18c29c'], ['1', '#ff8a1f']] as const;

// One quarter turn of the star while loading (it then rests, four-fold symmetric, looking upright again), and one full
// turn of the halo the other way. They match the acs-star-turn and acs-star-halo keyframes in index.html.
export const STAR_TURN_MS = 900;
export const HALO_TURN_MS = 1800;
// The zoom through the star window.
export const STAR_ZOOM_MS = 1000;
// A zoom that gets no animation frame at all within this long (a throttled or hidden tab) finishes at once.
const ZOOM_STARVED_MS = 400;
// A zoom whose frames stall midway still finishes this long after it should have.
const ZOOM_DEADLINE_SLACK_MS = 250;
// Beyond the screen's corners, so neither the polygon's chords nor the outline's stroke leave a sliver uncovered.
const COVER_MARGIN_PX = 40;

type Point = readonly [number, number];
type Cubic = readonly [Point, Point, Point, Point];

// STAR_PATH as its four cubic segments, starting at the top tip and running clockwise.
const STAR_SEGMENTS: readonly Cubic[] = [
  [[50, 16], [53, 40], [60, 47], [84, 50]],
  [[84, 50], [60, 53], [53, 60], [50, 84]],
  [[50, 84], [47, 60], [40, 53], [16, 50]],
  [[16, 50], [40, 47], [47, 40], [50, 16]],
];

function cubicPoint([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u; const b = 3 * u * u * t; const c = 3 * u * t * t; const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/**
 * The star's outline as `count` points spaced evenly along its length, from the top tip clockwise, each relative to the
 * centre in units of the tip's reach (so a tip is 1 away). Scaled by a radius, they make a clip-path window of any size.
 */
export function sampleStarOutline(count: number, steps = 256): Point[] {
  const dense: Point[] = [];
  for (const segment of STAR_SEGMENTS) for (let step = 0; step < steps; step++) dense.push(cubicPoint(segment, step / steps));
  dense.push(dense[0]);
  const lengths = [0];
  for (let index = 1; index < dense.length; index++) {
    lengths.push(lengths[index - 1] + Math.hypot(dense[index][0] - dense[index - 1][0], dense[index][1] - dense[index - 1][1]));
  }
  const total = lengths[lengths.length - 1];
  const points: Point[] = [];
  let at = 1;
  for (let index = 0; index < count; index++) {
    const target = (total * index) / count;
    while (lengths[at] < target) at++;
    const span = lengths[at] - lengths[at - 1];
    const share = span > 0 ? (target - lengths[at - 1]) / span : 0;
    const x = dense[at - 1][0] + (dense[at][0] - dense[at - 1][0]) * share;
    const y = dense[at - 1][1] + (dense[at][1] - dense[at - 1][1]) * share;
    points.push([(x - 50) / STAR_TIP, (y - 50) / STAR_TIP]);
  }
  return points;
}

// 64 points: smooth at any size, cheap to rebuild every frame.
export const STAR_OUTLINE = sampleStarOutline(64);
// The closest the outline comes to the centre (the inner curves, about 38 % of the tips' reach).
export const STAR_INNER_REACH = Math.min(...STAR_OUTLINE.map(([x, y]) => Math.hypot(x, y)));

const px = (value: number) => value.toFixed(1);

/** The star outline, its tips `radius` px from (x, y), as a CSS polygon() for clip-path: a window through to the element. */
export function starWindowPolygon(x: number, y: number, radius: number): string {
  return `polygon(${STAR_OUTLINE.map(([dx, dy]) => `${px(x + dx * radius)}px ${px(y + dy * radius)}px`).join(', ')})`;
}

/**
 * The same star cut as a hole out of a `width` x `height` rectangle, as a CSS path() for clip-path: a cover that keeps
 * everything outside the star and lets what lies beneath show through it.
 */
export function starWindowHole(x: number, y: number, radius: number, width: number, height: number): string {
  const star = STAR_OUTLINE.map(([dx, dy], index) => `${index ? 'L' : 'M'}${px(x + dx * radius)} ${px(y + dy * radius)}`).join(' ');
  return `path(evenodd, "M0 0H${px(width)}V${px(height)}H0Z ${star}Z")`;
}

/** How far the star's tips must reach from (x, y) before even its inner curves clear every corner of the area. */
export function starCoverRadius(x: number, y: number, width: number, height: number): number {
  return Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) / STAR_INNER_REACH + COVER_MARGIN_PX;
}

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of time in [0, 1] (solved by bisection, plenty for animation). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (time: number) => number {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return time => {
    if (time <= 0) return 0;
    if (time >= 1) return 1;
    let low = 0; let high = 1; let t = time;
    for (let step = 0; step < 24; step++) {
      t = (low + high) / 2;
      if (at(x1, x2, t) < time) low = t; else high = t;
    }
    return at(y1, y2, t);
  };
}

// The zoom's easing: a slow start that gathers pace, then a long soft landing.
export const STAR_ZOOM_EASE = cubicBezier(0.7, 0, 0.2, 1);

// The eased quarter turn barely moves in its first 100 ms (about 1°), so a star stopped then counts as upright: a
// release just after a turn began (the usual fast start, a frame or two after the draw-in) is not held a whole turn.
const TURN_SNAP_MS = 100;

/**
 * How long until a turn of `period` ms that has run for `elapsed` ms comes to the end of its current turn: 0 between
 * turns and in a turn's first TURN_SNAP_MS, when it has hardly moved yet.
 */
export function turnRemaining(elapsed: number, period = STAR_TURN_MS): number {
  if (!(elapsed > 0)) return 0;
  const into = elapsed % period;
  return into <= TURN_SNAP_MS ? 0 : period - into;
}

/** The halo's angle (it turns backwards, once per HALO_TURN_MS) after turning for `elapsed` ms. */
export function haloAngle(elapsed: number): number {
  return elapsed > 0 ? (-360 * (elapsed % HALO_TURN_MS)) / HALO_TURN_MS : 0;
}

/**
 * How long the CSS animation `name` on `element` has been running past its delay, read from the browser itself so it
 * matches what is on screen; null when it is not running, undefined where the browser cannot tell (no getAnimations).
 */
function cssAnimationElapsed(element: Element, name: string): number | null | undefined {
  if (typeof element.getAnimations !== 'function') return undefined;
  const animation = element.getAnimations().find(item => (item as CSSAnimation).animationName === name);
  if (!animation || animation.currentTime === null) return null;
  return Number(animation.currentTime) - Number(animation.effect?.getTiming().delay ?? 0);
}

/**
 * How long until the turning star in `svg` (an `.acs-star`) finishes its current quarter turn and rests upright.
 * `fallbackElapsed` is how long it has been turning, for browsers that cannot report their animations.
 */
export function starTurnRemaining(svg: Element, fallbackElapsed: number): number {
  const spark = svg.querySelector('.acs-star-spark');
  const elapsed = spark ? cssAnimationElapsed(spark, 'acs-star-turn') : null;
  return turnRemaining(elapsed === undefined ? fallbackElapsed : elapsed ?? 0);
}

/** Holds the halo of `svg` at the angle it has turned to, so it stays put once its turning animation is taken off. */
export function freezeStarHalo(svg: Element, fallbackElapsed: number) {
  const halo = svg.querySelector<SVGGElement>('.acs-star-halo');
  if (!halo) return;
  const elapsed = cssAnimationElapsed(halo, 'acs-star-halo');
  halo.style.transform = `rotate(${haloAngle(elapsed === undefined ? fallbackElapsed : elapsed ?? 0).toFixed(2)}deg)`;
}

/**
 * Sizes and places the star svg (absolutely positioned in a full-screen layer) so its star's tips reach `radius` px from
 * (x, y), exactly on the window's edge; the outline fades out over the second half of the zoom (`progress` 0 to 1).
 */
export function placeStarOutline(svg: SVGElement, x: number, y: number, radius: number, progress: number) {
  const size = (radius * 100) / STAR_TIP;
  svg.style.margin = '0';
  svg.style.left = `${px(x - size / 2)}px`;
  svg.style.top = `${px(y - size / 2)}px`;
  svg.style.width = `${px(size)}px`;
  svg.style.height = `${px(size)}px`;
  svg.style.opacity = String(progress < 0.45 ? 1 : Math.max(0, 1 - (progress - 0.45) / 0.55));
}

/**
 * Runs the star-window zoom: every animation frame `onFrame` gets the window's radius (from `from` to `to` px, eased) and
 * the progress, so the window and the outline drawn on its edge move in step; `onDone` runs once at the end. Without
 * frames (a hidden or throttled tab) it finishes after a short wait instead of leaving things half open. Returns a
 * canceller that stops it without calling `onDone`.
 */
export function runStarZoom({ from, to, duration = STAR_ZOOM_MS, onFrame, onDone }: {
  from: number; to: number; duration?: number; onFrame: (radius: number, progress: number) => void; onDone: () => void;
}): () => void {
  let stopped = false;
  let started: number | null = null;
  let frame = 0;
  let starved = 0;
  let deadline = 0;
  const stop = () => {
    stopped = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(starved);
    window.clearTimeout(deadline);
  };
  const finish = () => {
    if (stopped) return;
    stop();
    onDone();
  };
  const step = (now: number) => {
    if (stopped) return;
    if (started === null) {
      started = now;
      window.clearTimeout(starved);
    }
    const progress = Math.min(1, (now - started) / duration);
    onFrame(from + (to - from) * STAR_ZOOM_EASE(progress), progress);
    if (progress >= 1) finish(); else frame = window.requestAnimationFrame(step);
  };
  onFrame(from, 0);
  starved = window.setTimeout(finish, ZOOM_STARVED_MS);
  deadline = window.setTimeout(finish, duration + ZOOM_DEADLINE_SLACK_MS);
  frame = window.requestAnimationFrame(step);
  return stop;
}
