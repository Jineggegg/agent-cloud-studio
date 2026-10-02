import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ status: vi.fn(), overview: vi.fn(), history: vi.fn(), activity: vi.fn() }));
const trading = vi.hoisted(() => ({
  config: vi.fn(), preview: vi.fn(), confirm: vi.fn(), passkeyOptions: vi.fn(), registerPasskey: vi.fn(), removalOptions: vi.fn(), removePasskey: vi.fn(),
}));
const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
  platformAuthenticatorIsAvailable: vi.fn(async () => true),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { trading212: mocks, t212Trading: trading } },
  // Like the real helper: failures carry the server's machine-readable code.
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error), { code: value.code });
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
const accountCaps = (dailyUsed = 0) => ({
  maxOrderValue: 500, dailyLimit: 2000, custom: false, updatedAt: null, dailyUsed, dailyRemaining: 2000 - dailyUsed, currency: 'GBP',
});
const CAPS = { ceiling: 10_000, defaults: { maxOrderValue: 500, dailyLimit: 2000 }, envs: { live: accountCaps(), demo: accountCaps() } };
const TRADING_OFF = { allowedEnvs: [], caps: CAPS, capChanges: [], capRefusals: [], passkeys: [], trustedOrigins: [], allowLocalhost: true, requirePasskey: false };
const TRADING_LIVE = { ...TRADING_OFF, allowedEnvs: ['live'], currency: 'GBP' };
const PREVIEW = {
  id: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1,
  estimatedValue: 400, currency: 'GBP', maxOrderValue: 500, dailyLimit: 2000, dailyUsed: 300, dailyRemaining: 1700,
  warnings: ['实盘账户：这笔订单会用真实资金成交'], expiresAt: '2026-10-02T09:01:00Z', requires: 'confirm',
};
const TAILNET_PASSKEY = { id: 'k-tailnet', rpId: 'desktop.tail1234.ts.net', label: 'Windows', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null };
const LOCAL_PASSKEY = { id: 'k-local', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null };

// Every call gets a fresh Response because a body can only be read once; failures carry an optional error code.
const json = (value: unknown, status = 200, code?: string) => async () => Response.json(status === 200 ? value : { error: value, code }, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function account(config: unknown, overview: unknown = OVERVIEW) {
  mocks.status.mockImplementation(json([{ env: 'live', configured: true, source: 'trading212-connector' }, { env: 'demo', configured: false, source: null }]));
  mocks.overview.mockImplementation(json(overview));
  mocks.history.mockImplementation(json([{ at: '2026-09-30T09:00:00Z', value: 1200, unrealized: 100 }, { at: '2026-10-02T09:00:00Z', value: 1234.5, unrealized: 134.5 }]));
  mocks.activity.mockImplementation(json([]));
  trading.config.mockImplementation(json(config));
}

async function openOrder(name = '买入 Apple') {
  render(<StudioTrading212 />);
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name: /交易/ });
}
const openBuyApple = () => openOrder('买入 Apple');

