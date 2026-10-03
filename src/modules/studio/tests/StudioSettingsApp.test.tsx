import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { username: 'andrew' } }) }));
const theme = vi.hoisted(() => ({ setThemeMode: vi.fn() }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ themeMode: 'dark', isDarkMode: true, setThemeMode: theme.setThemeMode }) }));
vi.mock('@/shared/api', () => ({ api: { user: { savePreferences: vi.fn(async () => Response.json({})) }, studio: {} } }));
// The pages themselves have their own tests; here they only say which one is shown.
vi.mock('@/modules/studio/StudioSettingsModels', () => ({ StudioSettingsModels: ({ view, onOpenCatalog }: { view?: string; onOpenCatalog?: () => void }) =>
  <div>models:{view ?? 'defaults'}{onOpenCatalog && <button type="button" onClick={onOpenCatalog}>open catalog</button>}</div> }));
vi.stubGlobal('__STUDIO_BUILD_INFO__', { schemaVersion: 1, version: '1.37.3', commit: null, builtAt: '2026-10-03T12:00:00Z', dirty: false });
vi.mock('@/modules/studio/StudioSettingsAbout', () => ({ StudioSettingsAbout: ({ onOpenRuntime }: { onOpenRuntime: () => void }) =>
  <button type="button" onClick={onOpenRuntime}>open runtime</button> }));
vi.mock('@/modules/studio/StudioSettingsRuntime', () => ({ StudioSettingsRuntime: () => <div>runtime page</div> }));
vi.mock('@/modules/studio/StudioSettingsTrading', () => ({ StudioSettingsTrading: () => <div>trading page</div> }));

import { StudioConnections } from '@/modules/studio/StudioConnections';
import { readSettingsPage } from '@/modules/studio/settingsPages';
import type { SettingsPageId } from '@/modules/studio/settingsPages';
import { getHomeLayout } from '@/modules/studio/utils/homeLayout';

beforeEach(() => { localStorage.clear(); theme.setThemeMode.mockClear(); });
afterEach(cleanup);

function renderSettings(page: SettingsPageId | null, split: boolean) {
  const onNavigate = vi.fn();
  render(<MemoryRouter><StudioConnections status={{ deepseek: { configured: true, source: 'vault', models: [], baseUrl: '' }, agentWorkbenchUrl: null, snrRemoteUrl: null }}
    onChange={vi.fn(async () => {})} page={page} split={split} onNavigate={onNavigate} onScroll={vi.fn()} onSignOut={vi.fn()} /></MemoryRouter>);
  return onNavigate;
}

test('the URL picks the page; the Trading 212 app\'s safety link still lands on Trading 212', () => {
  expect(readSettingsPage('about', '')).toBe('about');
  expect(readSettingsPage('network', '')).toBe('network');
  expect(readSettingsPage('nope', '')).toBeNull();
  expect(readSettingsPage(null, '#t212-trading-safety')).toBe('trading');
  expect(readSettingsPage(null, '')).toBeNull();
});

test('a phone opens on the list: one-tap settings change in place, every other row opens its page', () => {
  const onNavigate = renderSettings(null, false);
  expect(screen.getByRole('heading', { name: '设置' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('radiogroup', { name: '外观' })).getByRole('radio', { name: '浅色' }));
  expect(theme.setThemeMode).toHaveBeenCalledWith('light');
  fireEvent.click(within(screen.getByRole('radiogroup', { name: '额度显示方式' })).getByRole('radio', { name: '已用' }));
  expect(JSON.parse(localStorage.getItem('studio-quota-display-v1') ?? '{}').mode).toBe('used');
  fireEvent.click(screen.getByRole('switch', { name: '显示图标名称' }));
  expect(getHomeLayout().labels).toBe(false);
  // Current values sit on the rows.
  expect(screen.getByRole('button', { name: /DeepSeek.*已配置/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /关于本机.*v1\.37\.3/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /关于本机/ }));
  expect(onNavigate).toHaveBeenCalledWith('about');
  fireEvent.click(screen.getByRole('button', { name: /andrew/ }));
  expect(onNavigate).toHaveBeenCalledWith('account');
});

test('a wide screen shows the list beside the first page, and pages one level in keep their parent selected', () => {
  const onNavigate = renderSettings(null, true);
  const sidebar = screen.getByRole('navigation', { name: '设置' });
  expect(within(sidebar).getByRole('button', { name: /模型/ }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('heading', { name: '模型' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'open catalog' }));
  expect(onNavigate).toHaveBeenCalledWith('model-list');
  cleanup();

  const back = renderSettings('runtime', true);
  expect(screen.getByText('runtime page')).toBeTruthy();
  expect(within(screen.getByRole('navigation', { name: '设置' })).getByRole('button', { name: /关于本机/ }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: '关于本机' }));
  expect(back).toHaveBeenCalledWith('about');
});
