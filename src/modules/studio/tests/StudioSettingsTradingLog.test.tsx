import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const trading = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { t212Trading: trading } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error), { code: value.code });
    return value;
  },
}));

const { StudioSettingsTradingLog } = await import('@/modules/studio/StudioSettingsTradingLog');

const json = (value: unknown, status = 200) => async () => Response.json(status === 200 ? value : { error: value }, { status });
const accountCaps = (maxOrderValue: number, dailyLimit: number, currency?: string) => ({
  maxOrderValue, dailyLimit, custom: false, updatedAt: null, dailyUsed: 0, dailyRemaining: dailyLimit, ...(currency ? { currency } : {}),
});
const EMPTY = {
  allowedEnvs: ['demo'], tradingMode: { mode: 'demo', ceiling: 'both', custom: true, updatedAt: null },
  modeChanges: [] as unknown[], modeRefusals: [] as unknown[], stepUpRequests: [] as unknown[], capChanges: [] as unknown[], capRefusals: [] as unknown[],
  caps: { ceiling: 10_000, defaults: { maxOrderValue: 500, dailyLimit: 2000 }, envs: { live: accountCaps(500, 2000, 'GBP'), demo: accountCaps(250, 1000) } },
  currency: 'GBP', passkeys: [] as unknown[], trustedOrigins: [], allowLocalhost: true, requirePasskey: false,
};
const thief = { session: 'thief-se', currentSession: false, client: '公网 203.0.*.*' };
const mine = { session: 'owner-se', currentSession: true, client: 'Tailscale 100.64.*.*' };
// Entries recorded before sessions were.
const nobody = { session: null, currentSession: false, client: null };
const capChange = (id: number, at: string, change: Record<string, unknown> = {}) => ({
  id, env: 'demo', direction: 'lower', method: 'session', status: 'applied', from: { maxOrderValue: 500, dailyLimit: 2000 },
  to: { maxOrderValue: 250, dailyLimit: 1000 }, reason: null, origin: 'https://studio.ajarche.com', createdAt: at, ...mine, ...change,
});
const modeChange = (id: number, at: string, change: Record<string, unknown> = {}) => ({
  id, direction: 'narrow', method: 'session', status: 'applied', from: 'both', to: 'off', reason: null, origin: null, createdAt: at, ...mine, ...change,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const rows = async () => within(await screen.findByRole('list', { name: '变更日志' })).getAllByRole('listitem');
const titleOf = (row: HTMLElement) => row.querySelector('strong')?.textContent;

test('merges every Trading 212 record into one list, newest first, read only when the page opens', async () => {
  trading.config.mockImplementation(json({
    ...EMPTY,
    capChanges: [
      // Same id as a trading-mode change: each list numbers its own entries.
      capChange(1, '2026-10-02T08:00:00Z'),
      capChange(4, '2026-10-02T10:00:00Z', { env: 'live', direction: 'raise', method: 'passkey', from: { maxOrderValue: 500, dailyLimit: 2000 }, to: { maxOrderValue: 900, dailyLimit: 2000 } }),
    ],
    capRefusals: [capChange(9, '2026-10-02T11:00:00Z', {
      env: 'live', direction: 'raise', method: 'passkey', status: 'refused', reason: '面容 ID / 触控 ID 验证失败，上限没有改变',
      from: { maxOrderValue: 900, dailyLimit: 2000 }, to: { maxOrderValue: 1200, dailyLimit: 2000 },
    })],
    modeChanges: [modeChange(1, '2026-10-02T09:00:00Z', { to: 'demo' })],
    modeRefusals: [modeChange(2, '2026-10-01T09:00:00Z', { direction: 'widen', method: 'passkey', status: 'refused', from: null, to: null, reason: '交易模式必须为 off、demo、live 或 both' })],
    stepUpRequests: [{ id: 'caps-4', kind: 'caps', env: 'live', to: { maxOrderValue: 900, dailyLimit: 2000 }, outcome: 'used', origin: 'https://studio.ajarche.com', createdAt: '2026-10-02T09:59:00Z', ...mine }],
    passkeys: [{ id: 'k-1', rpId: 'studio.ajarche.com', label: 'iPad', createdAt: '2026-09-30T08:00:00Z', lastUsedAt: '2026-10-02T09:59:30Z' }],
  }));
  render(<StudioSettingsTradingLog />);
  expect(trading.config).toHaveBeenCalledTimes(1);
  const entries = await rows();
  expect(entries.map(titleOf)).toEqual([
    '提高实盘上限被拒绝', '提高实盘上限', '面容 ID 验证请求', '减少下单账户', '降低模拟盘上限', '开启下单被拒绝', '启用面容 ID / 触控 ID',
  ]);
  const [refusedRaise, raise, request, narrowed, lowered, refusedWidening, passkey] = entries;

  // What changed, in the account's currency, how and when, and why it was refused.
  expect(within(refusedRaise).getByText('单笔 £900.00 → £1,200.00 · 每日 £2,000.00')).toBeTruthy();
  expect(within(refusedRaise).getByText(/^面容 ID \/ 触控 ID · /)).toBeTruthy();
  expect(within(refusedRaise).getByText('面容 ID / 触控 ID 验证失败，上限没有改变')).toBeTruthy();
  expect(within(refusedRaise).getByText('已拒绝')).toBeTruthy();
  expect(within(raise).queryByText('已拒绝')).toBeNull();
  expect(within(request).getByText('提高实盘上限 · 单笔 £900.00 · 每日 £2,000.00')).toBeTruthy();
  expect(within(request).getByText(/^已提交验证 · /)).toBeTruthy();
  expect(within(narrowed).getByText('实盘+模拟盘 → 模拟盘')).toBeTruthy();
  expect(within(narrowed).getByText(/^登录会话 · /)).toBeTruthy();
  // Without its own currency the demo account falls back to the last known one.
  expect(within(lowered).getByText('单笔 £500.00 → £250.00 · 每日 £2,000.00 → £1,000.00')).toBeTruthy();
  expect(within(refusedWidening).getByText('请求无效，没有可识别的交易模式')).toBeTruthy();
  expect(within(passkey).getByText('studio.ajarche.com · iPad')).toBeTruthy();
  expect(within(passkey).getByText(/最近使用/)).toBeTruthy();

  // The domain it happened on, then the session and client.
  expect(within(lowered).getByText('studio.ajarche.com · 本会话 · Tailscale 100.64.*.*')).toBeTruthy();
  expect(within(narrowed).getByText('本会话 · Tailscale 100.64.*.*')).toBeTruthy();
  expect(trading.config).toHaveBeenCalledTimes(1);
});

test('Face ID requests and changes made by another session stand out', async () => {
  trading.config.mockImplementation(json({
    ...EMPTY,
    modeChanges: [
      modeChange(3, '2026-10-02T09:40:00Z', { direction: 'narrow', from: 'both', to: 'off', ...thief }),
      modeChange(2, '2026-10-01T09:00:00Z', { direction: 'pin', from: null, to: 'both', reason: '首次读取时固定为服务器当时允许的账户' }),
    ],
    stepUpRequests: [
      { id: 'mode-7', kind: 'mode', to: 'live', outcome: 'replaced', origin: 'https://studio.ajarche.com', createdAt: '2026-10-02T09:30:00Z', ...thief },
      { id: 'caps-1', kind: 'caps', env: 'live', to: { maxOrderValue: 800, dailyLimit: 2000 }, outcome: 'unknown', origin: null, createdAt: '2026-10-01T10:00:00Z', ...nobody },
    ],
  }));
  render(<StudioSettingsTradingLog />);
  const [turnedOff, theirs, legacy, pin] = await rows();

  expect(titleOf(turnedOff)).toBe('关闭下单');
  expect(within(turnedOff).getByText('其他会话 thief-se · 公网 203.0.*.*').className).toBe('t212-history-other');
  expect(within(theirs).getByText('开启下单 · 改为「实盘」')).toBeTruthy();
  expect(within(theirs).getByText(/被同一会话的新请求替换/)).toBeTruthy();
  expect(within(theirs).getByText('studio.ajarche.com · 其他会话 thief-se · 公网 203.0.*.*')).toBeTruthy();
  expect(within(theirs).getByText('其他会话', { selector: '.status-badge' })).toBeTruthy();
  // Recorded before sessions and outcomes were: no session to name.
  expect(within(legacy).getByText(/升级前的记录，结果未知/)).toBeTruthy();
  expect(within(legacy).queryByText(/其他会话/)).toBeNull();
  // A pin made on the first read: the mode that was already in force, now the user's own choice.
  expect(titleOf(pin)).toBe('固定下单账户');
  expect(within(pin).getByText('实盘+模拟盘')).toBeTruthy();
  expect(within(pin).getByText('首次读取时固定为服务器当时允许的账户')).toBeTruthy();
});

test('says when there is nothing yet, and shows a load failure instead of a spinner', async () => {
  trading.config.mockImplementation(json(EMPTY));
  render(<StudioSettingsTradingLog />);
  expect(await screen.findByText('还没有记录')).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
  cleanup();

  trading.config.mockImplementation(json('交易设置暂时不可用', 503));
  render(<StudioSettingsTradingLog />);
  expect(await screen.findByText('交易设置暂时不可用')).toBeTruthy();
  expect(screen.queryByText('读取中')).toBeNull();
});