// Fills one share of Apple, reviews it and accepts the second confirmation alert.
async function confirmOneApple(sheet: HTMLElement) {
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  fireEvent.click(await within(sheet).findByRole('button', { name: '买入下单' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确认买入' }));
  await waitFor(() => expect(trading.confirm).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.platformAuthenticatorIsAvailable.mockResolvedValue(true);
});
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

test('the form shows the remaining daily allowance; an order over it is flagged and the server refusal refreshes the caps', async () => {
  account({ ...TRADING_LIVE, caps: { ...CAPS, envs: { ...CAPS.envs, live: accountCaps(1800) } } });
  trading.preview.mockImplementation(json('超过每日上限：过去 24 小时已下单 £1,800.00，这笔约 £400.00，每日上限 £2,000.00（还剩 £200.00）', 400, 'T212_DAILY_CAP'));
  const sheet = await openBuyApple();
  expect(within(sheet).getByText('今日剩余买入额度 £200.00 · 每日上限 £2,000.00（滚动 24 小时）')).toBeTruthy();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  expect(within(sheet).getByText(/超过今日剩余买入额度 £200\.00，服务器会拒绝/)).toBeTruthy();
  // The allowance may be stale, so the server still decides.
  const next = within(sheet).getByRole('button', { name: '下一步' }) as HTMLButtonElement;
  expect(next.disabled).toBe(false);
  expect(trading.config).toHaveBeenCalledTimes(1);
  fireEvent.click(next);
  expect((await within(sheet).findByRole('alert')).textContent).toContain('超过每日上限');
  await waitFor(() => expect(trading.config).toHaveBeenCalledTimes(2));
  expect(trading.confirm).not.toHaveBeenCalled();
});

test('a sell never warns about the daily allowance, which only buys use', async () => {
  account({ ...TRADING_LIVE, caps: { ...CAPS, envs: { ...CAPS.envs, live: accountCaps(1800) } } });
  trading.preview.mockImplementation(json({ ...PREVIEW, side: 'sell', dailyUsed: 1800, dailyRemaining: 200 }));
  const sheet = await openOrder('卖出 Apple');
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  // £400 is above the £200 left for buys, yet a sell is neither flagged nor counted.
  expect(within(sheet).getByText('卖出不占用每日买入额度（今日还可买入 £200.00）')).toBeTruthy();
  expect(within(sheet).queryByText(/超过今日剩余买入额度/)).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  expect(await within(sheet).findByText('£200.00 · 卖出不占用')).toBeTruthy();
});

test('a limit sell at a token price is still valued at what the shares are worth', async () => {
  account(TRADING_LIVE);
  const sheet = await openOrder('卖出 Apple');
  fireEvent.click(within(sheet).getByRole('radio', { name: '限价' }));
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '2' } });
  fireEvent.change(within(sheet).getByLabelText('限价'), { target: { value: '0.01' } });
  expect(within(sheet).getByText('≈ £800.00')).toBeTruthy();
  expect(within(sheet).getByText(/超过单笔上限 £500\.00/)).toBeTruthy();
  expect((within(sheet).getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  // A limit buy is still valued at its limit: 2 × $100 × £2 per dollar.
  fireEvent.click(within(sheet).getByRole('radio', { name: '买入' }));
  fireEvent.change(within(sheet).getByLabelText('限价'), { target: { value: '100' } });
  expect(within(sheet).getByText('≈ £400.00')).toBeTruthy();
  expect(trading.preview).not.toHaveBeenCalled();
});

test('an unheld ticker is not blocked by a cap in the wrong currency; the server converts it', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json({ ...PREVIEW, ticker: 'VODl_EQ', type: 'limit', quantity: 100, limitPrice: 150, estimatedValue: 150 }));
  render(<StudioTrading212 />);
  fireEvent.click(await screen.findByRole('button', { name: '交易' }));
  const sheet = await screen.findByRole('dialog', { name: /交易/ });
  fireEvent.change(within(sheet).getByLabelText('代码'), { target: { value: 'VODl_EQ' } });
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '100' } });
  fireEvent.change(within(sheet).getByLabelText('限价'), { target: { value: '150' } });
  // 15,000 pence would be far above a £500 cap if it were pounds.
  expect(within(sheet).getByText('≈ 15,000')).toBeTruthy();
  expect(within(sheet).getByText(/预览时服务器换算成账户货币/)).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  await waitFor(() => expect(trading.preview).toHaveBeenCalledWith(expect.objectContaining({ ticker: 'VODl_EQ', type: 'limit', quantity: 100, limitPrice: 150 })));
  expect(await within(sheet).findByText('≈ £150.00')).toBeTruthy();
});

