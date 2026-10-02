import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// App wiring after the first-screen split: the Studio home must render without the workbench (or the hidden
// legacy IDE), which load with their providers only for their own routes, and every route releases the splash.
const loaded = vi.hoisted(() => ({ workspace: vi.fn(), workbench: vi.fn() }));
// Lets a test make the Studio home throw while rendering, the way a malformed API answer once did.
const studio = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('@/modules/auth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/modules/studio', () => ({
  StudioPage: () => {
    if (studio.failure) throw studio.failure;
    return <main>Studio home</main>;
  },
}));
vi.mock('@/modules/project-workspace', () => {
  loaded.workspace();
  return { ProjectWorkspaceRoute: () => <main>IDE</main> };
});
vi.mock('@/modules/workbench', () => {
  loaded.workbench();
  return { WorkbenchRoute: ({ legacy }: { legacy?: string }) => <main>{legacy ? `Workbench redirect: ${legacy}` : 'Workbench'}</main> };
});

const { default: App } = await import('@/App');

beforeEach(() => {
  loaded.workspace.mockClear();
  loaded.workbench.mockClear();
  studio.failure = null;
  const splash = document.createElement('div');
  splash.id = 'launch-splash';
  document.body.appendChild(splash);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(performance.now()), 0));
});

afterEach(() => {
  cleanup();
  document.getElementById('launch-splash')?.remove();
  document.documentElement.classList.remove('acs-app-entering');
  window.history.pushState({}, '', '/');
});

test('the Studio home renders without loading the workbench or the IDE and then releases the launch splash', async () => {
  window.history.pushState({}, '', '/');
  render(<App />);
  expect(screen.getByText('Studio home')).toBeTruthy();
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
  expect(document.getElementById('launch-splash')?.dataset.state).toBe('leaving');
  expect(loaded.workspace).not.toHaveBeenCalled();
  expect(loaded.workbench).not.toHaveBeenCalled();
});

for (const path of ['/work', '/work/p1', '/work/p1/s/session-1', '/work/p1/d/conversation-1']) {
  test(`${path} lazy-loads the workbench (not the IDE) and keeps the splash until it renders`, async () => {
    window.history.pushState({}, '', path);
    render(<App />);
    expect(document.getElementById('launch-splash')?.dataset.state).toBeUndefined();
    expect(await screen.findByText('Workbench')).toBeTruthy();
    expect(loaded.workspace).not.toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
    expect(document.getElementById('launch-splash')?.dataset.state).toBe('leaving');
  });
}

test('the inherited IDE addresses go through the workbench redirects', async () => {
  window.history.pushState({}, '', '/workspace?projectId=p1&provider=codex');
  const first = render(<App />);
  expect(await screen.findByText('Workbench redirect: workspace')).toBeTruthy();
  first.unmount();
  window.history.pushState({}, '', '/session/session-1');
  render(<App />);
  expect(await screen.findByText('Workbench redirect: session')).toBeTruthy();
  expect(loaded.workspace).not.toHaveBeenCalled();
});

test('the hidden legacy route lazy-loads the inherited IDE and keeps the splash until it renders', async () => {
  window.history.pushState({}, '', '/legacy/workspace');
  render(<App />);
  expect(document.getElementById('launch-splash')?.dataset.state).toBeUndefined();
  expect(await screen.findByText('IDE')).toBeTruthy();
  expect(loaded.workspace).toHaveBeenCalledTimes(1);
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
  expect(document.getElementById('launch-splash')?.dataset.state).toBe('leaving');
});

test('an unknown path lands on the Studio home instead of leaving the splash up over nothing', async () => {
  window.history.pushState({}, '', '/settings');
  render(<App />);
  expect(await screen.findByText('Studio home')).toBeTruthy();
  expect(window.location.pathname).toBe('/');
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
  expect(document.getElementById('launch-splash')?.dataset.state).toBe('leaving');
});

test('a screen that throws shows the error screen and releases the splash', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  studio.failure = new TypeError("Cannot read properties of undefined (reading 'find')");
  window.history.pushState({}, '', '/');
  render(<App />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).not.toContain('网络较慢');
  expect(screen.getByRole('link', { name: '返回主屏' }).getAttribute('href')).toBe('/');
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
  expect(document.getElementById('launch-splash')?.dataset.state).toBe('leaving');
});
