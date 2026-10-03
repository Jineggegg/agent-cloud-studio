import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { StudioFluidBackground } from '@/modules/studio/StudioFluidBackground';

// A 2D context that records what is drawn (each frame: one base fill, one fill per blob); `filter` is kept only when this "browser" supports canvas filters.
function fakeContext({ filters }: { filters: boolean }) {
  const drawn = { bases: 0, blobs: 0, filters: [] as string[] };
  const gradient = () => ({ addColorStop: vi.fn() });
  const context = {
    setTransform: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(),
    fillRect: vi.fn(() => { drawn.bases += 1; }),
    fill: vi.fn(() => { drawn.blobs += 1; }),
    createLinearGradient: vi.fn(gradient), createRadialGradient: vi.fn(gradient),
    fillStyle: '' as unknown,
  } as Record<string, unknown>;
  if (filters) {
    let filter = 'none';
    Object.defineProperty(context, 'filter', { get: () => filter, set: (value: string) => { filter = value; drawn.filters.push(value); } });
  }
  return { context, drawn };
}

let frames: FrameRequestCallback[] = [];
let reducedMotion = false;
let hidden = false;

beforeEach(() => {
  frames = [];
  reducedMotion = false;
  hidden = false;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frames = []; });
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: query.includes('reduced-motion') ? reducedMotion : false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }) as MediaQueryList);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
});
afterEach(cleanup);

function withContext(options: { filters: boolean }) {
  const fake = fakeContext(options);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fake.context as unknown as CanvasRenderingContext2D);
  return fake.drawn;
}

// Runs the next animation frame a given time after the last.
function nextFrame(at: number) {
  const pending = frames;
  frames = [];
  act(() => { for (const callback of pending) callback(at); });
}

test('draws the plain base and three bubbles and keeps them moving, frame after frame', () => {
  const drawn = withContext({ filters: true });
  const { container } = render(<StudioFluidBackground dark paused={false} />);
  expect(container.querySelector('.home-wallpaper canvas.home-blobs')).not.toBeNull();
  expect(container.querySelector('.home-wallpaper .home-blobs-veil')).not.toBeNull();
  expect(drawn.bases).toBe(1);
  expect(drawn.blobs).toBe(3);
  expect(frames).toHaveLength(1);
  nextFrame(performance.now() + 40);
  expect(drawn.bases).toBe(2);
  expect(drawn.blobs).toBe(6);
  expect(frames).toHaveLength(1);
  // The base is drawn sharp; the canvas blurs the blobs itself, at its reduced scale (90 px × 0.25).
  expect(drawn.filters.at(-2)).toBe('none');
  expect(drawn.filters.at(-1)).toMatch(/^blur\(22\.\dpx\)$/);
  expect(container.querySelector('canvas')?.dataset.blur).toBe('canvas');
});

test('under reduced motion it draws one still frame and never animates', () => {
  reducedMotion = true;
  const drawn = withContext({ filters: true });
  render(<StudioFluidBackground dark paused={false} />);
  expect(drawn.blobs).toBe(3);
  expect(frames).toHaveLength(0);
});

test('stops while an app covers the home screen and carries on when it is uncovered', () => {
  const drawn = withContext({ filters: true });
  const { container, rerender } = render(<StudioFluidBackground dark paused />);
  expect(frames).toHaveLength(0);
  expect(container.querySelector('.home-wallpaper')?.classList.contains('is-paused')).toBe(true);
  rerender(<StudioFluidBackground dark paused={false} />);
  expect(frames).toHaveLength(1);
  expect(container.querySelector('.home-wallpaper')?.classList.contains('is-paused')).toBe(false);
  rerender(<StudioFluidBackground dark paused />);
  expect(frames).toHaveLength(0);
  expect(drawn.blobs).toBeGreaterThan(0);
});

test('stops while the page is hidden', () => {
  withContext({ filters: true });
  render(<StudioFluidBackground dark={false} paused={false} />);
  expect(frames).toHaveLength(1);
  hidden = true;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(frames).toHaveLength(0);
  hidden = false;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(frames).toHaveLength(1);
});

test('without canvas filters the CSS blur does the softening; without a canvas the gradient stays', () => {
  withContext({ filters: false });
  const { container } = render(<StudioFluidBackground dark paused={false} />);
  expect(container.querySelector('canvas')?.dataset.blur).toBe('css');
  cleanup();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
  const failed = render(<StudioFluidBackground dark paused={false} />);
  expect(failed.container.querySelector('.home-wallpaper')).not.toBeNull();
  expect(frames).toHaveLength(0);
});
