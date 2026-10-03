import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  STAR_INNER_REACH, STAR_OUTLINE, STAR_TIP, STAR_ZOOM_EASE, cubicBezier, haloAngle, placeStarOutline, runStarZoom,
  sampleStarOutline, starCoverRadius, starWindowHole, starWindowPolygon, turnRemaining,
} from '@/shared/ui/starSpark';

const reach = ([x, y]: readonly [number, number]) => Math.hypot(x, y);

test('the outline is 64 points evenly along the star, from the top tip clockwise through the other three tips', () => {
  expect(STAR_OUTLINE).toHaveLength(64);
  const tips = [0, 16, 32, 48].map(index => STAR_OUTLINE[index]);
  [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([x, y], index) => {
    expect(tips[index][0]).toBeCloseTo(x, 3);
    expect(tips[index][1]).toBeCloseTo(y, 3);
  });
  expect(Math.max(...STAR_OUTLINE.map(reach))).toBeCloseTo(1, 3);
  // Evenly spaced along the curve: neighbouring points all about the same distance apart.
  const gaps = STAR_OUTLINE.map((point, index) => {
    const next = STAR_OUTLINE[(index + 1) % STAR_OUTLINE.length];
    return Math.hypot(next[0] - point[0], next[1] - point[1]);
  });
  expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.1);
});

test('the inner curves come to about 38 % of the tips\' reach, halfway between two tips', () => {
  expect(STAR_INNER_REACH).toBeGreaterThan(0.37);
  expect(STAR_INNER_REACH).toBeLessThan(0.39);
  expect(reach(STAR_OUTLINE[8])).toBeCloseTo(STAR_INNER_REACH, 6);
  expect(sampleStarOutline(8)).toHaveLength(8);
});

test('the star window is a polygon of the outline scaled to the radius round the centre', () => {
  const window = starWindowPolygon(200, 300, 50);
  expect(window.startsWith('polygon(200.0px 250.0px, ')).toBe(true);
  expect(window.split(',')).toHaveLength(64);
  expect(window).toContain('250.0px 300.0px');
  // At radius 0 it is a pinpoint: the whole element is hidden.
  expect(new Set(starWindowPolygon(10, 20, 0).slice(8, -1).split(', '))).toEqual(new Set(['10.0px 20.0px']));
});

test('the star hole cuts the same star out of the whole area, for a cover the destination shows through', () => {
  const hole = starWindowHole(200, 300, 50, 400, 600);
  expect(hole.startsWith('path(evenodd, "M0 0H400.0V600.0H0Z M200.0 250.0 L')).toBe(true);
  expect(hole.endsWith('Z")')).toBe(true);
});

test('the window grows until even its inner curves are past every corner of the screen', () => {
  for (const [x, y] of [[500, 400], [40, 40], [960, 780]]) {
    const radius = starCoverRadius(x, y, 1000, 800);
    const farthestCorner = Math.hypot(Math.max(x, 1000 - x), Math.max(y, 800 - y));
    expect(radius * STAR_INNER_REACH).toBeGreaterThan(farthestCorner);
  }
});

test('the cubic-bezier easing matches CSS: fixed ends, linear when straight, the zoom slow to start', () => {
  const linear = cubicBezier(0, 0, 1, 1);
  expect(linear(0)).toBe(0);
  expect(linear(1)).toBe(1);
  expect(linear(0.3)).toBeCloseTo(0.3, 4);
  expect(STAR_ZOOM_EASE(0.2)).toBeLessThan(0.1);
  expect(STAR_ZOOM_EASE(0.8)).toBeGreaterThan(0.9);
  let previous = 0;
  for (let step = 1; step <= 20; step++) {
    const value = STAR_ZOOM_EASE(step / 20);
    expect(value).toBeGreaterThanOrEqual(previous);
    previous = value;
  }
});

test('a turning star rests at the end of its current quarter turn; the halo turns backwards', () => {
  expect(turnRemaining(0)).toBe(0);
  expect(turnRemaining(-50)).toBe(0);
  expect(turnRemaining(300)).toBe(600);
  expect(turnRemaining(900)).toBe(0);
  expect(turnRemaining(1100)).toBe(700);
  // Barely started (the eased turn has moved about a degree): taken as upright at once.
  expect(turnRemaining(950)).toBe(0);
  expect(haloAngle(450)).toBeCloseTo(-90);
  expect(haloAngle(1800 + 900)).toBeCloseTo(-180);
  expect(haloAngle(0)).toBe(0);
});

test('the outline is sized so its tips sit on the window edge, and fades over the second half', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  placeStarOutline(svg, 100, 200, STAR_TIP, 0.3);
  expect(svg.style.width).toBe('100px');
  expect(svg.style.left).toBe('50px');
  expect(svg.style.top).toBe('150px');
  expect(svg.style.opacity).toBe('1');
  placeStarOutline(svg, 100, 200, STAR_TIP, 1);
  expect(svg.style.opacity).toBe('0');
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// Animation frames on the fake clock, each stamped 16 ms after the last.
function frameClock() {
  let clock = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(clock += 16), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(handle => window.clearTimeout(handle));
}

test('the zoom grows the window frame by frame from the start radius to the cover radius, then finishes once', () => {
  frameClock();
  const radii: number[] = [];
  const onDone = vi.fn();
  runStarZoom({ from: 40, to: 1000, onFrame: radius => radii.push(radius), onDone });
  expect(radii).toEqual([40]);
  vi.advanceTimersByTime(500);
  expect(onDone).not.toHaveBeenCalled();
  vi.advanceTimersByTime(600);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(radii.at(-1)).toBe(1000);
  expect(radii.every((radius, index) => index === 0 || radius >= radii[index - 1])).toBe(true);
  vi.advanceTimersByTime(2000);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test('a zoom that gets no animation frames finishes after a short wait instead of hanging half open', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
  const onDone = vi.fn();
  runStarZoom({ from: 40, to: 1000, onFrame: () => {}, onDone });
  vi.advanceTimersByTime(399);
  expect(onDone).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test('a cancelled zoom stops without finishing', () => {
  frameClock();
  const onFrame = vi.fn();
  const onDone = vi.fn();
  const stop = runStarZoom({ from: 40, to: 1000, onFrame, onDone });
  vi.advanceTimersByTime(100);
  stop();
  const frames = onFrame.mock.calls.length;
  vi.advanceTimersByTime(3000);
  expect(onFrame).toHaveBeenCalledTimes(frames);
  expect(onDone).not.toHaveBeenCalled();
});
