/*
 * The home screen's paging, as pure functions: UIScrollView's rubber band past the first and last page, the page a
 * release settles on, the spring that carries it there, and how many icons fit on a page. useHomePager drives the
 * gesture with these; StudioHomeScreen splits the icons into pages with the last two.
 */

/** A damped spring: `response` is roughly its period in seconds, `damping` its ratio (1 = critically damped). */
type SpringConfig = { response: number; damping: number };
/** Where a spring is and how fast it moves, in px and px/s. */
type SpringState = { position: number; velocity: number };
/** One page of icons: the half-open range [start, end) of the home screen's item order. */
type PageRange = { start: number; end: number };

// iOS paging: critically damped, so a page lands without overshooting, about as quickly as UIScrollView settles.
export const PAGING_SPRING: SpringConfig = { response: 0.42, damping: 1 };
// UIScrollView's rubber-band constant: the further past the edge, the less the content follows the finger.
const RUBBER_BAND_COEFFICIENT = 0.55;
// A release at least this fast (px/s) turns the page even when the finger moved less than half a page.
const FLICK_VELOCITY = 300;
// Fixed integration steps keep the spring stable and identical at 60 Hz, 120 Hz or a dropped frame.
const SPRING_SUBSTEP_S = 1 / 480;
// Close enough to the target, and slow enough, that the next frame would not visibly move.
const REST_DISTANCE_PX = 0.25;
const REST_VELOCITY = 4;

/** How far content follows a pull of `overshoot` px past its edge, in a viewport `dimension` px wide. */
export function rubberBand(overshoot: number, dimension: number): number {
  if (dimension <= 0 || overshoot === 0) return 0;
  const distance = Math.abs(overshoot);
  return Math.sign(overshoot) * (1 - 1 / (distance * RUBBER_BAND_COEFFICIENT / dimension + 1)) * dimension;
}

/** A track offset with any part beyond [min, max] rubber-banded. */
export function applyRubberBand(offset: number, min: number, max: number, dimension: number): number {
  if (offset > max) return max + rubberBand(offset - max, dimension);
  if (offset < min) return min + rubberBand(offset - min, dimension);
  return offset;
}

/**
 * The page a released swipe settles on. `position` is where the track is, in pages (1.4 = 40% of the way from the
 * second page to the third), `velocity` the finger's speed in px/s (negative = moving left, towards later pages).
 * A flick goes on in its direction; a slow release goes to the nearest page. A swipe never turns more than one
 * page from `startPage`, as on the iPad home screen.
 */
export function targetPage({ position, velocity, startPage, pageCount }: { position: number; velocity: number; startPage: number; pageCount: number }): number {
  let target = Math.round(position);
  if (velocity < -FLICK_VELOCITY) target = Math.floor(position) + 1;
  if (velocity > FLICK_VELOCITY) target = Math.ceil(position) - 1;
  target = Math.max(startPage - 1, Math.min(startPage + 1, target));
  return Math.max(0, Math.min(pageCount - 1, target));
}

/** Advances a spring towards `target` by `seconds`, in fixed sub-steps (semi-implicit Euler, unit mass). */
export function springStep(state: SpringState, target: number, seconds: number, config: SpringConfig = PAGING_SPRING): SpringState {
  const stiffness = (2 * Math.PI / config.response) ** 2;
  const friction = 4 * Math.PI * config.damping / config.response;
  let { position, velocity } = state;
  let remaining = Math.max(0, seconds);
  while (remaining > 0) {
    const step = Math.min(SPRING_SUBSTEP_S, remaining);
    velocity += (-stiffness * (position - target) - friction * velocity) * step;
    position += velocity * step;
    remaining -= step;
  }
  return { position, velocity };
}

/** Whether a spring has come to rest on `target`. */
export function springAtRest(state: SpringState, target: number): boolean {
  return Math.abs(state.position - target) < REST_DISTANCE_PX && Math.abs(state.velocity) < REST_VELOCITY;
}

/** How many grid cells fit in `available` px of height: whole rows only, never a row cut off at the bottom. */
export function gridCapacity({ available, rowHeight, rowGap, columns }: { available: number; rowHeight: number; rowGap: number; columns: number }): number {
  if (rowHeight <= 0 || columns <= 0) return 0;
  // Half a pixel of slack absorbs sub-pixel rounding in the measured sizes.
  const rows = Math.floor((available + rowGap + 0.5) / (rowHeight + rowGap));
  return Math.max(0, rows) * columns;
}

/**
 * Splits `itemCount` items into pages: the first page holds `firstCapacity` (it shares the screen with the widgets,
 * and may hold none), every later one `pageCapacity`. Without a measured capacity everything stays on one page.
 */
export function pageRanges(itemCount: number, firstCapacity: number | null, pageCapacity: number): PageRange[] {
  if (firstCapacity === null || itemCount <= firstCapacity) return [{ start: 0, end: itemCount }];
  const ranges: PageRange[] = [{ start: 0, end: Math.max(0, firstCapacity) }];
  const perPage = Math.max(1, pageCapacity);
  for (let start = ranges[0].end; start < itemCount; start += perPage) ranges.push({ start, end: Math.min(itemCount, start + perPage) });
  return ranges;
}
