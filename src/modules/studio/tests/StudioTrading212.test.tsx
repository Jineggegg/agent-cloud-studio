import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), overview: vi.fn(), history: vi.fn(), activity: vi.fn() }));
const trading = vi.hoisted(() => ({ config: vi.fn(), preview: vi.fn(), confirm: vi.fn(), passkeyOptions: vi.fn(), registerPasskey: vi.fn(), removePasskey: vi.fn() }));
const webauthn = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { trading212: mocks, t212Trading: trading } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));
vi.mock('@simplewebauthn/browser', () => webauthn);
vi.mock('sonner', () => ({ toast }));

const { StudioTrading212 } = await import('@/modules/studio/StudioTrading212');

const OVERVIEW = {
  env: 'live', currency: 'GBP', totalValue: 1234.5, fetchedAt: '2026-10-02T09:00:00Z',
  cash: { available: 100, reserved: 0, inPies: 0 },
  investments: { value: 1134.5, cost: 1000, unrealized: 134.5, realized: -20 },
  changes: { today: { amount: -12.3, percent: -0.99, since: '2026-10-01T17:00:00Z', flowAdjusted: true }, yesterday: null },
  recordedSince: '2026-09-30T09:00:00Z',
  positions: [
    { ticker: 'AAPL_US_EQ', name: 'Apple', currency: 'USD', quantity: 2, averagePrice: 150, currentPrice: 200, value: 800, cost: 700, pnl: 100, fx: null, openedAt: '' },
    { ticker: 'MSFT_US_EQ', name: 'Microsoft', currency: 'USD', quantity: 1, averagePrice: 350, currentPrice: 330, value: 334.5, cost: 300, pnl: -5, fx: null, openedAt: '' },
  ],
};
const TRADING_OFF = { allowedEnvs: [], maxOrderValue: 500, passkeys: [], trustedOrigins: [], allowLocalhost: true };
const TRADING_LIVE = { ...TRADING_OFF, allowedEnvs: ['live'], currency: 'GBP' };
const PREVIEW = {
  id: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1,
  estimatedValue: 400, currency: 'GBP', maxOrderValue: 500, warnings: ['实盘账户：这笔订单会用真实资金成交'],
  expiresAt: '2026-10-02T09:01:00Z', requires: 'confirm',
};

// Every call gets a fresh Response because a body can only be read once.
const json = (value: unknown, status = 200) => async () => Response.json(status === 200 ? value : { error: value }, { status });

function account(config: unknown) {
  mocks.status.mockImplementation(json([{ env: 'live', configured: true, source: 'trading212-connector' }, { env: 'demo', configured: false, source: null }]));
  mocks.overview.mockImplementation(json(OVERVIEW));
  mocks.history.mockImplementation(json([{ at: '2026-09-30T09:00:00Z', value: 1200, unrealized: 100 }, { at: '2026-10-02T09:00:00Z', value: 1234.5, unrealized: 134.5 }]));
  mocks.activity.mockImplementation(json([]));
  trading.config.mockImplementation(json(config));
}

async function openBuyApple() {
  render(<StudioTrading212 />);
  fireEvent.click(await screen.findByRole('button', { name: '买入 Apple' }));
  return screen.findByRole('dialog', { name: /交易/ });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test('without a key file the view explains setup and never calls the broker', async () => {
  mocks.status.mockResolvedValue(Response.json([{ env: 'live', configured: false, source: null }, { env: 'demo', configured: false, source: null }]));
  trading.config.mockImplementation(json(TRADING_OFF));
  render(<StudioTrading212 />);
  expect(await screen.findByText('尚未接入 Trading 212')).toBeTruthy();
  expect(mocks.overview).not.toHaveBeenCalled();
});

test('shows balance, signed day change, curve and positions, with no order controls while trading is off', async () => {
  account(TRADING_OFF);
  render(<StudioTrading212 />);
  const hero = await screen.findByRole('region', { name: '总资产' });
  expect(within(hero).getByText('£1,234.50')).toBeTruthy();
  expect(within(hero).getByText(/−£12\.30/)).toBeTruthy();
  expect(screen.getByRole('img', { name: /总资产曲线/ })).toBeTruthy();
  expect(screen.getByText('Apple')).toBeTruthy();
  expect(screen.getByText('记录不足', { exact: false })).toBeTruthy();
  expect(mocks.overview).toHaveBeenCalledWith('live');
  expect(screen.getByText(/只读 · 实盘/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /买入|卖出|下单/ })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: '1周' }));
  expect(await screen.findByText('Apple')).toBeTruthy();
});

