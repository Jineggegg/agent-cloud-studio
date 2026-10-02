import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LaunchScreen, LaunchSplashRelease } from '@/shared/ui/LaunchScreen';

function mountSplash() {
  const splash = document.createElement('div');
  splash.id = 'launch-splash';
  document.body.appendChild(splash);
  return splash;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Frames run on the fake clock so the test can step through the two-frame handshake.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(handle => window.clearTimeout(handle));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.getElementById('launch-splash')?.remove();
  document.documentElement.classList.remove('acs-app-entering');
});

test('the splash starts leaving only after the new screen has had a frame to paint, then is removed', () => {
  const splash = mountSplash();
  render(<LaunchSplashRelease />);
  expect(splash.dataset.state).toBeUndefined();

  act(() => { vi.advanceTimersByTime(16); });
  expect(splash.dataset.state).toBeUndefined();

  act(() => { vi.advanceTimersByTime(16); });
  expect(splash.dataset.state).toBe('leaving');
  expect(splash.getAttribute('aria-hidden')).toBe('true');
  expect(document.documentElement.classList.contains('acs-app-entering')).toBe(true);

  act(() => { vi.advanceTimersByTime(600); });
  expect(document.getElementById('launch-splash')).toBeNull();
  // The settle animation class must not linger: a transformed #root would re-anchor fixed sheets.
  expect(document.documentElement.classList.contains('acs-app-entering')).toBe(false);
});

test('a screen that unmounts before painting does not release the splash', () => {
  const splash = mountSplash();
  const { unmount } = render(<LaunchSplashRelease />);
  unmount();
  act(() => { vi.advanceTimersByTime(1000); });
  expect(splash.dataset.state).toBeUndefined();
  expect(document.getElementById('launch-splash')).toBe(splash);
});

test('releasing twice, or with no splash in the page, is harmless', () => {
  render(<><LaunchSplashRelease /><LaunchSplashRelease /></>);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(document.documentElement.classList.contains('acs-app-entering')).toBe(false);
});

test('the in-app launch screen announces what is loading', () => {
  render(<LaunchScreen label="正在打开开发工具" />);
  expect(screen.getByRole('status', { name: '正在打开开发工具' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
});
