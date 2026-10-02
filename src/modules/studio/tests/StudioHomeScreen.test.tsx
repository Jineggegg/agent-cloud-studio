import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { StudioHomeTile } from '@/shared/types';
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false, setThemeMode: vi.fn() }) }));
vi.mock('@/modules/studio/StudioWidgets', () => ({ StudioWidgets: () => null }));
vi.mock('@/modules/studio/StudioFluidBackground', () => ({ StudioFluidBackground: () => null }));

import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

const TILES: StudioHomeTile[] = [
  { id: 'project:snr', name: 'SNR 3.0', tone: 'sage', glyph: 'activity', status: '在线' },
  { id: 'project:prof', name: '超级教授', tone: 'clay', glyph: 'graduation' },
  { id: 'deepseek', name: 'DeepSeek', tone: 'slate', glyph: 'sparkles' },
  { id: 'workspace', name: '开发工具', tone: 'graphite', glyph: 'terminal', href: '/workspace' },
];

function renderHome(overrides: Partial<Parameters<typeof StudioHomeScreen>[0]> = {}) {
  const props = { tiles: TILES, loading: false, covered: false, snr: null, onOpen: vi.fn(), onCreate: vi.fn(), onRefresh: vi.fn(), onSignOut: vi.fn(), refreshing: false, ...overrides };
  render(<MemoryRouter><StudioHomeScreen {...props} /></MemoryRouter>);
  return props;
}

test('each project is a large tile that opens its own app; the IDE tile is a route link; + creates a project', () => {
  const props = renderHome();
  const apps = screen.getByRole('navigation', { name: '应用' });
  fireEvent.click(within(apps).getByRole('button', { name: 'SNR 3.0，在线' }));
  expect(props.onOpen).toHaveBeenCalledWith(TILES[0], expect.anything());
  expect(within(apps).getByRole('link', { name: '开发工具' }).getAttribute('href')).toBe('/workspace');
  fireEvent.click(within(apps).getByRole('button', { name: '新建项目' }));
  expect(props.onCreate).toHaveBeenCalledTimes(1);
});

test('labels and hidden tiles are customised in edit mode and remembered on this device', () => {
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('switch', { name: '显示名称' }));
  fireEvent.click(screen.getByRole('button', { name: '从主屏幕隐藏 DeepSeek' }));
  expect(screen.queryByRole('button', { name: 'DeepSeek' })).toBeNull();
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}')).toEqual({ hidden: ['deepseek'], labels: false, large: false });

  fireEvent.click(screen.getByRole('button', { name: '资源库' }));
  const library = screen.getByRole('dialog', { name: 'App 资源库' });
  expect(within(library).queryByText(/Outlook|未接入|规划中/)).toBeNull(); // Outlook mail is built; nothing is planned.
  fireEvent.click(within(library).getByRole('button', { name: '添加到主屏幕' }));
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy();
});

test('a long press enters edit mode without also opening the app', () => {
  vi.useFakeTimers();
  const props = renderHome();
  const tile = screen.getByRole('button', { name: 'SNR 3.0，在线' });
  fireEvent.pointerDown(tile, { button: 0 });
  act(() => { vi.advanceTimersByTime(600); });
  fireEvent.pointerUp(tile);
  fireEvent.click(tile);
  expect(props.onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});

test('a damaged saved layout falls back to the default home screen', () => {
  localStorage.setItem('studio-home-layout-v1', '{not json');
  renderHome();
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy();
});
