import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { LaunchErrorBoundary, LaunchScreen, LaunchSplashRelease } from '@/shared/ui/LaunchScreen';

// index.html sits at the repository root, outside the @/ source root, so it is read from disk rather than
// imported. The frontend program has no Node types, so fs is loaded through a specifier TypeScript does not
// resolve, as in serviceWorker.test.ts.
let indexHtml = '';
beforeAll(async () => {
  const fsModule = 'node:fs';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: 'utf8') => string };
  const testsDir = decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')).replace(/\/[^/]*$/, '');
  indexHtml = readFileSync(`${testsDir}/../../../index.html`, 'utf8');
});

// The splash exactly as index.html ships it: backdrop, star and hint.
function mountSplash() {
  const source = new DOMParser().parseFromString(indexHtml, 'text/html').getElementById('launch-splash');
  if (!source) throw new Error('index.html has no #launch-splash');
  const splash = document.importNode(source, true) as HTMLElement;
  document.body.appendChild(splash);
  return splash;
}
const starOf = (splash: HTMLElement) => splash.querySelector('svg.acs-star') as SVGSVGElement;

beforeEach(() => {
  vi.useFakeTimers();
  // Frames run on the fake clock so the test can step through the two-frame handshake and the zoom.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(performance.now()), 16));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(handle => window.clearTimeout(handle));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.getElementById('launch-splash')?.remove();
  document.querySelectorAll('link[data-acs-entry-style]').forEach(link => link.remove());
  document.documentElement.classList.remove('acs-app-entering');
});

test('the splash in index.html draws the star and its halo, turning once the draw-in is over', () => {
  const splash = mountSplash();
  const star = starOf(splash);
  expect(splash.querySelector('.acs-launch-backdrop')).toBeTruthy();
  expect(star.classList.contains('is-turning')).toBe(true);
  expect(star.getAttribute('style')).toContain('--star-turn-delay: var(--star-draw)');
  expect(star.querySelectorAll('.acs-star-halo path')).toHaveLength(2);
  expect(star.querySelectorAll('.acs-star-spark path')).toHaveLength(1);
  expect(Array.from(star.querySelectorAll('path')).every(path => path.getAttribute('pathLength') === '1')).toBe(true);
});

test('in a hidden tab, which gets no animation frames, the splash leaves at once', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    const splash = mountSplash();
    render(<LaunchSplashRelease />);
    expect(splash.dataset.state).toBe('leaving');
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(document.getElementById('launch-splash')).toBeNull();
  } finally { visibility.mockRestore(); }
});

test('once the new screen has had a frame to paint, the star opens into a window onto it, then the splash is removed', () => {
  const splash = mountSplash();
  render(<LaunchSplashRelease />);
  expect(splash.dataset.state).toBeUndefined();

  act(() => { vi.advanceTimersByTime(16); });
  expect(splash.dataset.state).toBeUndefined();

  act(() => { vi.advanceTimersByTime(16); });
  expect(splash.dataset.state).toBe('leaving');
  expect(splash.getAttribute('aria-hidden')).toBe('true');
  expect(splash.dataset.phase).toBe('zoom');
  const star = starOf(splash);
  expect(star.classList.contains('is-turning')).toBe(false);
  expect(star.classList.contains('is-zooming')).toBe(true);
  expect(document.documentElement.classList.contains('acs-app-entering')).toBe(true);

  act(() => { vi.advanceTimersByTime(900); });
  expect(document.getElementById('launch-splash')).toBe(splash);
  act(() => { vi.advanceTimersByTime(400); });
  expect(document.getElementById('launch-splash')).toBeNull();
  // The settle animation class must not linger: a transformed #root would re-anchor fixed sheets.
  expect(document.documentElement.classList.contains('acs-app-entering')).toBe(false);
});

test('a visible page starved of animation frames still loses the splash after a short wait, without a zoom', () => {
  vi.mocked(window.requestAnimationFrame).mockImplementation(() => 0);
  const splash = mountSplash();
  render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(399); });
  expect(splash.dataset.state).toBeUndefined();
  act(() => { vi.advanceTimersByTime(1); });
  expect(splash.dataset.state).toBe('leaving');
  expect(document.getElementById('launch-splash')).toBeNull();
  expect(document.documentElement.classList.contains('acs-app-entering')).toBe(false);
});

