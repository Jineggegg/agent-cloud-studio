import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const trading = vi.hoisted(() => ({
  config: vi.fn(), passkeyOptions: vi.fn(), registerPasskey: vi.fn(), removalOptions: vi.fn(), removePasskey: vi.fn(),
  capsChallenge: vi.fn(), updateCaps: vi.fn(), modeChallenge: vi.fn(), updateMode: vi.fn(),
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
const onOpenLog = vi.fn();
// The Trading 212 settings page as Settings shows it; its records are one level further in.
const renderTrading = () => render(<StudioSettingsTrading onOpenLog={onOpenLog} />);

const json = (value: unknown, status = 200, code?: string) => async () => Response.json(status === 200 ? value : { error: value, code }, { status });
const OTHER_DOMAIN = { id: 'k-tailnet', rpId: 'desktop.tail1234.ts.net', label: 'Windows', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null };
const THIS_DOMAIN = { id: 'k-local', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null };
const accountCaps = (maxOrderValue: number, dailyLimit: number, dailyUsed = 0, custom = false) => ({
  maxOrderValue, dailyLimit, custom, updatedAt: custom ? '2026-10-02T08:00:00Z' : null, dailyUsed, dailyRemaining: dailyLimit - dailyUsed, currency: 'GBP',
});
const CAPS = { ceiling: 10_000, defaults: { maxOrderValue: 500, dailyLimit: 2000 }, envs: { live: accountCaps(500, 2000), demo: accountCaps(250, 1000, 160, true) } };
// The trading mode as GET /trading reports it: in force, and the STUDIO_T212_TRADING ceiling.
const modeState = (mode: string, ceiling = mode, custom = false) => ({ mode, ceiling, custom, updatedAt: custom ? '2026-10-02T08:00:00Z' : null });
const CONFIG = {
  allowedEnvs: ['demo'], tradingMode: modeState('demo'), modeChanges: [] as unknown[], modeRefusals: [] as unknown[], stepUpRequests: [] as unknown[],
  caps: CAPS, capChanges: [] as unknown[], capRefusals: [] as unknown[], currency: 'GBP', passkeys: [OTHER_DOMAIN],
  trustedOrigins: [], allowLocalhost: true, requirePasskey: false,
};
// With STUDIO_T212_TRADING=both: every option is within the ceiling.
const BOTH = { ...CONFIG, allowedEnvs: ['live', 'demo'], tradingMode: modeState('both') };
const modeChange = (id: number, change: Record<string, unknown> = {}) => ({
  id, direction: 'narrow', method: 'session', status: 'applied', from: 'both', to: 'off', reason: null, origin: null, createdAt: '2026-10-02T08:00:00Z', ...change,
});
// The trading-mode selector's options, apart from the caps editor's own account switch.
const modeOption = async (name: string) => within(await screen.findByRole('radiogroup', { name: '允许下单的账户' })).getByRole('radio', { name });
const modeOptions = () => within(screen.getByRole('radiogroup', { name: '允许下单的账户' })).getAllByRole('radio') as HTMLButtonElement[];
const capsAccount = (name: string) => within(screen.getByRole('radiogroup', { name: '上限所属账户' })).getByRole('radio', { name });
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
  renderTrading();

  expect((await modeOption('模拟盘')).getAttribute('aria-checked')).toBe('true');
  // The caps editor opens on the account that may trade, with its saved caps.
  expect((within(capsForm()).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('250');
  expect((within(capsForm()).getByLabelText('每日上限') as HTMLInputElement).value).toBe('1000');
  // Each passkey's domain and device; when it was enabled or last used is on 变更日志.
  const passkeys = screen.getByRole('group', { name: '已启用通行密钥的网址' });
  expect(within(passkeys).getByText('desktop.tail1234.ts.net')).toBeTruthy();
  expect(within(passkeys).getByText('Windows')).toBeTruthy();
  // Face ID exists on another domain, so this one cannot trade until it has its own: the badge says so.
  expect(screen.getByText('需先启用面容 ID')).toBeTruthy();
  // No small print: no explanations, no live usage, no server configuration.
  expect(screen.queryByText(/你已在其他网址启用了面容 ID/)).toBeNull();
  expect(screen.queryByText(/还没有任何通行密钥时/)).toBeNull();
  expect(screen.queryByText(/过去 24 小时买入|已用 £160\.00/)).toBeNull();
  expect(screen.queryByText(/服务器硬上限|STUDIO_T212_|密钥文件/)).toBeNull();

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
  renderTrading();
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
  renderTrading();

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
  renderTrading();

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

test('an untrusted address cannot enable Face ID and says where to fix it; trading off on the server just disables the options', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, allowedEnvs: [], tradingMode: modeState('off'), allowLocalhost: false, passkeys: [] }));
  renderTrading();
  expect((await modeOption('关闭')).getAttribute('aria-checked')).toBe('true');
  expect(modeOptions().map(option => option.disabled)).toEqual([false, true, true, true]);
  expect(screen.queryByText(/STUDIO_T212_TRADING|不可选/)).toBeNull();
  expect(screen.getByText('未列入白名单')).toBeTruthy();
  expect((screen.getByRole('button', { name: '启用面容 ID / 触控 ID 下单' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('登录密码') as HTMLInputElement).disabled).toBe(true);
  // The one warning kept: it needs action on the server.
  expect(screen.getByText(/STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN/)).toBeTruthy();
});

test('with STUDIO_T212_REQUIRE_PASSKEY the domain needs its own passkey even before any exists', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [], requirePasskey: true }));
  renderTrading();
  expect(await screen.findByText('需先启用面容 ID')).toBeTruthy();
  expect(screen.queryByText(/STUDIO_T212_REQUIRE_PASSKEY/)).toBeNull();
});

