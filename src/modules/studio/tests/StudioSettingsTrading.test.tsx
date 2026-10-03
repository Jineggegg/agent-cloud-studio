import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const trading = vi.hoisted(() => ({
  config: vi.fn(), passkeyOptions: vi.fn(), registerPasskey: vi.fn(), removalOptions: vi.fn(), removePasskey: vi.fn(),
  capsChallenge: vi.fn(), updateCaps: vi.fn(),
}));
const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
  platformAuthenticatorIsAvailable: vi.fn(async () => true),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { t212Trading: trading } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error), { code: value.code });
    return value;
  },
}));
vi.mock('@simplewebauthn/browser', () => webauthn);
vi.mock('sonner', () => ({ toast }));

const { StudioSettingsTrading } = await import('@/modules/studio/StudioSettingsTrading');

const json = (value: unknown, status = 200, code?: string) => async () => Response.json(status === 200 ? value : { error: value, code }, { status });
const OTHER_DOMAIN = { id: 'k-tailnet', rpId: 'desktop.tail1234.ts.net', label: 'Windows', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null };
const THIS_DOMAIN = { id: 'k-local', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null };
const accountCaps = (maxOrderValue: number, dailyLimit: number, dailyUsed = 0, custom = false) => ({
  maxOrderValue, dailyLimit, custom, updatedAt: custom ? '2026-10-02T08:00:00Z' : null, dailyUsed, dailyRemaining: dailyLimit - dailyUsed, currency: 'GBP',
});
const CAPS = { ceiling: 10_000, defaults: { maxOrderValue: 500, dailyLimit: 2000 }, envs: { live: accountCaps(500, 2000), demo: accountCaps(250, 1000, 160, true) } };
const CONFIG = {
  allowedEnvs: ['demo'], caps: CAPS, capChanges: [] as unknown[], capRefusals: [] as unknown[], currency: 'GBP', passkeys: [OTHER_DOMAIN],
  trustedOrigins: [], allowLocalhost: true, requirePasskey: false,
};
const capChange = (id: number, change: Record<string, unknown> = {}) => ({
  id, env: 'demo', direction: 'lower', method: 'session', status: 'applied', from: { maxOrderValue: 500, dailyLimit: 2000 },
  to: { maxOrderValue: 250, dailyLimit: 1000 }, reason: null, origin: null, createdAt: '2026-10-02T08:00:00Z', ...change,
});
const capsForm = () => screen.getByRole('form', { name: '下单上限' });
async function typeCaps(maxOrderValue: string, dailyLimit?: string) {
  const form = await screen.findByRole('form', { name: '下单上限' });
  fireEvent.change(within(form).getByLabelText('单笔上限'), { target: { value: maxOrderValue } });
  if (dailyLimit !== undefined) fireEvent.change(within(form).getByLabelText('每日上限'), { target: { value: dailyLimit } });
  return form;
}

// Works with `screen` and with `within(alert)`, which both expose getByLabelText.
async function typePassword(scope: { getByLabelText: (text: string) => HTMLElement }, password: string) {
  const field = scope.getByLabelText('登录密码') as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: password } });
}

beforeEach(() => {
  vi.clearAllMocks();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.platformAuthenticatorIsAvailable.mockResolvedValue(true);
});
afterEach(cleanup);

