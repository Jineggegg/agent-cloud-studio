import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
vi.mock('@/modules/studio/StudioWidgets', () => ({ StudioWidgets: () => null }));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));

import type { StudioHomeTile } from '@/shared/types';
import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';

const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const TILES: StudioHomeTile[] = [
  { id: 'deepseek', name: 'DeepSeek', tone: 'slate', glyph: 'sparkles' },
  { id: 'aj-exit', name: 'AJ 出口', tone: 'ink', glyph: 'globe' },
];
const ON = 'shortcuts://x-callback-url/run-shortcut?name=Studio%20AJ%20%E5%87%BA%E5%8F%A3%20%E5%BC%80';
const OFF = 'shortcuts://x-callback-url/run-shortcut?name=Studio%20AJ%20%E5%87%BA%E5%8F%A3%20%E5%85%B3';

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  toast.mockClear();
  assign = vi.fn();
  // Studio opened in Safari on its public address.
  visit('https://studio.ajarche.com/');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPAD);
});
afterEach(() => vi.unstubAllGlobals());

function visit(href: string) {
  const url = new URL(href);
  vi.stubGlobal('location', { ...window.location, href: url.href, hostname: url.hostname, origin: url.origin, assign });
}

// Installed on the home screen: iOS reports display-mode standalone.
function installAsWebApp() {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(display-mode: standalone)', media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) as unknown as MediaQueryList);
}

function renderHome() {
  const props = { tiles: TILES, loading: false, covered: false, snr: null, onOpen: vi.fn(), onOpenWidget: vi.fn(), onOpenSettings: vi.fn(), onCreate: vi.fn(), onRefresh: vi.fn(), onSignOut: vi.fn(), refreshing: false };
  render(<MemoryRouter><StudioHomeScreen {...props} /></MemoryRouter>);
  return props;
}

const tile = () => screen.getByRole('button', { name: /^AJ 出口/ });
const saved = () => JSON.parse(localStorage.getItem('studio-aj-exit-v1') ?? 'null');

test('the first tap explains the one-time setup; 已经建好 runs the 开 shortcut and returns to this page', () => {
  const props = renderHome();
  expect(tile().getAttribute('aria-label')).toBe('AJ 出口，未开启');
  fireEvent.click(tile());
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();

  const sheet = screen.getByRole('dialog', { name: 'AJ 出口' });
  const steps = within(sheet).getAllByRole('listitem').map(step => step.textContent);
  expect(steps[0]).toContain('安装 Tailscale');
  expect(steps[1]).toContain('Studio AJ 出口 开');
  expect(steps[1]).toMatch(/「连接 \/ Connect」.*「Use Exit Node」.*aryan-Lenovo-ideapad-330-15ICH/);
  expect(steps[2]).toContain('Studio AJ 出口 关');
  expect(steps[2]).toMatch(/「Stop Using Exit Node」.*「断开连接 \/ Disconnect」/);
  expect(within(sheet).getByText(/快捷指令不用添加到主屏幕/)).toBeTruthy();
  expect(within(sheet).getByText(/studio\.ajarche\.com/)).toBeTruthy();

  fireEvent.click(within(sheet).getByRole('button', { name: '已经建好，开启 AJ 出口' }));
  expect(assign).toHaveBeenCalledWith(`${ON}&x-success=${encodeURIComponent('https://studio.ajarche.com/')}`);
  expect(screen.queryByRole('dialog', { name: 'AJ 出口' })).toBeNull();
  expect(tile().getAttribute('aria-label')).toBe('AJ 出口，已开启');
  expect(tile().querySelector('.home-icon-wrap')?.getAttribute('data-on')).toBe('true');
  expect(saved()).toEqual({ ready: true, on: true });
  // The confirmation toast carries the way back to these settings.
  const [, options] = toast.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
  expect(options.action.label).toBe('设置');
});