test('every record is one row away on 变更日志; none of them is listed here', async () => {
  const who = { session: 'owner-se', currentSession: true, client: 'Tailscale 100.64.*.*' };
  trading.config.mockImplementation(json({
    ...CONFIG, passkeys: [{ ...THIS_DOMAIN, lastUsedAt: '2026-10-02T09:00:00Z' }],
    capChanges: [capChange(1)], capRefusals: [capChange(2, { direction: 'raise', status: 'refused', reason: '面容 ID / 触控 ID 验证失败' })],
    modeChanges: [modeChange(1)], modeRefusals: [modeChange(2, { direction: 'widen', status: 'refused' })],
    stepUpRequests: [{ id: 'caps-1', kind: 'caps', env: 'demo', to: { maxOrderValue: 900, dailyLimit: 2000 }, outcome: 'used', origin: null, createdAt: '2026-10-02T09:00:00Z', ...who }],
  }));
  renderTrading();
  await screen.findByRole('form', { name: '下单上限' });
  expect(screen.queryAllByRole('list')).toHaveLength(0);
  expect(screen.queryByText(/变更记录|被拒绝|验证请求|用过|启用$/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '变更日志' }));
  expect(onOpenLog).toHaveBeenCalledTimes(1);
});

test('lowering a cap is saved with the session alone and toasted; the form starts from the saved values', async () => {
  const lowered = { ...CONFIG, caps: { ...CAPS, envs: { ...CAPS.envs, demo: accountCaps(200, 1000, 160, true) } }, capChanges: [capChange(1, { from: { maxOrderValue: 250, dailyLimit: 1000 }, to: { maxOrderValue: 200, dailyLimit: 1000 } })] };
  trading.config.mockImplementationOnce(json(CONFIG)).mockImplementation(json(lowered));
  trading.updateCaps.mockImplementation(json({ env: 'demo', direction: 'lower', method: 'session' }));
  renderTrading();

  const form = await typeCaps('200');
  const save = within(form).getByRole('button', { name: '降低上限' });
  fireEvent.click(save);
  await waitFor(() => expect(trading.updateCaps).toHaveBeenCalledWith({ env: 'demo', maxOrderValue: 200, dailyLimit: 1000 }));
  expect(trading.updateCaps.mock.calls[0]).toHaveLength(1);
  expect(trading.capsChallenge).not.toHaveBeenCalled();
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已降低模拟盘上限', { description: '单笔 £200.00 · 每日 £1,000.00' }));

  // The form now starts from the saved values, so nothing is left to save; the change itself is on 变更日志.
  await waitFor(() => expect((within(capsForm()).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('200'));
  expect(screen.queryByRole('list', { name: '上限变更记录' })).toBeNull();
  expect((within(capsForm()).getByRole('button', { name: '保存上限' }) as HTMLButtonElement).disabled).toBe(true);
});

test('raising asks for a challenge bound to the new values and signs it with Face ID on this domain', async () => {
  const withPasskey = { ...CONFIG, passkeys: [THIS_DOMAIN] };
  trading.config.mockImplementation(json(withPasskey));
  const authentication = { challenge: 'bound-challenge', rpId: window.location.hostname, allowCredentials: [{ id: 'cred-local', type: 'public-key' }], userVerification: 'required' };
  const assertion = { id: 'cred-local', rawId: 'cred-local', type: 'public-key', response: { signature: 'sig' }, clientExtensionResults: {} };
  trading.capsChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '2026-10-02T10:01:00Z', authentication, env: 'demo', from: { maxOrderValue: 250, dailyLimit: 1000 }, to: { maxOrderValue: 400, dailyLimit: 900 } }));
  trading.updateCaps.mockImplementation(json({ env: 'demo', direction: 'raise', method: 'passkey' }));
  webauthn.startAuthentication.mockResolvedValue(assertion);
  renderTrading();

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
  expect((capsAccount('实盘') as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(within(review).getByRole('button', { name: '用面容 ID / 触控 ID 确认' }));
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: authentication });
  await waitFor(() => expect(trading.updateCaps).toHaveBeenCalledWith(input, { challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', assertion }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已用面容 ID / 触控 ID 提高模拟盘上限', { description: '单笔 £400.00 · 每日 £900.00' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(trading.config).toHaveBeenCalledTimes(2);
  expect((capsAccount('实盘') as HTMLButtonElement).disabled).toBe(false);
});

test('cancelling the review sends nothing to Face ID and unlocks the editor', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  trading.capsChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' }, env: 'demo', from: { maxOrderValue: 250, dailyLimit: 1000 }, to: { maxOrderValue: 400, dailyLimit: 1000 } }));
  renderTrading();
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
  renderTrading();
  const form = await typeCaps('400');
  fireEvent.click(within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }));
  expect((await screen.findByRole('alert')).textContent).toContain('次数过多');
  expect(toast.error).toHaveBeenCalledWith('上限没有提高', { description: expect.stringContaining('42 分钟') });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect((within(form).getByLabelText('单笔上限') as HTMLInputElement).disabled).toBe(false);
});

