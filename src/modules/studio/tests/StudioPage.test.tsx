import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as ApiModule from '@/shared/api';

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
const conversations = vi.fn((space: string) => json(space === 'super-professor'
  ? [{ id: 'p1', title: '课程大纲', model: 'deepseek-flash', updated_at: new Date().toISOString(), space }]
  : [{ id: 'd1', title: '通用问题', model: 'deepseek-flash', updated_at: new Date().toISOString(), space }]));

vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { username: 'tester' }, logout: vi.fn() }) }));
vi.mock('@/shared/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: {
    studio: {
      status: () => json({ deepseek: { configured: true, models: ['deepseek-flash'], baseUrl: 'https://api.deepseek.com' }, agentWorkbenchUrl: null, snrRemoteUrl: null }),
      snr: () => json({ connected: false, reason: '未运行' }),
      conversations: (space: string) => conversations(space),
      conversation: vi.fn(),
      closeSnr: () => json({}),
    },
  },
}));

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { StudioPage } = await import('@/modules/studio/StudioPage');

beforeEach(() => { localStorage.clear(); conversations.mockClear(); });
afterEach(cleanup);

test('apps open from the home screen with their own history and return to the home screen', async () => {
  render(<MemoryRouter><StudioPage /></MemoryRouter>);
  const apps = await screen.findByRole('navigation', { name: '应用' });
  await waitFor(() => expect(conversations).toHaveBeenCalledWith('deepseek'));

  fireEvent.click(within(apps).getByRole('button', { name: '超级教授' }));
  const professor = await screen.findByRole('region', { name: '超级教授' });
  await waitFor(() => expect(conversations).toHaveBeenCalledWith('super-professor'));
  expect(await within(professor).findByText('课程大纲')).toBeTruthy();
  expect(within(professor).queryByText('通用问题')).toBeNull();
  expect(within(professor).getByRole('link', { name: '在开发工具中用 Claude 或 Codex 打开' }).getAttribute('href')).toBe('/workspace');

  fireEvent.click(within(professor).getByRole('button', { name: '返回主屏幕' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '超级教授' })).toBeNull());
  expect(screen.getByRole('navigation', { name: '应用' })).toBeTruthy();
});