test('once set up, a tap toggles: 关 runs the other shortcut, and the state is remembered on this device', () => {
  localStorage.setItem('studio-aj-exit-v1', JSON.stringify({ ready: true, on: true }));
  renderHome();
  expect(tile().getAttribute('aria-label')).toBe('AJ 出口，已开启');
  fireEvent.click(tile());
  expect(assign).toHaveBeenLastCalledWith(`${OFF}&x-success=${encodeURIComponent('https://studio.ajarche.com/')}`);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(tile().getAttribute('aria-label')).toBe('AJ 出口，未开启');
  expect(tile().querySelector('.home-icon-wrap')?.hasAttribute('data-on')).toBe(false);
  expect(saved()).toEqual({ ready: true, on: false });
  fireEvent.click(tile());
  expect(assign).toHaveBeenLastCalledWith(`${ON}&x-success=${encodeURIComponent('https://studio.ajarche.com/')}`);
});

test('from the installed home-screen app neither shortcut returns through x-success (it would open Safari)', () => {
  installAsWebApp();
  localStorage.setItem('studio-aj-exit-v1', JSON.stringify({ ready: true, on: false }));
  renderHome();
  fireEvent.click(tile());
  expect(assign).toHaveBeenLastCalledWith(ON);
  fireEvent.click(tile());
  expect(assign).toHaveBeenLastCalledWith(OFF);
});

test('on a tailnet address 关 does not return to the page, which cannot load once Tailscale is off', () => {
  visit('https://studio.tail1234.ts.net/');
  localStorage.setItem('studio-aj-exit-v1', JSON.stringify({ ready: true, on: false }));
  renderHome();
  fireEvent.click(tile());
  expect(assign).toHaveBeenLastCalledWith(`${ON}&x-success=${encodeURIComponent('https://studio.tail1234.ts.net/')}`);
  fireEvent.click(tile());
  expect(assign).toHaveBeenLastCalledWith(OFF);
});

test('in edit mode a tap opens the settings, which explain the label and can start the setup again', async () => {
  localStorage.setItem('studio-aj-exit-v1', JSON.stringify({ ready: true, on: true }));
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(tile());
  expect(assign).not.toHaveBeenCalled();
  const sheet = screen.getByRole('dialog', { name: 'AJ 出口' });
  expect(within(sheet).getByText('已开启')).toBeTruthy();
  expect(within(sheet).getByText(/Studio 只记得自己上一次请求的是开还是关/)).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('button', { name: '重新设置' }));
  expect(saved()).toEqual({ ready: false, on: false });
  expect(within(sheet).getByRole('button', { name: '已经建好，开启 AJ 出口' })).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('button', { name: '以后再说' }));
  // The sheet sinks away first (taking no taps), then goes.
  expect(sheet.closest('.studio-layer')?.classList.contains('closing')).toBe(true);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'AJ 出口' })).toBeNull());
  // Edit mode is still on: the sheet is not empty space.
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
  expect(tile().getAttribute('aria-label')).toBe('AJ 出口，未开启');
});

test('the toast after a toggle opens the settings', () => {
  localStorage.setItem('studio-aj-exit-v1', JSON.stringify({ ready: true, on: false }));
  renderHome();
  fireEvent.click(tile());
  const [, options] = toast.mock.calls[0] as [string, { action: { onClick: () => void } }];
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => options.action.onClick());
  expect(screen.getByRole('dialog', { name: 'AJ 出口' })).toBeTruthy();
});

test('without the Shortcuts app (not an iPad, iPhone or Mac) the tile only explains what it needs', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
  localStorage.setItem('studio-aj-exit-v1', JSON.stringify({ ready: true, on: false }));
  renderHome();
  fireEvent.click(tile());
  const sheet = screen.getByRole('dialog', { name: 'AJ 出口' });
  expect(within(sheet).getByRole('note').textContent).toMatch(/iPad 或 iPhone 上的「快捷指令」/);
  expect(within(sheet).queryByRole('button', { name: '已经建好，开启 AJ 出口' })).toBeNull();
  expect(assign).not.toHaveBeenCalled();
});

test('a damaged saved state falls back to not set up', () => {
  localStorage.setItem('studio-aj-exit-v1', '{oops');
  renderHome();
  expect(tile().getAttribute('aria-label')).toBe('AJ 出口，未开启');
  fireEvent.click(tile());
  expect(screen.getByRole('dialog', { name: 'AJ 出口' })).toBeTruthy();
});