test('without a passkey caps cannot be raised and the editor says to enable Face ID first; lowering still works', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [] }));
  renderTrading();
  const form = await typeCaps('300');
  expect((within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/提高上限需要面容 ID \/ 触控 ID：请先在上方启用/)).toBeTruthy();
  fireEvent.change(within(form).getByLabelText('单笔上限'), { target: { value: '100' } });
  expect((within(form).getByRole('button', { name: '降低上限' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText(/请先在上方启用/)).toBeNull();
  cleanup();

  // A passkey on another domain does not let this one raise.
  trading.config.mockImplementation(json(CONFIG));
  renderTrading();
  const other = await typeCaps('300');
  expect((within(other).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(new RegExp(`请先在上方为 ${window.location.hostname} 启用，或到 desktop\\.tail1234\\.ts\\.net 操作`))).toBeTruthy();
  expect(trading.capsChallenge).not.toHaveBeenCalled();
});

test('values are checked against the ceiling, each other and two decimals before anything is sent', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  renderTrading();
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
  // The ceiling is only mentioned when a value goes over it.
  expect(screen.queryByText(/服务器硬上限/)).toBeNull();
  expect(trading.capsChallenge).not.toHaveBeenCalled();
  expect(trading.updateCaps).not.toHaveBeenCalled();
});

test('a cancelled Face ID changes nothing quietly; a server refusal is shown and toasted', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  trading.capsChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' }, env: 'demo', from: { maxOrderValue: 250, dailyLimit: 1000 }, to: { maxOrderValue: 400, dailyLimit: 1000 } }));
  webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  renderTrading();
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

test('the editor switches accounts and shows each account’s saved caps', async () => {
  trading.config.mockImplementation(json(CONFIG));
  renderTrading();
  expect(await screen.findByRole('form', { name: '下单上限' })).toBeTruthy();
  expect((within(capsForm()).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('250');
  fireEvent.click(capsAccount('实盘'));
  expect((within(capsForm()).getByLabelText('单笔上限') as HTMLInputElement).value).toBe('500');
  expect((within(capsForm()).getByLabelText('每日上限') as HTMLInputElement).value).toBe('2000');
  // Whether these are the server defaults is not spelled out any more.
  expect(screen.queryByText(/服务器默认值/)).toBeNull();
});

test('the trading mode in force is selected; options outside STUDIO_T212_TRADING are disabled with the server’s reason', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  renderTrading();
  expect((await modeOption('模拟盘')).getAttribute('aria-checked')).toBe('true');
  expect(modeOptions().map(option => [option.textContent, option.disabled])).toEqual([
    ['关闭', false], ['模拟盘', false], ['实盘', true], ['实盘+模拟盘', true],
  ]);
  expect((await modeOption('实盘')).title).toBe('服务器未开启实盘下单');
  // No standing note about the server's setting under the selector.
  expect(screen.queryByText(/STUDIO_T212_TRADING|服务器上限|不可选/)).toBeNull();
  fireEvent.click(await modeOption('实盘'));
  expect(trading.modeChallenge).not.toHaveBeenCalled();
  expect(trading.updateMode).not.toHaveBeenCalled();
});

test('narrowing saves at once with the session, locks the selector meanwhile and is toasted', async () => {
  const narrowed = { ...BOTH, allowedEnvs: ['demo'], tradingMode: modeState('demo', 'both', true), modeChanges: [modeChange(1, { to: 'demo' })] };
  trading.config.mockImplementationOnce(json({ ...BOTH, passkeys: [] })).mockImplementation(json({ ...narrowed, passkeys: [] }));
  let finish!: () => void;
  trading.updateMode.mockImplementation(() => new Promise<Response>(resolve => { finish = () => resolve(Response.json({ mode: 'demo', direction: 'narrow', method: 'session' })); }));
  renderTrading();
  expect((await modeOption('实盘+模拟盘')).getAttribute('aria-checked')).toBe('true');
  // Without any passkey nothing is widened, but every narrowing is available.
  expect(modeOptions().every(option => !option.disabled)).toBe(true);

  fireEvent.click(await modeOption('模拟盘'));
  await waitFor(() => expect(trading.updateMode).toHaveBeenCalledWith('demo'));
  expect(trading.updateMode.mock.calls[0]).toHaveLength(1);
  expect(trading.modeChallenge).not.toHaveBeenCalled();
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  // One change at a time: every option is disabled until the save settles.
  expect(modeOptions().every(option => option.disabled)).toBe(true);
  finish();

  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已关闭实盘下单', { description: '允许下单的账户：模拟盘' }));
  await waitFor(() => expect(modeOptions()[1].getAttribute('aria-checked')).toBe('true'));
  // Adding live back now needs Face ID, which this domain has not enabled.
  expect(modeOptions().map(option => option.disabled)).toEqual([false, false, true, true]);
  expect(screen.getByText(/启用面容 ID 后才能开启：请先在下方启用面容 ID \/ 触控 ID/)).toBeTruthy();
  expect(screen.queryByRole('list', { name: '下单账户变更记录' })).toBeNull();
});

test('turning trading off is one tap; a refused narrowing is shown and toasted', async () => {
  trading.config.mockImplementation(json({ ...BOTH, passkeys: [] }));
  trading.updateMode.mockImplementationOnce(json('交易模式没有保存：数据库暂时不可用', 500)).mockImplementation(json({ mode: 'off', direction: 'narrow', method: 'session' }));
  renderTrading();
  fireEvent.click(await modeOption('关闭'));
  expect((await screen.findByRole('alert')).textContent).toBe('交易模式没有保存：数据库暂时不可用');
  expect(toast.error).toHaveBeenCalledWith('交易模式没有保存', { description: '交易模式没有保存：数据库暂时不可用' });
  fireEvent.click(await modeOption('关闭'));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已关闭下单', { description: '允许下单的账户：关闭' }));
  expect(trading.updateMode).toHaveBeenLastCalledWith('off');
});

test('without a passkey on this domain, adding an account is disabled: 启用面容 ID 后才能开启', async () => {
  trading.config.mockImplementation(json({ ...BOTH, allowedEnvs: [], tradingMode: modeState('off', 'both', true), passkeys: [OTHER_DOMAIN] }));
  renderTrading();
  expect((await modeOption('关闭')).getAttribute('aria-checked')).toBe('true');
  expect(modeOptions().map(option => option.disabled)).toEqual([false, true, true, true]);
  expect(screen.getByText(new RegExp(`启用面容 ID 后才能开启：请先在下方为 ${window.location.hostname} 启用，或到 desktop\\.tail1234\\.ts\\.net 操作`))).toBeTruthy();
  expect(trading.modeChallenge).not.toHaveBeenCalled();
});

test('adding an account shows from → to for review, then signs the challenge bound to that mode with Face ID', async () => {
  const widened = { ...BOTH, passkeys: [THIS_DOMAIN], tradingMode: modeState('both', 'both', true), modeChanges: [modeChange(2, { direction: 'widen', method: 'passkey', from: 'demo', to: 'both' })] };
  trading.config.mockImplementationOnce(json({ ...BOTH, allowedEnvs: ['demo'], tradingMode: modeState('demo', 'both', true), passkeys: [THIS_DOMAIN] }))
    .mockImplementation(json(widened));
  const authentication = { challenge: 'bound-mode', rpId: window.location.hostname, allowCredentials: [{ id: 'cred-local', type: 'public-key' }], userVerification: 'required' };
  const assertion = { id: 'cred-local', rawId: 'cred-local', type: 'public-key', response: { signature: 'sig' }, clientExtensionResults: {} };
  trading.modeChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '2026-10-02T10:01:00Z', authentication, from: 'demo', to: 'both', adds: ['live'], ceiling: 'both' }));
  trading.updateMode.mockImplementation(json({ mode: 'both', direction: 'widen', method: 'passkey' }));
  webauthn.startAuthentication.mockResolvedValue(assertion);
  renderTrading();

  fireEvent.click(await modeOption('实盘+模拟盘'));
  const review = await screen.findByRole('alertdialog', { name: '开启实盘下单？' });
  expect(trading.modeChallenge).toHaveBeenCalledWith('both');
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  expect(within(review).getByText('模拟盘 → 实盘+模拟盘')).toBeTruthy();
  expect(within(review).getByText('实盘')).toBeTruthy();
  expect(within(review).getByText(/实盘使用真实资金/)).toBeTruthy();
  // The selector is locked while the review is open.
  expect(modeOptions().every(option => option.disabled)).toBe(true);

  fireEvent.click(within(review).getByRole('button', { name: '用面容 ID / 触控 ID 确认' }));
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: authentication });
  await waitFor(() => expect(trading.updateMode).toHaveBeenCalledWith('both', { challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', assertion }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已用面容 ID / 触控 ID 开启实盘下单', { description: '允许下单的账户：实盘+模拟盘' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(modeOptions()[3].getAttribute('aria-checked')).toBe('true'));
  expect(modeOptions().every(option => !option.disabled)).toBe(true);
});

test('a cancelled review or Face ID changes nothing quietly; a server refusal is shown and toasted', async () => {
  trading.config.mockImplementation(json({ ...BOTH, allowedEnvs: [], tradingMode: modeState('off', 'both', true), passkeys: [THIS_DOMAIN] }));
  trading.modeChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' }, from: 'off', to: 'demo', adds: ['demo'], ceiling: 'both' }));
  renderTrading();

  fireEvent.click(await modeOption('模拟盘'));
  let review = await screen.findByRole('alertdialog', { name: '开启模拟盘下单？' });
  expect(within(review).queryByText(/真实资金/)).toBeNull();
  fireEvent.click(within(review).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  expect(trading.updateMode).not.toHaveBeenCalled();
  expect(modeOptions().every(option => !option.disabled)).toBe(true);

  webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  fireEvent.click(await modeOption('模拟盘'));
  review = await screen.findByRole('alertdialog');
  fireEvent.click(within(review).getByRole('button', { name: '用面容 ID / 触控 ID 确认' }));
  expect((await screen.findByRole('alert')).textContent).toBe('已取消面容 ID / 触控 ID 验证，交易模式没有改变');
  expect(trading.updateMode).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();

  webauthn.startAuthentication.mockResolvedValue({ id: 'cred-local', rawId: 'cred-local', response: { signature: 'sig' } });
  trading.updateMode.mockImplementation(json('提交的交易模式和面容 ID 验证时的不一致，没有保存', 403, 'T212_MODE_TAMPERED'));
  fireEvent.click(await modeOption('模拟盘'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '用面容 ID / 触控 ID 确认' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('没有开启下单', { description: '提交的交易模式和面容 ID 验证时的不一致，没有保存' }));
  expect(screen.getByRole('alert').textContent).toBe('提交的交易模式和面容 ID 验证时的不一致，没有保存');
  expect(toast.success).not.toHaveBeenCalled();
  expect((await modeOption('关闭')).getAttribute('aria-checked')).toBe('true');
});

test('a refused challenge (rate limit) is toasted without a review', async () => {
  trading.config.mockImplementation(json({ ...BOTH, allowedEnvs: [], tradingMode: modeState('off', 'both', true), passkeys: [THIS_DOMAIN] }));
  trading.modeChallenge.mockImplementation(json('一小时内发起开启下单的次数过多，请约 42 分钟后再试；关闭或减少账户不受影响', 429, 'T212_MODE_RATE_LIMITED'));
  renderTrading();
  fireEvent.click(await modeOption('实盘'));
  expect((await screen.findByRole('alert')).textContent).toContain('次数过多');
  expect(toast.error).toHaveBeenCalledWith('没有开启下单', { description: expect.stringContaining('42 分钟') });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(modeOptions().every(option => !option.disabled)).toBe(true);
});

test('the widening review shows the server’s state from the challenge, not this page’s possibly stale copy', async () => {
  // This page still believes demo is in force; the server says another tab turned trading off meanwhile.
  trading.config.mockImplementation(json({ ...BOTH, allowedEnvs: ['demo'], tradingMode: modeState('demo', 'both', true), passkeys: [THIS_DOMAIN] }));
  trading.modeChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' }, from: 'off', to: 'both', adds: ['live', 'demo'], ceiling: 'both' }));
  renderTrading();
  fireEvent.click(await modeOption('实盘+模拟盘'));
  const review = await screen.findByRole('alertdialog', { name: '开启实盘和模拟盘下单？' });
  expect(within(review).getByText('关闭 → 实盘+模拟盘')).toBeTruthy();
  expect(within(review).getByText('实盘和模拟盘')).toBeTruthy();
  expect(within(review).queryByText('模拟盘 → 实盘+模拟盘')).toBeNull();
});

test('the raise review shows the server’s caps from the challenge, not this page’s possibly stale copy', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [THIS_DOMAIN] }));
  trading.capsChallenge.mockImplementation(json({
    challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' },
    env: 'demo', from: { maxOrderValue: 300, dailyLimit: 1200 }, to: { maxOrderValue: 400, dailyLimit: 1000 },
  }));
  renderTrading();
  const form = await typeCaps('400');
  fireEvent.click(within(form).getByRole('button', { name: '用面容 ID / 触控 ID 提高上限' }));
  const review = await screen.findByRole('alertdialog', { name: '提高模拟盘上限？' });
  // The page showed £250 / £1,000; the server's caps were already £300 / £1,200.
  expect(within(review).getByText('£300.00 → £400.00')).toBeTruthy();
  expect(within(review).getByText('£1,200.00 → £1,000.00')).toBeTruthy();
});

