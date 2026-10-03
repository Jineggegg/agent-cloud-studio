import { expect, test } from 'vitest';

import type { QuotaPreferences, StudioQuotaSnapshot } from '@/shared/types';
import { isQuotaItemShown, listQuotaItems, quotaAgeText, quotaAmountText, quotaEndText, quotaShownPercent } from '@/shared/utils';

// Saturday 3 October 2026, 11:24 in London (BST).
const NOW = Date.parse('2026-10-03T10:24:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const CLAUDE: StudioQuotaSnapshot = {
  provider: 'claude', available: true, balances: [], source: 'usage-api', observedAt: at(0), stale: false,
  windows: [
    { id: 'five_hour', label: '5 小时', usedPercent: 9, windowMinutes: 300, resetsAt: at(216) },
    { id: 'seven_day', label: '每周', usedPercent: 4, windowMinutes: 10080, resetsAt: '2026-10-05T06:00:00.000Z' },
    { id: 'weekly_scoped:fable', label: '每周 · Fable', usedPercent: 0, windowMinutes: 10080, resetsAt: null, model: 'Fable' },
  ],
  credits: [{ id: 'cinder_cove', label: '云端额度', usedPercent: 8.4, currency: 'USD', limit: 250, used: 21, remaining: 229, endsAt: '2026-11-05T07:59:00.000Z', endKind: 'expires' }],
};
const CODEX: StudioQuotaSnapshot = {
  provider: 'codex', available: true, balances: [], source: 'official', observedAt: at(0), stale: true,
  windows: [
    { id: 'codex:primary', label: '5 小时', usedPercent: 50, windowMinutes: 300, resetsAt: null },
    { id: 'codex:secondary', label: '每周', usedPercent: 29, windowMinutes: 10080, resetsAt: null },
    { id: 'gpt-reserve:secondary', label: '每周 · GPT Reserve', usedPercent: 0, windowMinutes: 10080, resetsAt: null, model: 'GPT Reserve' },
  ],
};
const DEEPSEEK: StudioQuotaSnapshot = {
  provider: 'deepseek', available: true, windows: [], balances: [{ currency: 'CNY', total: 253.99, granted: 0, toppedUp: 253.99 }],
  source: 'official', observedAt: at(0), stale: false,
};
const NO_CHOICES: QuotaPreferences = { mode: 'remaining', items: {} };

test('remaining is 100 minus the rounded used share, so 剩余 and 已用 always add up to 100', () => {
  expect(quotaShownPercent(9, 'remaining')).toBe(91);
  expect(quotaShownPercent(9, 'used')).toBe(9);
  expect(quotaShownPercent(9.4, 'remaining')).toBe(91);
  expect(quotaShownPercent(9.6, 'remaining')).toBe(90);
  expect(quotaShownPercent(9.6, 'used')).toBe(10);
  expect(quotaShownPercent(0.4, 'remaining')).toBe(100);
  expect(quotaShownPercent(99.5, 'remaining')).toBe(0);
  // An account over its limit, or a bad figure, is clamped.
  expect(quotaShownPercent(104, 'used')).toBe(100);
  expect(quotaShownPercent(104, 'remaining')).toBe(0);
  expect(quotaShownPercent(-3, 'remaining')).toBe(100);
  for (const used of [0, 12.5, 33.3, 66.6, 87.49, 100]) {
    expect(quotaShownPercent(used, 'remaining') + quotaShownPercent(used, 'used')).toBe(100);
  }
});

test('reset and expiry times read in Chinese on the London clock', () => {
  expect(quotaEndText(at(36), NOW)).toBe('36 分钟后重置');
  expect(quotaEndText(at(216), NOW)).toBe('3 小时 36 分后重置');
  expect(quotaEndText(at(120), NOW)).toBe('2 小时后重置');
  // Seconds left round up to a whole minute, never down to "reset".
  expect(quotaEndText(new Date(NOW + 215 * 60_000 + 10_000).toISOString(), NOW)).toBe('3 小时 36 分后重置');
  expect(quotaEndText(new Date(NOW + 20_000).toISOString(), NOW)).toBe('1 分钟后重置');
  // Within a week: weekday and time in London (06:00 UTC is 07:00 BST), with no leading zero, midnight as 0:05.
  expect(quotaEndText('2026-10-05T06:00:00Z', NOW)).toBe('周一 7:00 重置');
  expect(quotaEndText('2026-10-05T23:05:00Z', NOW)).toBe('周二 0:05 重置');
  // Beyond a week: the date (November is back on GMT).
  expect(quotaEndText('2026-11-05T07:59:00Z', NOW, 'expires')).toBe('11月5日 7:59 到期');
  expect(quotaEndText(at(90), NOW, 'expires')).toBe('1 小时 30 分后到期');
  expect(quotaEndText(at(-1), NOW)).toBe('已重置');
  expect(quotaEndText(at(0), NOW, 'expires')).toBe('已到期');
  expect(quotaEndText(null, NOW)).toBeNull();
  expect(quotaEndText('not a date', NOW)).toBeNull();
});

