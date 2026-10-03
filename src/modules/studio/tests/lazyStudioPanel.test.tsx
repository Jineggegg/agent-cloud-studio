import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { lazyStudioPanel } from '@/modules/studio/lazyStudioPanel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.getElementById('launch-splash')?.remove();
});

function Greeting({ name }: { name: string }) {
  return <p>你好，{name}</p>;
}

test('a cold sub-app shows its skeleton, then renders with the props it was given', async () => {
  let finish: (component: typeof Greeting) => void = () => {};
  const load = vi.fn(() => new Promise<typeof Greeting>(resolve => { finish = resolve; }));
  const Panel = lazyStudioPanel(load, 'dashboard');

  render(<Panel name="AJ" />);
  expect(screen.getByRole('status', { name: '正在加载' })).toBeTruthy();
  finish(Greeting);
  expect(await screen.findByText('你好，AJ')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
});

test('a warm sub-app renders on its first frame without a skeleton and without loading again', async () => {
  const load = vi.fn(() => Promise.resolve(Greeting));
  const Panel = lazyStudioPanel(load, 'list');
  const first = render(<Panel name="一" />);
  expect(await screen.findByText('你好，一')).toBeTruthy();
  first.unmount();

  render(<Panel name="二" />);
  expect(screen.getByText('你好，二')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
});

test('the chat placeholder sketches the conversation layout', () => {
  const Panel = lazyStudioPanel(() => new Promise<typeof Greeting>(() => {}), 'chat');
  render(<Panel name="DeepSeek" />);
  expect(screen.getByRole('status', { name: '正在打开对话' })).toBeTruthy();
});

test('a chunk that fails to load leaves a recoverable message instead of blanking the Studio', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const Panel = lazyStudioPanel(() => Promise.reject<typeof Greeting>(new TypeError('Failed to fetch dynamically imported module')), 'list');
  render(<Panel name="AJ" />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
});

const chunkFailure = () => new TypeError('Failed to fetch dynamically imported module: /assets/StudioProjectMail-abc.js');

test('after a failed download, 重试 fetches the chunk again in place, without reloading the Studio', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi.fn<() => Promise<typeof Greeting>>().mockRejectedValueOnce(chunkFailure()).mockResolvedValue(Greeting);
  const Panel = lazyStudioPanel(load, 'list');
  render(<Panel name="AJ" />);
  await screen.findByRole('alert');

  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('你好，AJ')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

test('reopening an app whose chunk failed earlier loads it again instead of repeating the old error', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi.fn<() => Promise<typeof Greeting>>().mockRejectedValueOnce(chunkFailure()).mockResolvedValue(Greeting);
  const Panel = lazyStudioPanel(load, 'list');
  const first = render(<Panel name="一" />);
  await screen.findByRole('alert');
  first.unmount();

  render(<Panel name="二" />);
  expect(await screen.findByText('你好，二')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

test('the idle warm-up starts once the splash is gone, without waiting for the window load event', async () => {
  // A blocked Google Fonts stylesheet can hold back window load for tens of seconds.
  vi.useFakeTimers();
  vi.stubEnv('MODE', 'production');
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const splash = document.createElement('div');
  splash.id = 'launch-splash';
  document.body.appendChild(splash);
  // A fresh copy of the module, so registering its first panel schedules the warm-up under these conditions.
  vi.resetModules();
  const { lazyStudioPanel: lazyStudioPanelWithWarmup } = await import('@/modules/studio/lazyStudioPanel');
  const load = vi.fn(() => Promise.resolve(Greeting));
  lazyStudioPanelWithWarmup(load, 'list');

  await vi.advanceTimersByTimeAsync(5000);
  expect(load).not.toHaveBeenCalled();

  splash.remove();
  await vi.advanceTimersByTimeAsync(1200);
  expect(load).toHaveBeenCalledTimes(1);
});