test('全部 rounds the holding down to 6 decimals and explains the remainder; invalid precision is explained', async () => {
  const fractional = { ...OVERVIEW, positions: [{ ...OVERVIEW.positions[0], quantity: 0.0573271, value: 22.93 }] };
  account(TRADING_LIVE, fractional);
  const sheet = await openOrder('卖出 Apple');
  fireEvent.click(within(sheet).getByRole('button', { name: '全部' }));
  expect((within(sheet).getByLabelText('数量') as HTMLInputElement).value).toBe('0.057327');
  expect(within(sheet).getByText(/会留下 0\.0000001 股零头/)).toBeTruthy();
  expect((within(sheet).getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(false);

  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '0.0573271' } });
  expect(within(sheet).getByRole('alert').textContent).toBe('数量最多 6 位小数');
  expect((within(sheet).getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: 'abc' } });
  expect(within(sheet).getByRole('alert').textContent).toBe('数量必须是大于 0 的数字');
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
  // The server's own figure for today's allowance, before and after this order.
  expect(within(sheet).getByText('£1,700.00 · 下单后 £1,300.00')).toBeTruthy();

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
  account({ ...TRADING_LIVE, passkeys: [LOCAL_PASSKEY] });
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

test('with Face ID enabled on another domain, the sheet offers to enable it here instead of a double confirmation', async () => {
  account({ ...TRADING_LIVE, passkeys: [TAILNET_PASSKEY] });
  trading.config
    .mockImplementationOnce(json({ ...TRADING_LIVE, passkeys: [TAILNET_PASSKEY] }))
    .mockImplementation(json({ ...TRADING_LIVE, passkeys: [TAILNET_PASSKEY, LOCAL_PASSKEY] }));
  trading.passkeyOptions.mockImplementation(json({ challenge: 'reg-1' }));
  trading.registerPasskey.mockImplementation(json(LOCAL_PASSKEY));
  webauthn.startRegistration.mockResolvedValue({ id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: { attestationObject: 'x' } });
  const sheet = await openBuyApple();

  expect(within(sheet).getByText(`先为 ${window.location.hostname} 启用面容 ID / 触控 ID`)).toBeTruthy();
  expect(within(sheet).getByText(/desktop\.tail1234\.ts\.net/)).toBeTruthy();
  expect(within(sheet).queryByRole('button', { name: '下一步' })).toBeNull();
  const enable = within(sheet).getByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await waitFor(() => expect((within(sheet).getByLabelText('登录密码') as HTMLInputElement).disabled).toBe(false));
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(sheet).getByLabelText('登录密码'), { target: { value: 'studio-password' } });
  fireEvent.click(enable);

  await waitFor(() => expect(trading.registerPasskey).toHaveBeenCalledTimes(1));
  expect(trading.passkeyOptions).toHaveBeenCalledWith('studio-password');
  // The refreshed settings include this domain, so the order form appears.
  expect(await within(sheet).findByRole('button', { name: '下一步' })).toBeTruthy();
  expect(trading.preview).not.toHaveBeenCalled();
});

test('a server refusal of the double confirmation also leads to enabling Face ID here', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json('你已在 desktop.tail1234.ts.net 启用面容 ID / 触控 ID，二次确认不再可用', 403, 'T212_PASSKEY_REQUIRED'));
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  expect(await within(sheet).findByText(`先为 ${window.location.hostname} 启用面容 ID / 触控 ID`)).toBeTruthy();
  expect(within(sheet).getByText(/二次确认不再可用/)).toBeTruthy();
  expect(within(sheet).getByLabelText('登录密码')).toBeTruthy();
});

test('the sheet cannot be closed while a confirmation is in flight, and an unknown outcome sends the user to Trading 212', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json(PREVIEW));
  const pending = deferred<Response>();
  trading.confirm.mockImplementation(() => pending.promise);
  const sheet = await openBuyApple();
  await confirmOneApple(sheet);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

  // Scrim and Escape are ignored while the order is being placed.
  const scrims = document.querySelectorAll('.sheet-scrim');
  fireEvent.click(scrims[scrims.length - 1]);
  fireEvent.keyDown(sheet, { key: 'Escape' });
  await act(() => new Promise(resolve => setTimeout(resolve, 300)));
  expect(screen.getByRole('dialog', { name: /确认订单/ })).toBeTruthy();

  await act(async () => { pending.resolve(Response.json({ error: 'Trading 212 返回 503，订单状态未知：请先在 Trading 212 里确认', code: 'T212_ORDER_UNKNOWN' }, { status: 502 })); });
  const notice = await within(sheet).findByRole('alert');
  expect(notice.textContent).toContain('订单状态未知');
  expect(notice.textContent).toContain('不要直接重新下单');
  expect(within(sheet).queryByRole('button', { name: '重新生成预览' })).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: '关闭，去 Trading 212 核对' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(trading.confirm).toHaveBeenCalledTimes(1);
});

