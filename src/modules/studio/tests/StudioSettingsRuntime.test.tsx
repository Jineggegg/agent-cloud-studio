import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';
import type { StudioBuildInfo, StudioRuntimeInfo } from '@/shared/types';

const mocks = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { studio: { runtime: mocks.runtime } } };
});

const { StudioSettingsRuntime } = await import('@/modules/studio/StudioSettingsRuntime');
const BUILD: StudioBuildInfo = { schemaVersion: 1, version: '1.2.3', commit: 'a'.repeat(40), builtAt: '2026-10-02T12:00:00.000Z', dirty: false };

function runtimeInfo(): StudioRuntimeInfo {
  return {
    checkedAt: '2026-10-02T13:00:00.000Z',
    frontend: { state: 'recorded', build: BUILD, reason: null },
    backend: { state: 'recorded', build: BUILD, reason: null },
    checkout: { state: 'available', commit: 'b'.repeat(40), branch: 'feature/local', dirty: true, reason: null },
    github: { state: 'available', repository: 'owner/studio', defaultBranch: 'main', commit: 'c'.repeat(40), checkedAt: '2026-10-02T13:00:00.000Z', reason: null },
    host: { hostname: 'studio-host', platform: 'linux', bootedAt: '2026-10-01T12:00:00.000Z', processStartedAt: '2026-10-02T11:00:00.000Z', uptimeSeconds: 7200 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__STUDIO_BUILD_INFO__', BUILD);
  mocks.runtime.mockImplementation(async () => Response.json(runtimeInfo()));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('distinguishes browser, disk, running backend, checkout, GitHub and host without declaring latest', async () => {
  render(<StudioSettingsRuntime />);
  await screen.findByText('运行主机');
  for (const label of ['这个浏览器', '已部署前端', '正在运行的后台', '当前代码目录', 'GitHub 最新提交']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getAllByText('v1.2.3 · aaaaaaaa')).toHaveLength(3);
  expect(screen.getByText('feature/local · bbbbbbbb')).toBeTruthy();
  expect(screen.getByText('main · cccccccc')).toBeTruthy();
  expect(screen.getByText(/有未提交改动 · 源码状态不代表运行版本/)).toBeTruthy();
  expect(screen.getByText('studio-host · linux')).toBeTruthy();
  expect(screen.queryByText('已是最新版本')).toBeNull();
  expect(screen.getByRole('link', { name: '查看连接方式' }).getAttribute('href')).toBe('#studio-network-heading');
  expect(screen.getByRole('link', { name: '查看远程主机' }).getAttribute('href')).toBe('#studio-remote-heading');
});

test('different browser build offers reload and frontend/backend mismatch stays neutral', async () => {
  const info = runtimeInfo();
  info.frontend.build = { ...BUILD, commit: 'd'.repeat(40) };
  mocks.runtime.mockResolvedValue(Response.json(info));
  render(<StudioSettingsRuntime />);
  expect(await screen.findByRole('button', { name: '重新载入页面' })).toBeTruthy();
  expect(screen.getByText('前端与后台来自不同提交，请核对部署版本。')).toBeTruthy();
  expect(screen.queryByText(/后台需要.*重启/)).toBeNull();
});

test('unknown builds and unavailable GitHub remain explicit and do not produce reload advice', async () => {
  vi.stubGlobal('__STUDIO_BUILD_INFO__', undefined);
  const info = runtimeInfo();
  info.frontend = { state: 'unknown', build: null, reason: '前端构建信息未记录' };
  info.backend = { state: 'unknown', build: null, reason: '后台构建信息未记录' };
  info.github = { state: 'unavailable', repository: 'owner/studio', defaultBranch: null, commit: null, checkedAt: info.checkedAt, reason: 'GitHub 暂时限流，请稍后刷新' };
  mocks.runtime.mockResolvedValue(Response.json(info));
  render(<StudioSettingsRuntime />);
  await screen.findByText('后台构建信息未记录');
  expect(screen.getAllByText('未记录')).toHaveLength(3);
  expect(screen.getByText(/GitHub 暂时限流/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重新载入页面' })).toBeNull();
});

test('malformed or older endpoint responses produce an actionable error and refresh recovers', async () => {
  mocks.runtime.mockResolvedValueOnce(Response.json({ outdated: true }));
  render(<StudioSettingsRuntime />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('请检查连接后重试'));
  const refresh = screen.getByRole('button', { name: '刷新状态' });
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(refresh);
  await screen.findByText('运行主机');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(mocks.runtime).toHaveBeenCalledTimes(2);
});

test('a failed refresh preserves the last successful snapshot and identifies it as stale', async () => {
  render(<StudioSettingsRuntime />);
  await screen.findByText('运行主机');
  mocks.runtime.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('保留上次成功读取'));
  expect(screen.getByText('studio-host · linux')).toBeTruthy();
});

test('expired login tells the user how to recover', async () => {
  mocks.runtime.mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }));
  render(<StudioSettingsRuntime />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '登录已失效，请重新登录后再试。');
});

test('a hanging request times out and unlocks refresh', async () => {
  vi.useFakeTimers();
  mocks.runtime.mockImplementationOnce((signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  render(<StudioSettingsRuntime />);
  expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });
  expect(screen.getByRole('alert')).toBeTruthy();
  expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(false);
});

test('checks only on open or explicit refresh and aborts when the section closes', async () => {
  const view = render(<StudioSettingsRuntime />);
  await screen.findByText('运行主机');
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新状态' }) as HTMLButtonElement).disabled).toBe(false));
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(mocks.runtime).toHaveBeenCalledTimes(1);
  const signal = mocks.runtime.mock.calls[0][0] as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
