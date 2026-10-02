import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { StudioHomeScreen } from '@/modules/studio/StudioHomeScreen';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderHome(onOpen = vi.fn()) {
  render(<MemoryRouter><StudioHomeScreen onOpen={onOpen} onRefresh={vi.fn()} onSignOut={vi.fn()} refreshing={false} statusLine={{ snr: '在线' }} /></MemoryRouter>);
  return onOpen;
}

test('each product is a large tile that opens its own app, and the IDE tile is a route link', () => {
  const onOpen = renderHome();
  const apps = screen.getByRole('navigation', { name: '应用' });
  fireEvent.click(within(apps).getByRole('button', { name: 'SNR 3.0，在线' }));
  expect(onOpen).toHaveBeenCalledWith('snr', expect.anything());
  fireEvent.click(within(apps).getByRole('button', { name: '超级教授' }));
  expect(onOpen).toHaveBeenLastCalledWith('professor', expect.anything());
  expect(within(apps).getByRole('link', { name: '开发工具' }).getAttribute('href')).toBe('/workspace');
});

test('labels and hidden tiles are customised in edit mode and remembered on this device', () => {
  renderHome();
  fireEvent.click(screen.getByRole('button', { name: '编辑主屏幕' }));
  fireEvent.click(screen.getByRole('switch', { name: '显示名称' }));
  fireEvent.click(screen.getByRole('button', { name: '从主屏幕隐藏 DeepSeek' }));
  expect(screen.queryByRole('button', { name: 'DeepSeek' })).toBeNull();
  expect(JSON.parse(localStorage.getItem('studio-home-layout-v1') ?? '{}')).toEqual({ hidden: ['deepseek'], labels: false, large: false });

  fireEvent.click(screen.getByRole('button', { name: '添加应用' }));
  const library = screen.getByRole('dialog', { name: 'App 资源库' });
  expect(within(library).getByText('股票看板')).toBeTruthy();
  expect(within(library).getAllByText('未接入').length).toBe(2);
  fireEvent.click(within(library).getByRole('button', { name: '添加到主屏幕' }));
  expect(screen.getByRole('button', { name: 'DeepSeek' })).toBeTruthy();
});

test('a long press enters edit mode without also opening the app', () => {
  vi.useFakeTimers();
  const onOpen = renderHome();
  const tile = screen.getByRole('button', { name: 'SNR 3.0，在线' });
  fireEvent.pointerDown(tile, { button: 0 });
  act(() => { vi.advanceTimersByTime(600); });
  fireEvent.pointerUp(tile);
  fireEvent.click(tile);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
});

test('a damaged saved layout falls back to the default home screen', () => {
  localStorage.setItem('studio-home-layout-v1', '{not json');
  renderHome();
  expect(screen.getAllByRole('button').some(button => button.getAttribute('aria-label') === 'DeepSeek')).toBe(true);
});