test('the age of an earlier reading is told from ten minutes on, in minutes, hours and then days', () => {
  expect(quotaAgeText(at(0), NOW)).toBeNull();
  expect(quotaAgeText(at(-9.9), NOW)).toBeNull();
  expect(quotaAgeText(at(-10), NOW)).toBe('10 分钟前');
  expect(quotaAgeText(at(-12.7), NOW)).toBe('12 分钟前');
  expect(quotaAgeText(at(-59), NOW)).toBe('59 分钟前');
  expect(quotaAgeText(at(-60), NOW)).toBe('1 小时前');
  expect(quotaAgeText(at(-47 * 60 - 59), NOW)).toBe('47 小时前');
  expect(quotaAgeText(at(-3 * 24 * 60), NOW)).toBe('3 天前');
  expect(quotaAgeText(null, NOW)).toBeNull();
  expect(quotaAgeText('not a date', NOW)).toBeNull();
});

test('items list every window, credit and balance, with the owner\'s defaults and switch titles', () => {
  const items = listQuotaItems([CLAUDE, CODEX, DEEPSEEK]);
  expect(items.map(item => [item.key, item.title, item.shownByDefault])).toEqual([
    ['claude:window:five_hour', 'Claude 5 小时', true],
    ['claude:window:seven_day', 'Claude 每周（全部模型）', true],
    ['claude:window:weekly_scoped:fable', 'Claude 每周 · Fable', false],
    ['claude:credit:cinder_cove', 'Claude 云端额度', false],
    ['codex:window:codex:primary', 'Codex 5 小时', false],
    ['codex:window:codex:secondary', 'Codex 每周', true],
    ['codex:window:gpt-reserve:secondary', 'Codex 每周 · GPT Reserve', false],
    ['deepseek:balance', 'DeepSeek 余额', true],
  ]);
  expect(items.find(item => item.provider === 'codex')?.stale).toBe(true);
  expect(items.every(item => item.present)).toBe(true);

  const choices: QuotaPreferences = { mode: 'used', items: { 'claude:window:five_hour': false, 'claude:credit:cinder_cove': true } };
  expect(items.filter(item => isQuotaItemShown(item, choices)).map(item => item.key)).toEqual([
    'claude:window:seven_day', 'claude:credit:cinder_cove', 'codex:window:codex:secondary', 'deepseek:balance',
  ]);
  expect(items.filter(item => isQuotaItemShown(item, NO_CHOICES))).toHaveLength(4);
});

test('a Codex account without a plan-wide weekly window shows its first plan-wide window by default', () => {
  const codex: StudioQuotaSnapshot = { ...CODEX, windows: [CODEX.windows[2], CODEX.windows[0]] };
  expect(listQuotaItems([codex]).map(item => [item.key, item.shownByDefault])).toEqual([
    ['codex:window:gpt-reserve:secondary', false],
    ['codex:window:codex:primary', true],
  ]);
});

test('unavailable providers add nothing, and Settings gets placeholders for the fixed rows', () => {
  const offline = (provider: StudioQuotaSnapshot['provider']): StudioQuotaSnapshot => ({
    provider, available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '未接入',
  });
  expect(listQuotaItems([offline('claude'), offline('codex'), offline('deepseek')])).toEqual([]);
  const settings = listQuotaItems([offline('claude'), CODEX, offline('deepseek')], { placeholders: true });
  expect(settings.map(item => [item.key, item.present])).toEqual([
    ['claude:window:five_hour', false],
    ['claude:window:seven_day', false],
    ['codex:window:codex:primary', true],
    ['codex:window:codex:secondary', true],
    ['codex:window:gpt-reserve:secondary', true],
    ['deepseek:balance', false],
  ]);
  // Placeholders are not duplicated when the real windows are there.
  expect(listQuotaItems([CLAUDE], { placeholders: true }).map(item => item.key).slice(0, 3))
    .toEqual(['claude:window:five_hour', 'claude:window:seven_day', 'claude:window:weekly_scoped:fable']);
});

test('credit and balance amounts read like the Claude app, by mode', () => {
  const [credit] = listQuotaItems([CLAUDE]).filter(item => item.kind === 'credit');
  expect(quotaAmountText(credit, 'remaining')).toBe('剩余 $229 / $250');
  expect(quotaAmountText(credit, 'used')).toBe('已用 $21 / $250');
  const uncapped = listQuotaItems([{ ...CLAUDE, credits: [{ id: 'extra_usage', label: '额外用量', usedPercent: null, currency: 'USD', limit: null, used: 19.99, remaining: null, endsAt: null, endKind: 'resets' }] }])
    .find(item => item.kind === 'credit')!;
  expect(quotaAmountText(uncapped, 'remaining')).toBe('已用 $19.99');
  const [balance] = listQuotaItems([DEEPSEEK]);
  expect(quotaAmountText(balance, 'remaining')).toBe('¥253.99');
  expect(quotaAmountText(balance, 'used')).toBe('¥253.99');
  expect(quotaAmountText(listQuotaItems([CLAUDE])[0], 'remaining')).toBeNull();
});
