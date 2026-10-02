import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LaunchErrorBoundary, LaunchScreen, LaunchSplashRelease } from '@/shared/ui/LaunchScreen';

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
  document.querySelectorAll('link[data-acs-entry-style]').forEach(link => link.remove());
  document.documentElement.classList.remove('acs-app-entering');
});

test('in a hidden tab, which gets no animation frames, the splash leaves at once', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    const splash = mountSplash();
    render(<LaunchSplashRelease />);
    expect(splash.dataset.state).toBe('leaving');
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(document.getElementById('launch-splash')).toBeNull();
  } finally { visibility.mockRestore(); }
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

// The build loads the entry stylesheet as a preload that becomes a stylesheet on load (vite.config.js).
function mountPendingStylesheet() {
  const link = document.createElement('link');
  link.rel = 'preload';
  link.setAttribute('data-acs-entry-style', '');
  document.head.appendChild(link);
  let sheet: CSSStyleSheet | null = null;
  Object.defineProperty(link, 'sheet', { configurable: true, get: () => sheet });
  return {
    link,
    downloaded() { link.rel = 'stylesheet'; link.dispatchEvent(new Event('load')); },
    applied() { sheet = {} as CSSStyleSheet; link.dispatchEvent(new Event('load')); },
  };
}

test('the splash waits for the non-blocking stylesheet, so no screen is revealed unstyled', () => {
  const splash = mountSplash();
  const stylesheet = mountPendingStylesheet();
  render(<LaunchSplashRelease />);

  act(() => { vi.advanceTimersByTime(500); });
  expect(splash.dataset.state).toBeUndefined();

  // Downloaded but not yet applied: still waiting.
  act(() => { stylesheet.downloaded(); vi.advanceTimersByTime(100); });
  expect(splash.dataset.state).toBeUndefined();

  act(() => { stylesheet.applied(); });
  act(() => { vi.advanceTimersByTime(32); });
  expect(splash.dataset.state).toBe('leaving');
  stylesheet.link.remove();
});

test('a stylesheet applied without a second load event is still noticed', () => {
  const splash = mountSplash();
  const link = document.createElement('link');
  link.setAttribute('data-acs-entry-style', '');
  document.head.appendChild(link);
  let applied = false;
  Object.defineProperty(link, 'sheet', { configurable: true, get: () => (applied ? ({} as CSSStyleSheet) : null) });
  render(<LaunchSplashRelease />);

  applied = true;
  act(() => { vi.advanceTimersByTime(100 + 32); });
  expect(splash.dataset.state).toBe('leaving');
  link.remove();
});

function Thrower({ error }: { error: Error }): never {
  throw error;
}

test('a screen that throws replaces the app with an honest error screen and releases the splash', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const splash = mountSplash();
  // Even with the stylesheet still pending: the error screen is styled inline.
  const stylesheet = mountPendingStylesheet();
  render(<LaunchErrorBoundary homeHref="/"><Thrower error={new TypeError("Cannot read properties of undefined (reading 'find')")} /></LaunchErrorBoundary>);

  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('这不是网络问题');
  expect(alert.textContent).not.toContain('网络较慢');
  expect(screen.getByRole('link', { name: '返回主屏' }).getAttribute('href')).toBe('/');
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();

  act(() => { vi.advanceTimersByTime(32); });
  expect(splash.dataset.state).toBe('leaving');
  stylesheet.link.remove();
});

test('a chunk that cannot be downloaded is reported as a download failure', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<LaunchErrorBoundary homeHref="/ai/"><Thrower error={new TypeError('Failed to fetch dynamically imported module: /assets/index-abc.js')} /></LaunchErrorBoundary>);

  expect(screen.getByRole('alert').textContent).toContain('需要的文件没能下载');
  expect(screen.getByRole('link', { name: '返回主屏' }).getAttribute('href')).toBe('/ai/');
});
