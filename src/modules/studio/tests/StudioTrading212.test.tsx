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
const PROVENANCE = { aaguid: '00000000-0000-0000-0000-000000000000', credentialIdPrefix: 'Y3JlZC0x', backedUp: false, multiDevice: false };
const TAILNET_PASSKEY = { id: 'k-tailnet', rpId: 'desktop.tail1234.ts.net', label: 'Windows', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, ...PROVENANCE };
const LOCAL_PASSKEY = { id: 'k-local', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null, ...PROVENANCE };
const HEALTHY_ISOLATION = { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [], notes: [] };
const TRADING_OFF = {
  broker: { status: 'ok', keys: { live: true, demo: true } }, allowedEnvs: [], maxOrderValue: 500, maxOrdersPerHour: 10,
  maxDailyOrderValue: 0, liveOrderCooldownSeconds: 0, passkeys: [], trustedOrigins: [], demoConfirm: false, isolation: HEALTHY_ISOLATION,
};
// The broker allows live orders and this domain has a passkey, so the order form is available.
const TRADING_LIVE = { ...TRADING_OFF, allowedEnvs: ['live'], currency: 'GBP', passkeys: [LOCAL_PASSKEY] };
const AUTHENTICATION = { challenge: 'abc', rpId: 'localhost', allowCredentials: [{ id: 'cred-1', type: 'public-key' }], userVerification: 'required' };
const ASSERTION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { signature: 'sig' }, clientExtensionResults: {} };
const PREVIEW = {
  id: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1,
  estimatedValue: 400, currency: 'GBP', maxOrderValue: 500, warnings: ['实盘账户：这笔订单会用真实资金成交'],
  expiresAt: '2026-10-02T09:01:00Z', requires: 'passkey', authentication: AUTHENTICATION,
};

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

// Fills one share of Apple, reviews it and confirms it with Face ID / Touch ID.
async function confirmOneApple(sheet: HTMLElement) {
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  fireEvent.click(await within(sheet).findByRole('button', { name: /用面容 ID \/ 触控 ID 买入/ }));
  await waitFor(() => expect(trading.confirm).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.platformAuthenticatorIsAvailable.mockResolvedValue(true);
  webauthn.startAuthentication.mockResolvedValue(ASSERTION);
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

test('with trading off, 交易 explains which broker setting enables it', async () => {
  account(TRADING_OFF);
  render(<StudioTrading212 />);
  fireEvent.click(await screen.findByRole('button', { name: '交易' }));
  const sheet = await screen.findByRole('dialog', { name: /交易/ });
  expect(within(sheet).getByText('实盘下单未开启')).toBeTruthy();
  expect(within(sheet).getByText('/var/lib/studio-trader/config.json')).toBeTruthy();
  expect(trading.preview).not.toHaveBeenCalled();
});

test('without the order broker the view stays read-only and 交易 explains why', async () => {
  account({ ...TRADING_LIVE, broker: { status: 'off', message: 'Studio 没有连接交易代理（STUDIO_T212_BROKER_SOCKET 未设置），下单已关闭。' } });
  render(<StudioTrading212 />);
  expect(await screen.findByText(/只读 · 实盘/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '交易' }));
  const sheet = await screen.findByRole('dialog', { name: /交易/ });
  expect(within(sheet).getByText('下单已关闭')).toBeTruthy();
  expect(within(sheet).getByText(/STUDIO_T212_BROKER_SOCKET/)).toBeTruthy();
  expect(within(sheet).queryByRole('button', { name: '下一步' })).toBeNull();
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
  expect(within(sheet).getByText(/预览时交易代理换算成账户货币/)).toBeTruthy();
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

test('a live order is reviewed and confirmed with Face ID / Touch ID; there is no double confirmation', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json(PREVIEW));
  trading.confirm.mockImplementation(json({ order: { id: '9002', status: 'NEW', ticker: 'AAPL_US_EQ' }, method: 'passkey' }));
  const sheet = await openBuyApple();
  expect(within(sheet).getByText('实盘')).toBeTruthy();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  expect(within(sheet).getByText('≈ £400.00')).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));

  expect(await within(sheet).findByText('买入 1 股')).toBeTruthy();
  expect(trading.preview).toHaveBeenCalledWith({ env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1 });
  expect(within(sheet).getByText('实盘账户：这笔订单会用真实资金成交')).toBeTruthy();
  expect(within(sheet).queryByRole('button', { name: '买入下单' })).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: /用面容 ID \/ 触控 ID 买入/ }));
  await waitFor(() => expect(trading.confirm).toHaveBeenCalledWith(PREVIEW.id, { assertion: ASSERTION }));
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: AUTHENTICATION });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已提交买入 1 股 AAPL_US_EQ', expect.anything()));
  await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('a cancelled Face ID prompt places nothing and the same preview can be confirmed again', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json(PREVIEW));
  trading.confirm.mockImplementation(json({ order: { id: '9002', status: 'NEW', ticker: 'AAPL_US_EQ' }, method: 'passkey' }));
  webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  fireEvent.click(await within(sheet).findByRole('button', { name: /用面容 ID \/ 触控 ID 买入/ }));
  expect((await within(sheet).findByRole('alert')).textContent).toContain('已取消面容 ID / 触控 ID 验证，订单没有提交');
  expect(trading.confirm).not.toHaveBeenCalled();
  fireEvent.click(within(sheet).getByRole('button', { name: /用面容 ID \/ 触控 ID 买入/ }));
  await waitFor(() => expect(trading.confirm).toHaveBeenCalledTimes(1));
});

