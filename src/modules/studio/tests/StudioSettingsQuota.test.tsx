import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ quota: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { quota: mocks.quota } },
  readApiJson: async (response: Response) => response.json(),
}));

import type { StudioQuotaSnapshot } from '@/shared/types';
import { StudioSettingsQuota } from '@/modules/studio/StudioSettingsQuota';

const STORAGE_KEY = 'studio-quota-display-v1';
const HOUR = 3_600_000;
const SNAPSHOTS: StudioQuotaSnapshot[] = [
  { provider: 'claude', available: true, balances: [], source: 'usage-api', observedAt: new Date().toISOString(), stale: false,
    windows: [
      { id: 'five_hour', label: '5 小时', usedPercent: 9, windowMinutes: 300, resetsAt: new Date(Date.now() + 3 * HOUR + 30 * 60_000).toISOString() },
      { id: 'seven_day', label: '每周', usedPercent: 4, windowMinutes: 10080, resetsAt: null },
      { id: 'weekly_scoped:fable', label: '每周 · Fable', usedPercent: 0, windowMinutes: 10080, resetsAt: null, model: 'Fable' },
    ],
    credits: [{ id: 'cinder_cove', label: '云端额度', usedPercent: 8.4, currency: 'USD', limit: 250, used: 21, remaining: 229, endsAt: null, endKind: 'expires' }] },
  { provider: 'codex', available: true, balances: [], source: 'official', observedAt: new Date().toISOString(), stale: false,
    windows: [
      { id: 'codex:secondary', label: '每周', usedPercent: 29, windowMinutes: 10080, resetsAt: null },
      { id: 'gpt-reserve:secondary', label: '每周 · GPT Reserve', usedPercent: 0, windowMinutes: 10080, resetsAt: null, model: 'GPT Reserve' },
    ] },
  { provider: 'deepseek', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '请先设置密钥' },
];

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const switchFor = (name: string) => screen.getByRole('switch', { name }) as HTMLInputElement;

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  mocks.quota.mockImplementation(() => json(SNAPSHOTS));
});

test('every reported item gets a switch with the owner\'s defaults, and the fixed rows are listed even without data', async () => {
  render(<StudioSettingsQuota />);
  await screen.findByRole('switch', { name: 'Claude 每周 · Fable' });
  const list = screen.getByRole('group', { name: '显示的额度' });
  expect(within(list).getAllByRole('switch').map(item => [item.getAttribute('aria-label'), (item as HTMLInputElement).checked])).toEqual([
    ['Claude 5 小时', true],
    ['Claude 每周（全部模型）', true],
    ['Claude 每周 · Fable', false],
    ['Claude 云端额度', false],
    ['Codex 每周', true],
    ['Codex 每周 · GPT Reserve', false],
    ['DeepSeek 余额', true],
  ]);
  // Each row says what it shows now, in the chosen mode.
  expect(within(list).getByText('剩余 91% · 3 小时 30 分后重置')).toBeTruthy();
  expect(within(list).getByText('剩余 92% · 剩余 $229 / $250')).toBeTruthy();
  expect(within(list).getByText('暂无数据')).toBeTruthy();
});

test('switches and the 剩余 / 已用 choice are saved on this device and survive a remount', async () => {
  const { unmount } = render(<StudioSettingsQuota />);
  await screen.findByRole('switch', { name: 'Claude 云端额度' });
  fireEvent.click(switchFor('Claude 5 小时'));
  fireEvent.click(switchFor('Claude 云端额度'));
  fireEvent.click(screen.getByRole('radio', { name: '已用' }));
  expect(screen.getByRole('radio', { name: '已用' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('已用 4%')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
    mode: 'used', items: { 'claude:window:five_hour': false, 'claude:credit:cinder_cove': true },
  });

  unmount();
  render(<StudioSettingsQuota />);
  await screen.findByRole('switch', { name: 'Claude 云端额度' });
  expect(switchFor('Claude 5 小时').checked).toBe(false);
  expect(switchFor('Claude 云端额度').checked).toBe(true);
  expect(screen.getByRole('radio', { name: '已用' }).getAttribute('aria-checked')).toBe('true');
});

test('a failed quota read still lists the fixed rows', async () => {
  mocks.quota.mockImplementation(() => Promise.reject(new Error('offline')));
  render(<StudioSettingsQuota />);
  await screen.findByRole('switch', { name: 'Claude 5 小时' });
  expect(screen.getAllByRole('switch').map(item => item.getAttribute('aria-label'))).toEqual(['Claude 5 小时', 'Claude 每周（全部模型）', 'DeepSeek 余额']);
});