test('under reduced motion the splash simply fades', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
  const splash = mountSplash();
  render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(32); });
  expect(splash.dataset.state).toBe('leaving');
  expect(splash.dataset.phase).toBe('fade');
  expect(document.documentElement.classList.contains('acs-app-entering')).toBe(false);
  act(() => { vi.advanceTimersByTime(260); });
  expect(document.getElementById('launch-splash')).toBeNull();
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

// index.html stamps the splash with the moment it first showed, so a fast start lets the star finish drawing in.
function stampShown(splash: HTMLElement, agoMs = 0) {
  splash.setAttribute('data-shown-at', String(performance.now() - agoMs));
}

test('on a fast start the splash stays until the star has drawn in, then leaves after the usual two frames', () => {
  const splash = mountSplash();
  stampShown(splash);
  render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(splash.dataset.state).toBeUndefined();
  expect(window.requestAnimationFrame).not.toHaveBeenCalled();

  act(() => { vi.advanceTimersByTime(100 + 32); });
  expect(splash.dataset.state).toBe('leaving');
  expect(splash.dataset.phase).toBe('zoom');
  act(() => { vi.advanceTimersByTime(1300); });
  expect(document.getElementById('launch-splash')).toBeNull();
});

test('the draw-in never holds the splash longer than its own length, whatever the stamp says', () => {
  const splash = mountSplash();
  splash.setAttribute('data-shown-at', String(performance.now() + 60_000));
  render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(1100 + 32); });
  expect(splash.dataset.state).toBe('leaving');
});

test('a start slower than the draw-in is not held back by it', () => {
  const splash = mountSplash();
  stampShown(splash, 5_000);
  render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(32); });
  expect(splash.dataset.state).toBe('leaving');
});

test('a star caught mid-turn comes to rest upright before the window opens', () => {
  const splash = mountSplash();
  // Drawn in and 300 ms into a 900 ms quarter turn.
  stampShown(splash, 1100 + 300);
  render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(32); });
  expect(splash.dataset.state).toBe('leaving');
  expect(splash.dataset.phase).toBeUndefined();
  act(() => { vi.advanceTimersByTime(540); });
  expect(splash.dataset.phase).toBeUndefined();
  act(() => { vi.advanceTimersByTime(70); });
  expect(splash.dataset.phase).toBe('zoom');
  // The halo stays at the angle it had turned to (backwards), rather than snapping back to where it started.
  expect(starOf(splash).querySelector<SVGGElement>('.acs-star-halo')?.style.transform).toMatch(/^rotate\(-[1-9]\d*\.\d+deg\)$/);
});

test('in a hidden tab the draw-in is skipped and the splash leaves at once', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    const splash = mountSplash();
    stampShown(splash);
    render(<LaunchSplashRelease />);
    expect(splash.dataset.state).toBe('leaving');
  } finally { visibility.mockRestore(); }
});

test('the draw-in wait still falls back to leaving without animation frames', () => {
  vi.mocked(window.requestAnimationFrame).mockImplementation(() => 0);
  const splash = mountSplash();
  stampShown(splash);
  render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(1100 + 399); });
  expect(splash.dataset.state).toBeUndefined();
  act(() => { vi.advanceTimersByTime(1); });
  expect(splash.dataset.state).toBe('leaving');
  expect(document.getElementById('launch-splash')).toBeNull();
});

test('a screen that unmounts during the draw-in does not release the splash', () => {
  const splash = mountSplash();
  stampShown(splash);
  const { unmount } = render(<LaunchSplashRelease />);
  act(() => { vi.advanceTimersByTime(300); });
  unmount();
  act(() => { vi.advanceTimersByTime(2000); });
  expect(splash.dataset.state).toBeUndefined();
});

test('the in-app launch screen announces what is loading and draws the same turning star as the splash', () => {
  const { container } = render(<LaunchScreen label="正在打开开发工具" />);
  expect(screen.getByRole('status', { name: '正在打开开发工具' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
  const star = container.querySelector('svg.acs-star.acs-launch-star');
  expect(star?.classList.contains('is-turning')).toBe(true);
  expect(star?.getAttribute('aria-hidden')).toBe('true');
  expect(star?.querySelectorAll('path')).toHaveLength(3);
  // It starts turning once drawn in, like the splash.
  expect((star as SVGSVGElement).style.getPropertyValue('--star-turn-delay')).toBe('1100ms');
  // Each star has a gradient of its own, so two on a page never share an id.
  const gradient = star?.querySelector('linearGradient')?.id;
  expect(gradient).toMatch(/^acs-star-[\w-]+$/);
  expect(star?.querySelector('.acs-star-spark path')?.getAttribute('stroke')).toBe(`url(#${gradient})`);
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