test('demo orders use a destructive confirmation only when the broker allows it', async () => {
  account({ ...TRADING_OFF, allowedEnvs: ['demo'], demoConfirm: true, currency: 'GBP' });
  mocks.status.mockImplementation(json([{ env: 'live', configured: false, source: null }, { env: 'demo', configured: true, source: 'demo' }]));
  mocks.overview.mockImplementation(json({ ...OVERVIEW, env: 'demo' }));
  const demoPreview = { ...PREVIEW, env: 'demo', warnings: [], requires: 'confirm', authentication: undefined };
  trading.preview.mockImplementation(json(demoPreview));
  trading.confirm.mockImplementation(json({ order: { id: '9001', status: 'NEW', ticker: 'AAPL_US_EQ' }, method: 'confirm' }));
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  expect(await within(sheet).findByText('再确认一次（模拟盘）')).toBeTruthy();
  expect(within(sheet).getByText(/实盘订单始终需要面容 ID/)).toBeTruthy();

  // Cancelling the alert places nothing.
  fireEvent.click(within(sheet).getByRole('button', { name: '买入下单' }));
  let alert = await screen.findByRole('alertdialog', { name: '确认买入 1 股 AAPL_US_EQ（约 £400.00）？' });
  fireEvent.click(within(alert).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(trading.confirm).not.toHaveBeenCalled();

  fireEvent.click(within(sheet).getByRole('button', { name: '买入下单' }));
  alert = await screen.findByRole('alertdialog', { name: '确认买入 1 股 AAPL_US_EQ（约 £400.00）？' });
  fireEvent.click(within(alert).getByRole('button', { name: '确认买入' }));
  await waitFor(() => expect(trading.confirm).toHaveBeenCalledWith(PREVIEW.id, { confirmed: true }));
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
});

test('with Face ID enabled only on another domain, the sheet asks for an enrollment code to enable it here', async () => {
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
  expect(within(sheet).queryByLabelText('登录密码')).toBeNull();
  const enable = within(sheet).getByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await waitFor(() => expect((within(sheet).getByLabelText('注册码') as HTMLInputElement).disabled).toBe(false));
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(within(sheet).getByLabelText('注册码'), { target: { value: ' ABCDE-FGHJK-MNPQR-STVWX ' } });
  fireEvent.click(enable);

  await waitFor(() => expect(trading.registerPasskey).toHaveBeenCalledTimes(1));
  expect(trading.passkeyOptions).toHaveBeenCalledWith('ABCDE-FGHJK-MNPQR-STVWX');
  // The refreshed settings include this domain, so the order form appears.
  expect(await within(sheet).findByRole('button', { name: '下一步' })).toBeTruthy();
  expect(trading.preview).not.toHaveBeenCalled();
});

test('a broker refusal for a missing passkey also leads to enabling Face ID here', async () => {
  account(TRADING_LIVE);
  trading.preview.mockImplementation(json('先为 localhost 启用通行密钥：交易代理只接受通行密钥确认的订单', 403, 'T212_PASSKEY_REQUIRED'));
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  expect(await within(sheet).findByText(`先为 ${window.location.hostname} 启用面容 ID / 触控 ID`)).toBeTruthy();
  expect(within(sheet).getByText(/交易代理只接受通行密钥确认的订单/)).toBeTruthy();
  expect(within(sheet).getByLabelText('注册码')).toBeTruthy();
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

test('an identical order held back after an unknown outcome shows the broker’s guidance and offers no override', async () => {
  account(TRADING_LIVE);
  trading.preview
    .mockImplementationOnce(json('约 2 分钟前一笔相同的订单状态未知：请先在 Trading 212 核对它是否已经成交。为免重复下单，交易代理在约 3 分钟内不接受相同的订单', 409, 'T212_ORDER_UNKNOWN_PENDING'))
    .mockImplementation(json(PREVIEW));
  const sheet = await openBuyApple();
  fireEvent.change(within(sheet).getByLabelText('数量'), { target: { value: '1' } });
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  const alert = await within(sheet).findByRole('alert');
  expect(alert.textContent).toContain('请先在 Trading 212 核对');
  expect(alert.textContent).toContain('约 3 分钟内不接受相同的订单');
  // Nothing in Studio can lift the hold: no acknowledgement button, and a retry sends the plain order again.
  expect(within(sheet).queryByRole('button', { name: /核对过|仍要下单/ })).toBeNull();
  expect(within(sheet).queryByText('买入 1 股')).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: '下一步' }));
  await waitFor(() => expect(trading.preview).toHaveBeenLastCalledWith({ env: 'live', ticker: 'AAPL_US_EQ', side: 'buy', type: 'market', quantity: 1 }));
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