test('shows the allowed accounts, the cap and passkeys by domain, then registers one for this domain after the password', async () => {
  trading.config.mockImplementationOnce(json(CONFIG)).mockImplementation(json({ ...CONFIG, passkeys: [OTHER_DOMAIN, THIS_DOMAIN] }));
  trading.passkeyOptions.mockImplementation(json({ challenge: 'reg-1', rp: { id: 'localhost', name: 'Agent Cloud Studio' } }));
  trading.registerPasskey.mockImplementation(json(THIS_DOMAIN));
  const attestation = { id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: { attestationObject: 'x' } };
  webauthn.startRegistration.mockResolvedValue(attestation);
  render(<StudioSettingsTrading />);

  expect(await screen.findByText('仅模拟盘')).toBeTruthy();
  // The caps editor opens on the account that may trade, with its saved caps and today's usage.
  expect((within(capsForm()).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('250');
  expect((within(capsForm()).getByLabelText('每日上限') as HTMLInputElement).value).toBe('1000');
  expect(within(capsForm()).getByText('已用 £160.00 · 还可买入 £840.00')).toBeTruthy();
  expect(screen.getByText('desktop.tail1234.ts.net')).toBeTruthy();
  // Face ID exists on another domain, so this one cannot trade until it has its own.
  expect(screen.getByText('需先启用面容 ID')).toBeTruthy();
  expect(screen.getByText(/你已在其他网址启用了面容 ID/)).toBeTruthy();
  expect(screen.getByText(/还没有任何通行密钥时，每笔订单都需要二次确认/)).toBeTruthy();

  const enable = await screen.findByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await typePassword(screen, '');
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  await typePassword(screen, 'studio-password');
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(enable);
  await waitFor(() => expect(trading.registerPasskey).toHaveBeenCalledWith(attestation));
  expect(trading.passkeyOptions).toHaveBeenCalledWith('studio-password');
  expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'reg-1', rp: { id: 'localhost', name: 'Agent Cloud Studio' } } });
  expect(await screen.findByText('当前')).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith(`已在 ${window.location.hostname} 启用面容 ID / 触控 ID 下单`);
  expect(screen.getByRole('button', { name: '在这台设备上也启用面容 ID / 触控 ID' })).toBeTruthy();
  expect(screen.getByText('可下单')).toBeTruthy();
});

test('a wrong password is shown and nothing is registered', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [] }));
  trading.passkeyOptions.mockImplementation(json('Studio 密码不正确', 403, 'T212_STEP_UP_FAILED'));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('可下单')).toBeTruthy();
  await typePassword(screen, 'guess');
  fireEvent.click(screen.getByRole('button', { name: '启用面容 ID / 触控 ID 下单' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Studio 密码不正确');
  expect(webauthn.startRegistration).not.toHaveBeenCalled();
  expect(trading.registerPasskey).not.toHaveBeenCalled();
});

test('removing another domain’s passkey asks for the password; a wrong one keeps the alert open', async () => {
  trading.config.mockImplementationOnce(json({ ...CONFIG, passkeys: [OTHER_DOMAIN] })).mockImplementation(json({ ...CONFIG, passkeys: [] }));
  trading.removePasskey.mockImplementationOnce(json('Studio 密码不正确', 403, 'T212_STEP_UP_FAILED')).mockImplementation(json({ removed: true }));
  render(<StudioSettingsTrading />);

  fireEvent.click(await screen.findByRole('button', { name: '移除 desktop.tail1234.ts.net 的通行密钥' }));
  const alert = await screen.findByRole('alertdialog', { name: '移除 desktop.tail1234.ts.net 的通行密钥？' });
  // Face ID can only authorise the removal on the passkey's own domain.
  expect(within(alert).queryByRole('button', { name: /用面容 ID/ })).toBeNull();
  const remove = within(alert).getByRole('button', { name: '移除' }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);

  await typePassword(within(alert), 'guess');
  fireEvent.click(remove);
  expect((await within(alert).findByRole('alert')).textContent).toBe('Studio 密码不正确');
  expect(screen.getByRole('alertdialog')).toBeTruthy();

  await typePassword(within(alert), 'studio-password');
  fireEvent.click(within(alert).getByRole('button', { name: '移除' }));
  await waitFor(() => expect(trading.removePasskey).toHaveBeenLastCalledWith('k-tailnet', { password: 'studio-password' }));
  await waitFor(() => expect(screen.queryByText('desktop.tail1234.ts.net')).toBeNull());
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(trading.removalOptions).not.toHaveBeenCalled();
});

test('this domain’s passkey can authorise its own removal with Face ID; a cancelled registration explains itself', async () => {
  trading.config.mockImplementationOnce(json({ ...CONFIG, passkeys: [THIS_DOMAIN] })).mockImplementation(json({ ...CONFIG, passkeys: [] }));
  const options = { challenge: 'rm-1', allowCredentials: [{ id: 'cred-local', type: 'public-key' }], userVerification: 'required' };
  const assertion = { id: 'cred-local', rawId: 'cred-local', type: 'public-key', response: { signature: 'sig' }, clientExtensionResults: {} };
  trading.removalOptions.mockImplementation(json(options));
  trading.removePasskey.mockImplementation(json({ removed: true }));
  webauthn.startAuthentication.mockResolvedValue(assertion);
  render(<StudioSettingsTrading />);

  fireEvent.click(await screen.findByRole('button', { name: `移除 ${window.location.hostname} 的通行密钥` }));
  const alert = await screen.findByRole('alertdialog');
  fireEvent.click(within(alert).getByRole('button', { name: '用面容 ID / 触控 ID 验证' }));
  await waitFor(() => expect(trading.removePasskey).toHaveBeenCalledWith('k-local', { assertion }));
  expect(trading.removalOptions).toHaveBeenCalledWith('k-local');
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

  trading.passkeyOptions.mockImplementation(json({ challenge: 'reg-2' }));
  webauthn.startRegistration.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  const enable = await screen.findByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await typePassword(screen, 'studio-password');
  fireEvent.click(enable);
  expect((await screen.findByRole('alert')).textContent).toContain('已取消');
  expect(trading.registerPasskey).not.toHaveBeenCalled();
});

test('an untrusted address cannot enable Face ID and trading-off explains the setting', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, allowedEnvs: [], allowLocalhost: false, passkeys: [] }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('已关闭')).toBeTruthy();
  expect(screen.getByText('未列入白名单')).toBeTruthy();
  expect((screen.getByRole('button', { name: '启用面容 ID / 触控 ID 下单' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('登录密码') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN/)).toBeTruthy();
  expect(screen.getByText('STUDIO_T212_TRADING=demo')).toBeTruthy();
});

