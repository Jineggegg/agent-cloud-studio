import { describe, expect, test } from 'vitest';

import { PAGING_SPRING, applyRubberBand, gridCapacity, pageRanges, rubberBand, springAtRest, springStep, targetPage } from '@/modules/studio/utils/homePaging';

// Runs a spring at 60 Hz until it rests (or gives up after `limit` seconds); returns every position it passed.
function settle(start: number, velocity: number, target: number, limit = 3) {
  let state = { position: start, velocity };
  const positions = [start];
  for (let time = 0; time < limit && !springAtRest(state, target); time += 1 / 60) {
    state = springStep(state, target, 1 / 60, PAGING_SPRING);
    positions.push(state.position);
  }
  return { state, positions };
}

describe('rubber band', () => {
  test('follows UIScrollView: (1 − 1 / (d · 0.55 / W + 1)) · W, in the direction of the pull', () => {
    expect(rubberBand(200, 1000)).toBeCloseTo((1 - 1 / (200 * 0.55 / 1000 + 1)) * 1000, 6);
    expect(rubberBand(-200, 1000)).toBeCloseTo(-rubberBand(200, 1000), 6);
    expect(rubberBand(0, 1000)).toBe(0);
  });

  test('gives less and less the further it is pulled, and never reaches a full page', () => {
    const pulls = [10, 100, 400, 1000, 5000, 50_000].map(distance => rubberBand(distance, 1000));
    pulls.forEach((offset, index) => {
      expect(offset).toBeLessThan([10, 100, 400, 1000, 5000, 50_000][index]);
      if (index) expect(offset).toBeGreaterThan(pulls[index - 1]);
    });
    expect(pulls.at(-1)!).toBeLessThan(1000);
  });

  test('only the part past the first or last page is damped', () => {
    // Three pages 1000 px wide: the track runs from 0 to −2000.
    expect(applyRubberBand(-1500, -2000, 0, 1000)).toBe(-1500);
    expect(applyRubberBand(150, -2000, 0, 1000)).toBeCloseTo(rubberBand(150, 1000), 6);
    expect(applyRubberBand(-2150, -2000, 0, 1000)).toBeCloseTo(-2000 - rubberBand(150, 1000), 6);
  });
});

describe('target page', () => {
  const pages = { startPage: 1, pageCount: 4 };

  test('a slow release goes to the nearest page', () => {
    expect(targetPage({ position: 1.4, velocity: -100, ...pages })).toBe(1);
    expect(targetPage({ position: 1.6, velocity: 100, ...pages })).toBe(2);
  });

  test('a flick (over 300 px/s) goes on in its direction even after a short move', () => {
    expect(targetPage({ position: 1.1, velocity: -301, ...pages })).toBe(2);
    expect(targetPage({ position: 0.9, velocity: 301, ...pages })).toBe(0);
    // A flick against the drag turns back to where it came from.
    expect(targetPage({ position: 1.7, velocity: 400, ...pages })).toBe(1);
  });

  test('never more than one page per swipe, and never past the first or last page', () => {
    expect(targetPage({ position: 2.8, velocity: -5000, ...pages })).toBe(2);
    expect(targetPage({ position: -0.2, velocity: 2000, startPage: 0, pageCount: 4 })).toBe(0);
    expect(targetPage({ position: 3.3, velocity: -2000, startPage: 3, pageCount: 4 })).toBe(3);
  });
});

describe('spring', () => {
  test('critically damped: settles on the page without overshooting', () => {
    const { state, positions } = settle(0, 0, -1000);
    expect(springAtRest(state, -1000)).toBe(true);
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(-1000.25);
  });

  test('lands in about the time UIScrollView takes', () => {
    const { positions } = settle(0, 0, -1000);
    const seconds = (positions.length - 1) / 60;
    expect(seconds).toBeGreaterThan(0.4);
    expect(seconds).toBeLessThan(1.2);
  });

  test('carries the release velocity: a flick gets there sooner than a standing start', () => {
    const standing = springStep({ position: -600, velocity: 0 }, -1000, 0.1);
    const flicked = springStep({ position: -600, velocity: -2500 }, -1000, 0.1);
    expect(flicked.position).toBeLessThan(standing.position);
    expect(flicked.position).toBeGreaterThanOrEqual(-1000.25);
  });

  test('gives the same path whether frames arrive at 60 Hz or 120 Hz', () => {
    let sixty = { position: 0, velocity: -800 };
    let oneTwenty = { position: 0, velocity: -800 };
    for (let frame = 0; frame < 12; frame += 1) sixty = springStep(sixty, -1000, 1 / 60);
    for (let frame = 0; frame < 24; frame += 1) oneTwenty = springStep(oneTwenty, -1000, 1 / 120);
    expect(oneTwenty.position).toBeCloseTo(sixty.position, 0);
  });
});

describe('page capacity', () => {
  test('counts whole rows only', () => {
    // Three rows of 130 with two gaps of 30 need 450 px; 449 holds two.
    expect(gridCapacity({ available: 450, rowHeight: 130, rowGap: 30, columns: 6 })).toBe(18);
    expect(gridCapacity({ available: 449, rowHeight: 130, rowGap: 30, columns: 6 })).toBe(12);
    expect(gridCapacity({ available: 289, rowHeight: 130, rowGap: 30, columns: 6 })).toBe(6);
    expect(gridCapacity({ available: 120, rowHeight: 130, rowGap: 30, columns: 6 })).toBe(0);
    expect(gridCapacity({ available: 500, rowHeight: 0, rowGap: 30, columns: 6 })).toBe(0);
  });

  test('splits items into pages: a first page beside the widgets, then full pages', () => {
    expect(pageRanges(13, 8, 12)).toEqual([{ start: 0, end: 8 }, { start: 8, end: 13 }]);
    expect(pageRanges(30, 4, 12)).toEqual([{ start: 0, end: 4 }, { start: 4, end: 16 }, { start: 16, end: 28 }, { start: 28, end: 30 }]);
    // Widgets fill the first page: every icon starts on the second.
    expect(pageRanges(5, 0, 8)).toEqual([{ start: 0, end: 0 }, { start: 0, end: 5 }]);
  });

  test('keeps everything on one page when it fits, or before anything was measured', () => {
    expect(pageRanges(6, 8, 12)).toEqual([{ start: 0, end: 6 }]);
    expect(pageRanges(40, null, 12)).toEqual([{ start: 0, end: 40 }]);
  });
});
