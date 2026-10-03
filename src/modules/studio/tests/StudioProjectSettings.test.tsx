import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HubProject } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  projects: { update: vi.fn(), create: vi.fn() },
  remote: { hosts: vi.fn() },
  mail: { accounts: vi.fn() },
}));
vi.mock('@/shared/api', () => ({
  api: { studio: { projects: mocks.projects, remote: mocks.remote, mail: mocks.mail } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));

const { StudioProjectEditor } = await import('@/modules/studio/StudioProjectEditor');

const base: HubProject = {
  id: 'p', name: '项目', description: '', workspacePath: '/home/me/projects/p', modules: ['agents', 'automations'], providers: ['claude', 'deepseek'],
  tone: 'stone', glyph: 'folder', links: [], remoteHost: '', remoteDir: '', updatedAt: '1',
};
const PRODUCT_SWITCHES = ['K 线实验室', '股票分析', '邮箱'];

// The labelled module and automation switches (the model switches are named by their row instead).
function shownSwitches() {
  return screen.getAllByRole('switch').map(item => item.getAttribute('aria-label')).filter(Boolean);
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.remote.hosts.mockImplementation(async () => Response.json([]));
  mocks.mail.accounts.mockImplementation(async () => Response.json({ accounts: [{ id: 'gmail-1', provider: 'gmail-imap', email: 'me@gmail.test', displayName: '', status: 'ok', lastError: null, createdAt: '' }], outlookConfigured: false }));
});

describe('a project’s 设置 tab shows only what belongs to its product', () => {
  it('超级教授 has no K 线实验室, 股票分析 or 邮箱 settings — only the generic ones and its teaching sites', () => {
    render(<StudioProjectEditor project={{ ...base, name: '超级教授', glyph: 'graduation', product: 'professor' }} onSaved={vi.fn()} />);
    for (const name of PRODUCT_SWITCHES) expect(screen.queryByRole('switch', { name })).toBeNull();
    expect(screen.queryByText(/K 线/)).toBeNull();
    expect(screen.queryByText(/Trading 212|交易安全/)).toBeNull();
    expect(screen.getByRole('heading', { name: '教学网站' })).toBeTruthy();
    expect(shownSwitches()).toEqual(['AI 助手', '自动化', '自动化通知']);
    expect(screen.getByRole('heading', { name: '通知与自动化' })).toBeTruthy();
  });

  it('a project saved before products existed is still recognised as 超级教授 by its name', () => {
    render(<StudioProjectEditor project={{ ...base, name: '超级教授' }} onSaved={vi.fn()} />);
    expect(screen.queryByRole('switch', { name: 'K 线实验室' })).toBeNull();
    expect(screen.getByRole('heading', { name: '教学网站' })).toBeTruthy();
  });

  it('SNR, Trading 212 and 邮件 each get their own section and nothing of the others', () => {
    const snr = render(<MemoryRouter><StudioProjectEditor project={{ ...base, name: 'SNR 3.0', modules: ['agents', 'snr-lab'], product: 'snr' }} onSaved={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'K 线实验室' })).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'K 线实验室' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('switch', { name: '股票分析' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '邮箱' })).toBeNull();
    snr.unmount();

    const trading = render(<MemoryRouter><StudioProjectEditor project={{ ...base, name: 'Trading 212', modules: ['agents', 'trading212'], product: 'trading212' }} onSaved={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('switch', { name: '股票分析' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /打开设置.*交易安全/ }).getAttribute('href')).toBe('/apps/connections');
    expect(screen.queryByRole('switch', { name: 'K 线实验室' })).toBeNull();
    trading.unmount();

    render(<MemoryRouter><StudioProjectEditor project={{ ...base, name: '邮件', modules: ['mail'], product: 'mail' }} onSaved={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('switch', { name: '邮箱' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /设置 → 邮箱/ })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'K 线实验室' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '股票分析' })).toBeNull();
  });

  it('a new or ordinary project gets the generic settings only; a legacy integration stays visible so it can be switched off', () => {
    const fresh = render(<StudioProjectEditor onSaved={vi.fn()} />);
    for (const name of PRODUCT_SWITCHES) expect(screen.queryByRole('switch', { name })).toBeNull();
    expect(screen.getByRole('switch', { name: 'AI 助手' })).toBeTruthy();
    fresh.unmount();

    render(<StudioProjectEditor project={{ ...base, modules: ['agents', 'trading212'], product: 'custom' }} onSaved={vi.fn()} />);
    const legacy = screen.getByRole('switch', { name: '股票分析' });
    expect(within(legacy.closest('label') as HTMLElement).getByText('不属于这个项目，关闭后不能再在这里开启')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'K 线实验室' })).toBeNull();
  });

  it('saves the notification and automation defaults with the project', async () => {
    mocks.projects.update.mockImplementation(async (_id: string, input: object) => Response.json({ ...base, ...input }));
    const saved = vi.fn();
    render(<StudioProjectEditor project={{ ...base, product: 'custom', automation: { notify: true, mailAccountId: '', morningTime: '08:00' } }} onSaved={saved} />);
    await screen.findByRole('option', { name: 'me@gmail.test' });
    fireEvent.click(screen.getByRole('switch', { name: '自动化通知' }));
    fireEvent.change(screen.getByLabelText('默认邮箱'), { target: { value: 'gmail-1' } });
    fireEvent.change(screen.getByLabelText('“早上”'), { target: { value: '07:15' } });
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(mocks.projects.update.mock.calls[0][1]).toMatchObject({ automation: { notify: false, mailAccountId: 'gmail-1', morningTime: '07:15' } });
  });
});