test('with trading off, 交易 explains which server setting enables it', async () => {
  account(TRADING_OFF);
  render(<StudioTrading212 />);
  fireEvent.click(await screen.findByRole('button', { name: '交易' }));
  const sheet = await screen.findByRole('dialog', { name: /交易/ });
  expect(within(sheet).getByText('实盘下单未开启')).toBeTruthy();
  expect(within(sheet).getByText('STUDIO_T212_TRADING=live')).toBeTruthy();
  expect(trading.preview).not.toHaveBeenCalled();
});

test('the estimate is checked against the cap before any preview is requested', async () => {
  account(TRADING_LIVE);
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '2' } });
  // Two Apple shares are worth £800, above the £500 cap.
  expect(within(sheet).getByText('≈ £800.00')).toBeTruthy();
  expect(within(sheet).getByText(/超过单笔上限 £500\.00/)).toBeTruthy();
  expect((within(sheet).getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '3' } });
  fireEvent.click(within(sheet).getByRole('radio', { name: '卖出' }));
  expect(within(sheet).getByRole('alert').textContent).toContain('卖出数量超过持仓');
  expect(trading.preview).not.toHaveBeenCalled();
});

test('without a passkey an order needs the review and a second destructive confirmation', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json(PREVIEW));
  trading.confirm.mockImplementation(json({ order: { id: '9001', status: 'NEW', ticker: 'AAPL_US_EQ' }, method: 'confirm' }));
  const sheet = await openBuyApple();
  expect(within(sheet).getByText('实盘')).toBeTruthy();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  expect(within(sheet).getByText('≈ £400.00')).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));

  expect(await within(sheet).findByText('买入 1 股')).toBeTruthy();
  expect(trading.preview).toHaveBeenCalledWith({ env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1 });
  expect(within(sheet).getByText('实盘账户：这笔订单会用真实资金成交')).toBeTruthy();
  expect(within(sheet).getByText('二次确认')).toBeTruthy();

  // Cancelling the alert places nothing.
  fireEvent.click(within(sheet).getByRole('button', { name: '买入下单' }));
  let alert = await screen.findByRole('alertdialog', { name: '确认买入 1 股 AAPL_US_EQ（约 £400.00）？' });
  fireEvent.click(within(alert).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(trading.confirm).not.toHaveBeenCalled();

  fireEvent.click(within(sheet).getByRole('button', { name: '买入下单' }));
  alert = await screen.findByRole('alertdialog', { name: '确认买入 1 股 AAPL_US_EQ（约 £400.00）？' });
  fireEvent.click(within(alert).getByRole('button', { name: '确认买入' }));
  await waitFor(() => expect(trading.confirm).toHaveBeenCalledTimes(1));
  expect(trading.confirm).toHaveBeenCalledWith(PREVIEW.id, { confirmed: true });
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已提交买入 1 股 AAPL_US_EQ', expect.anything()));
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('with a passkey for this domain the order is confirmed with Face ID / Touch ID', async () => {
  account({ ...TRADING_LIVE, passkeys: [{ id: 'k1', rpId: 'localhost', label: 'iPad', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null }] });
  const authentication = { challenge: 'abc', rpId: 'localhost', allowCredentials: [{ id: 'cred-1', type: 'public-key' }], userVerification: 'required' };
  const assertion = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { signature: 'sig' }, clientExtensionResults: {} };
  trading.preview.mockImplementation(json({ ...PREVIEW, requires: 'passkey', authentication }));
  trading.confirm.mockImplementation(json({ order: { id: '9002', status: 'NEW', ticker: 'AAPL_US_EQ' }, method: 'passkey' }));
  webauthn.startAuthentication.mockResolvedValue(assertion);
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  fireEvent.click(await within(sheet).findByRole('button', { name: /用面容 ID \/ 触控 ID 买入/ }));
  await waitFor(() => expect(trading.confirm).toHaveBeenCalledWith(PREVIEW.id, { assertion }));
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: authentication });
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('a refused order keeps the error visible and needs a fresh preview', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json(PREVIEW));
  trading.confirm.mockImplementation(json('Trading 212 拒绝了这笔订单：InsufficientFreeForStocksBuy', 400));
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  fireEvent.click(await within(sheet).findByRole('button', { name: '买入下单' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认买入' }));
  expect((await within(sheet).findByRole('alert')).textContent).toContain('InsufficientFreeForStocksBuy');
  expect(within(sheet).getByRole('button', { name: '重新生成预览' })).toBeTruthy();
  expect(toast.success).not.toHaveBeenCalled();
  expect(trading.confirm).toHaveBeenCalledTimes(1);
});