test('with STUDIO_T212_REQUIRE_PASSKEY the domain needs its own passkey even before any exists', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [], requirePasskey: true }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('需先启用面容 ID')).toBeTruthy();
  expect(screen.getByText(/STUDIO_T212_REQUIRE_PASSKEY=1/)).toBeTruthy();
});

test('lowering a cap is saved with the session alone, toasted and listed in the change history', async () => {
  const lowered = { ...CONFIG, caps: { ...CAPS, envs: { ...CAPS.envs, demo: accountCaps(200, 1000, 160, true) } }, capChanges: [capChange(1, { from: { maxOrderValue: 250, dailyLimit: 1000 }, to: { maxOrderValue: 200, dailyLimit: 1000 } })] };
  trading.config.mockImplementationOnce(json(CONFIG)).mockImplementation(json(lowered));
  trading.updateCaps.mockImplementation(json({ env: 'demo', direction: 'lower', method: 'session' }));
  render(<StudioSettingsTrading />);

  const form = await typeCaps('200');
  const save = within(form).getByRole('button', { name: '降低上限' });
  fireEvent.click(save);
  await waitFor(() => expect(trading.updateCaps).toHaveBeenCalledWith({ env: 'demo', maxOrderValue: 200, dailyLimit: 1000 }));
  expect(trading.updateCaps.mock.calls[0]).toHaveLength(1);
  expect(trading.capsChallenge).not.toHaveBeenCalled();
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已降低模拟盘上限', { description: '单笔 £200.00 · 每日 £1,000.00' }));

  const history = await screen.findByRole('list', { name: '上限变更记录' });
  expect(within(history).getByText('模拟盘 · 降低')).toBeTruthy();
  expect(within(history).getByText('单笔 £250.00 → £200.00 · 每日 £1,000.00')).toBeTruthy();
  // The form now starts from the saved values, so nothing is left to save.
  expect((within(capsForm()).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('200');
  expect((within(capsForm()).getByRole('button', { name: '保存上限' }) as HTMLButtonElement).disabled).toBe(true);
});

test('raising asks for a challenge bound to the new values and signs it with Face ID on this domain', async () => {
  const withPasskey = { ...CONFIG, passkeys: [THIS_DOMAIN] };
  trading.config.mockImplementation(json(withPasskey));
  const authentication = { challenge: 'bound-challenge', rpId: window.location.hostname, allowCredentials: [{ id: 'cred-local', type: 'public-key' }], userVerification: 'required' };
  const assertion = { id: 'cred-local', rawId: 'cred-local', type: 'public-key', response: { signature: 'sig' }, clientExtensionResults: {} };
  trading.capsChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '2026-10-02T10:01:00Z', authentication }));
  trading.updateCaps.mockImplementation(json({ env: 'demo', direction: 'raise', method: 'passkey' }));
  webauthn.startAuthentication.mockResolvedValue(assertion);
  render(<StudioSettingsTrading />);

  // A mixed change (per-order up, daily down) is a raise too.
  const form = await typeCaps('400', '900');
  fireEvent.click(within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }));
  const input = { env: 'demo', maxOrderValue: 400, dailyLimit: 900 };

  // Before Face ID, the account and both caps from → to are shown for review; everything else is locked.
  const review = await screen.findByRole('alertdialog', { name: '提高模拟盘上限？' });
  expect(trading.capsChallenge).toHaveBeenCalledWith(input);
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  expect(within(review).getByText('模拟盘')).toBeTruthy();
  expect(within(review).getByText('£250.00 → £400.00')).toBeTruthy();
  expect(within(review).getByText('£1,000.00 → £900.00')).toBeTruthy();
  expect((within(form).getByLabelText('单笔上限') as HTMLInputElement).disabled).toBe(true);
  expect((within(form).getByLabelText('每日上限') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('radio', { name: '实盘' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(within(review).getByRole('button', { name: '用面容 ID / 触控 ID 确认' }));
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: authentication });
  await waitFor(() => expect(trading.updateCaps).toHaveBeenCalledWith(input, { challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', assertion }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已用面容 ID / 触控 ID 提高模拟盘上限', { description: '单笔 £400.00 · 每日 £900.00' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(trading.config).toHaveBeenCalledTimes(2);
  expect((screen.getByRole('radio', { name: '实盘' }) as HTMLButtonElement).disabled).toBe(false);
});

test('cancelling the review sends nothing to Face ID and unlocks the editor', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  trading.capsChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' } }));
  render(<StudioSettingsTrading />);
  const form = await typeCaps('400');
  fireEvent.click(within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }));
  const review = await screen.findByRole('alertdialog', { name: '提高模拟盘上限？' });
  // Only the per-order cap changes; the daily one is shown as it stays.
  expect(within(review).getByText('£1,000.00')).toBeTruthy();
  fireEvent.click(within(review).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  expect(trading.updateCaps).not.toHaveBeenCalled();
  expect((within(form).getByLabelText('单笔上限') as HTMLInputElement).disabled).toBe(false);
  expect((within(form).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('400');
});

test('a rate-limited raise is explained and toasted without a review', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  trading.capsChallenge.mockImplementation(json('一小时内发起提高上限的次数过多，请约 42 分钟后再试；降低上限不受影响', 429, 'T212_CAPS_RATE_LIMITED'));
  render(<StudioSettingsTrading />);
  const form = await typeCaps('400');
  fireEvent.click(within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }));
  expect((await screen.findByRole('alert')).textContent).toContain('次数过多');
  expect(toast.error).toHaveBeenCalledWith('上限没有提高', { description: expect.stringContaining('42 分钟') });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect((within(form).getByLabelText('单笔上限') as HTMLInputElement).disabled).toBe(false);
});

test('without a passkey caps cannot be raised and the editor says to enable Face ID first; lowering still works', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [] }));
  render(<StudioSettingsTrading />);
  const form = await typeCaps('300');
  expect((within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/提高上限需要面容 ID \/ 触控 ID：请先在上方启用/)).toBeTruthy();
  fireEvent.change(within(form).getByLabelText('单笔上限'), { target: { value: '100' } });
  expect((within(form).getByRole('button', { name: '降低上限' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/请先在上方启用/)).toBeNull();
  cleanup();

  // A passkey on another domain does not let this one raise.
  trading.config.mockImplementation(json(CONFIG));
  render(<StudioSettingsTrading />);
  const other = await typeCaps('300');
  expect((within(other).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(new RegExp(`请先在上方为 ${window.location.hostname} 启用，或到 desktop\\.tail1234\\.ts\\.net 操作`))).toBeTruthy();
  expect(trading.capsChallenge).not.toHaveBeenCalled();
});

test('values are checked against the ceiling, each other and two decimals before anything is sent', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  render(<StudioSettingsTrading />);
  const form = await typeCaps('250', '10000.01');
  expect(within(form).getByRole('button', { name: '保存上限' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('上限不能超过服务器硬上限 £10,000.00');
  fireEvent.change(within(form).getByLabelText('每日上限'), { target: { value: '200' } });
  expect(screen.getByRole('alert').textContent).toBe('单笔上限不能超过每日上限');
  fireEvent.change(within(form).getByLabelText('每日上限'), { target: { value: '1000.005' } });
  expect(screen.getByRole('alert').textContent).toBe('每日上限最多 2 位小数');
  fireEvent.change(within(form).getByLabelText('单笔上限'), { target: { value: '0' } });
  expect(screen.getByRole('alert').textContent).toBe('单笔上限必须是大于 0 的数字');
  expect((within(form).getByRole('button', { name: '保存上限' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/服务器硬上限 £10,000\.00/)).toBeTruthy();
  expect(trading.capsChallenge).not.toHaveBeenCalled();
  expect(trading.updateCaps).not.toHaveBeenCalled();
});

test('a cancelled Face ID changes nothing quietly; a server refusal is shown and toasted', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  trading.capsChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' } }));
  webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  render(<StudioSettingsTrading />);
  const form = await typeCaps('400');
  const confirmReview = async () => {
    fireEvent.click(within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '用面容 ID / 触控 ID 确认' }));
  };
  await confirmReview();
  expect((await screen.findByRole('alert')).textContent).toBe('已取消面容 ID / 触控 ID 验证，上限没有改变');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(trading.updateCaps).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();

  webauthn.startAuthentication.mockResolvedValue({ id: 'cred-local', rawId: 'cred-local', response: { signature: 'sig' } });
  trading.updateCaps.mockImplementation(json('提交的上限和面容 ID 验证时的不一致，没有保存', 403, 'T212_CAPS_TAMPERED'));
  await confirmReview();
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('上限没有提高', { description: '提交的上限和面容 ID 验证时的不一致，没有保存' }));
  expect(trading.capsChallenge).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('alert').textContent).toBe('提交的上限和面容 ID 验证时的不一致，没有保存');
  expect(toast.success).not.toHaveBeenCalled();
  expect((within(form).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('400');
});

test('the editor switches accounts and lists applied changes apart from refused raises', async () => {
  const changes = [
    capChange(5, { env: 'live', direction: 'raise', method: 'passkey', from: { maxOrderValue: 300, dailyLimit: 2000 }, to: { maxOrderValue: 500, dailyLimit: 2000 } }),
    capChange(4), capChange(3), capChange(2), capChange(1),
  ];
  const refusals = [
    capChange(9, { env: null, direction: 'raise', method: 'passkey', status: 'refused', reason: '面容 ID 验证编号无效，请重新提交', from: null, to: null }),
    capChange(8, { env: 'live', direction: 'raise', method: 'passkey', status: 'refused', reason: '面容 ID / 触控 ID 验证失败，上限没有改变', to: { maxOrderValue: 900, dailyLimit: 2000 }, from: { maxOrderValue: 500, dailyLimit: 2000 } }),
  ];
  trading.config.mockImplementation(json({ ...CONFIG, capChanges: changes, capRefusals: refusals }));
  render(<StudioSettingsTrading />);
  const history = await screen.findByRole('list', { name: '上限变更记录' });
  expect(within(history).getAllByRole('listitem')).toHaveLength(4);
  expect(within(history).getByText('实盘 · 提高')).toBeTruthy();
  expect(within(history).queryByText('已拒绝')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '显示全部 5 条' }));
  expect(within(history).getAllByRole('listitem')).toHaveLength(5);

  const refused = screen.getByRole('list', { name: '被拒绝的提高' });
  expect(within(refused).getAllByText('已拒绝')).toHaveLength(2);
  expect(within(refused).getByText('实盘 · 提高被拒绝')).toBeTruthy();
  expect(within(refused).getByText(/面容 ID \/ 触控 ID · .* · 面容 ID \/ 触控 ID 验证失败/)).toBeTruthy();
  expect(within(refused).getByText('未知账户 · 提高被拒绝')).toBeTruthy();
  expect(within(refused).getByText('请求无效，没有可识别的数值')).toBeTruthy();

  fireEvent.click(screen.getByRole('radio', { name: '实盘' }));
  expect((within(capsForm()).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('500');
  expect(within(capsForm()).getByText('已用 £0.00 · 还可买入 £2,000.00')).toBeTruthy();
  expect(screen.getByText(/当前是服务器默认值（单笔 £500\.00，每日 £2,000\.00）/)).toBeTruthy();
});
