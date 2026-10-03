import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { StudioAppLaunch, appLaunchOrigin } from '@/modules/studio/StudioAppLaunch';
import type { StudioLaunchOrigin } from '@/modules/studio/StudioAppLaunch';

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height }) as DOMRect;
const ORIGIN: StudioLaunchOrigin = { x: 146, y: 246, size: 106, glyph: null };

beforeEach(() => {
  vi.useFakeTimers();
  // Animation frames on the fake clock, each stamped 16 ms after the last.
  let clock = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(clock += 16), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(handle => window.clearTimeout(handle));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// StudioPage's arrangement: the app panel, and the launch above it revealing it.
function Launching({ loading, onOpened }: { loading: boolean; onOpened: () => void }) {
  const app = useRef<HTMLDivElement>(null);
  return <>
    <div ref={app} data-testid="app"><main>应用</main></div>
    <StudioAppLaunch origin={ORIGIN} name="记忆" loading={loading} app={app} onOpened={onOpened} />
  </>;
}

const star = () => document.querySelector('.studio-app-launch svg.acs-star') as SVGSVGElement;

test('the star launches from the centre of what was tapped, a little larger than an icon, within bounds', () => {
  expect(appLaunchOrigin(box(100, 200, 92, 92))).toMatchObject({ x: 146, y: 246, size: 92 * 1.15 });
  // The settings gear is small, a widget card large.
  expect(appLaunchOrigin(box(0, 0, 32, 32)).size).toBe(48);
  expect(appLaunchOrigin(box(0, 0, 400, 180)).size).toBe(120);
});

test('the star draws over the icon, turns while the app loads, then opens the window onto it and reports it open', () => {
  const onOpened = vi.fn();
  const view = render(<Launching loading onOpened={onOpened} />);
  const status = screen.getByRole('status', { name: '正在打开 记忆' });
  expect(status.getAttribute('aria-busy')).toBe('true');
  // Drawn over the icon, at the icon's size.
  expect(star().style.left).toBe(`${146 - 53}px`);
  expect(star().style.width).toBe('106px');
  expect(star().classList.contains('is-turning')).toBe(false);

  act(() => { vi.advanceTimersByTime(650); });
  expect(star().classList.contains('is-turning')).toBe(true);
  act(() => { vi.advanceTimersByTime(3000); });
  expect(star().classList.contains('is-turning')).toBe(true);
  expect(onOpened).not.toHaveBeenCalled();

  // Loaded: the star finishes its quarter turn (under 900 ms), then the window opens.
  view.rerender(<Launching loading={false} onOpened={onOpened} />);
  act(() => { vi.advanceTimersByTime(900); });
  expect(star().classList.contains('is-turning')).toBe(false);
  expect(star().classList.contains('is-zooming')).toBe(true);
  expect(screen.getByRole('status', { name: '正在打开 记忆' }).getAttribute('aria-busy')).toBe('false');
  // The outline rides the growing window: larger than drawn.
  act(() => { vi.advanceTimersByTime(500); });
  expect(parseFloat(star().style.width)).toBeGreaterThan(106);

  act(() => { vi.advanceTimersByTime(800); });
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('app').style.clipPath).toBe('');
});

test('an app that is already loaded skips the turn: drawn in, then straight into the window', () => {
  const onOpened = vi.fn();
  render(<Launching loading={false} onOpened={onOpened} />);
  act(() => { vi.advanceTimersByTime(649); });
  expect(star().classList.contains('is-zooming')).toBe(false);
  act(() => { vi.advanceTimersByTime(1); });
  expect(star().classList.contains('is-turning')).toBe(false);
  expect(star().classList.contains('is-zooming')).toBe(true);
  act(() => { vi.advanceTimersByTime(1300); });
  expect(onOpened).toHaveBeenCalledTimes(1);
});

test('a launch that is cut short (the app closed or navigated away) leaves the app unclipped and reports nothing', () => {
  const onOpened = vi.fn();
  const view = render(<Launching loading onOpened={onOpened} />);
  act(() => { vi.advanceTimersByTime(1000); });
  const app = screen.getByTestId('app');
  view.rerender(<div ref={() => {}} />);
  act(() => { vi.advanceTimersByTime(5000); });
  expect(app.style.clipPath).toBe('');
  expect(onOpened).not.toHaveBeenCalled();
});