test('a stale or other trading-mode refusal re-reads the settings so the selector shows the state in force', async () => {
  trading.config
    .mockImplementationOnce(json({ ...BOTH, allowedEnvs: ['demo'], tradingMode: modeState('demo', 'both', true), passkeys: [THIS_DOMAIN] }))
    .mockImplementation(json({ ...BOTH, allowedEnvs: [], tradingMode: modeState('off', 'both', true), passkeys: [THIS_DOMAIN] }));
  trading.modeChallenge.mockImplementation(json({ challengeId: '0b7c6f1e-1d2a-4c55-9f0e-6a1b2c3d4e5f', expiresAt: '', authentication: { challenge: 'c' }, from: 'demo', to: 'both', adds: ['live'], ceiling: 'both' }));
  trading.updateMode.mockImplementation(json('核对之后交易模式已经改过，这次验证作废，没有开启：请重新选择', 409, 'T212_MODE_STALE'));
  webauthn.startAuthentication.mockResolvedValue({ id: 'cred-local', rawId: 'cred-local', response: { signature: 'sig' } });
  renderTrading();
  fireEvent.click(await modeOption('实盘+模拟盘'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '用面容 ID / 触控 ID 确认' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('没有开启下单', { description: expect.stringContaining('作废') }));
  await waitFor(() => expect(trading.config).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(modeOptions()[0].getAttribute('aria-checked')).toBe('true'));
});