test('an outcome that arrives after the sheet was unmounted is reported with a toast', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json(PREVIEW));
  const pending = deferred<Response>();
  trading.confirm.mockImplementation(() => pending.promise);
  const sheet = await openBuyApple();
  await confirmOneApple(sheet);
  cleanup();
  await act(async () => { pending.resolve(Response.json({ error: 'Trading 212 没有响应，订单状态未知', code: 'T212_ORDER_UNKNOWN' }, { status: 502 })); });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('买入 AAPL_US_EQ 的订单状态未知', expect.objectContaining({
    description: expect.stringContaining('请先在 Trading 212 核对'),
  })));
});

test('an identical order held back after an unknown outcome needs an explicit acknowledgement', async () => {
  account(TRADING_LIVE);
  trading.preview
    .mockImplementationOnce(json('约 2 分钟前一笔相同的订单状态未知：请先在 Trading 212 核对', 409, 'T212_ORDER_UNKNOWN_PENDING'))
    .mockImplementation(json(PREVIEW));
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  expect((await within(sheet).findByRole('alert')).textContent).toContain('状态未知');
  const acknowledgement = { name: /我已在 Trading 212 核对过/ };
  expect(within(sheet).getByRole('button', acknowledgement)).toBeTruthy();
  // Changing the order hides the acknowledgement, which only covers the order the server held back.
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '0.5' } });
  expect(within(sheet).queryByRole('button', acknowledgement)).toBeNull();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', acknowledgement));
  await waitFor(() => expect(trading.preview).toHaveBeenLastCalledWith({ env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1, acknowledgeUnknown: true }));
  expect(await within(sheet).findByText('买入 1 股')).toBeTruthy();
});

test('a refused order keeps the error visible and needs a fresh preview', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json(PREVIEW));
  trading.confirm.mockImplementation(json('Trading 212 拒绝了这笔订单：InsufficientFreeForStocksBuy', 400, 'TRADING212_ERROR'));
  const sheet = await openBuyApple();
  await confirmOneApple(sheet);
  expect((await within(sheet).findByRole('alert')).textContent).toContain('InsufficientFreeForStocksBuy');
  expect(within(sheet).getByRole('button', { name: '重新生成预览' })).toBeTruthy();
  expect(toast.success).not.toHaveBeenCalled();
  expect(trading.confirm).toHaveBeenCalledTimes(1);
});

test('switching between live and demo never shows or trades the other account’s positions', async () => {
  account({ ...TRADING_LIVE, allowedEnvs: ['live', 'demo'] });
  mocks.status.mockImplementation(json([{ env: 'live', configured: true, source: 'live' }, { env: 'demo', configured: true, source: 'demo' }]));
  const demoOverview = deferred<Response>();
  mocks.overview.mockImplementation((env: string) => (env === 'live' ? json(OVERVIEW)() : demoOverview.promise));
  render(<StudioTrading212 />);
  expect(await screen.findByRole('button', { name: '卖出 Apple' })).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: '模拟' }));
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledWith('demo'));
  // While demo is loading, nothing from the live account remains on screen or tradable.
  expect(screen.queryByText('Apple')).toBeNull();
  expect(screen.queryByRole('button', { name: /卖出|买入/ })).toBeNull();
  expect(screen.queryByRole('button', { name: '交易' })).toBeNull();

  await act(async () => {
    demoOverview.resolve(Response.json({ ...OVERVIEW, env: 'demo', positions: [{ ...OVERVIEW.positions[1], quantity: 5 }] }));
  });
  expect(await screen.findByRole('button', { name: '卖出 Microsoft' })).toBeTruthy();
  expect(screen.queryByText('Apple')).toBeNull();
});
