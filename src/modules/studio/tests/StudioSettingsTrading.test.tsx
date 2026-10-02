import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const trading = vi.hoisted(() => ({ config: vi.fn(), passkeyOptions: vi.fn(), registerPasskey: vi.fn(), removalOptions: vi.fn(), removePasskey: vi.fn() }));
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
const CODE = 'ABCDE-FGHJK-MNPQR-STVWX';
const PROVENANCE = { aaguid: '00000000-0000-0000-0000-000000000000', credentialIdPrefix: 'Y3JlZC10YWlsbmV0', backedUp: false, multiDevice: false };
const OTHER_DOMAIN = { id: 'k-tailnet', rpId: 'desktop.tail1234.ts.net', label: 'Windows', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, ...PROVENANCE };
const THIS_DOMAIN = { id: 'k-local', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null, ...PROVENANCE };
const THIS_DOMAIN_PHONE = { ...THIS_DOMAIN, id: 'k-local-2', label: 'iPhone' };
const HEALTHY_ISOLATION = { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [], notes: [] };
const CONFIG = {
  broker: { status: 'ok', keys: { live: false, demo: true } }, allowedEnvs: ['demo'], maxOrderValue: 250, maxOrdersPerHour: 10,
  maxDailyOrderValue: 0, liveOrderCooldownSeconds: 0, currency: 'GBP',
  passkeys: [OTHER_DOMAIN], trustedOrigins: [window.location.origin], demoConfirm: false, isolation: HEALTHY_ISOLATION,
};

// Works with `screen` and with `within(alert)`, which both expose getByLabelText.
async function typeCode(scope: { getByLabelText: (text: string) => HTMLElement }, code: string) {
  const field = scope.getByLabelText('注册码') as HTMLInputElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  fireEvent.change(field, { target: { value: code } });
}

beforeEach(() => {
  vi.clearAllMocks();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.platformAuthenticatorIsAvailable.mockResolvedValue(true);
});
afterEach(cleanup);

test('shows broker status, its accounts, cap and passkeys by domain, then enrols one here with an enrollment code', async () => {
  trading.config.mockImplementationOnce(json(CONFIG)).mockImplementation(json({ ...CONFIG, passkeys: [OTHER_DOMAIN, THIS_DOMAIN] }));
  trading.passkeyOptions.mockImplementation(json({ challenge: 'reg-1', rp: { id: 'localhost', name: 'Agent Cloud Studio 交易代理' } }));
  trading.registerPasskey.mockImplementation(json(THIS_DOMAIN));
  const attestation = { id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: { attestationObject: 'x' } };
  webauthn.startRegistration.mockResolvedValue(attestation);
  render(<StudioSettingsTrading />);

  expect(await screen.findByText('已连接')).toBeTruthy();
  expect(screen.getByText('仅模拟盘')).toBeTruthy();
  expect(screen.getByText('£250.00')).toBeTruthy();
  expect(screen.getByText(/每小时最多 10 笔/)).toBeTruthy();
  expect(screen.getByRole('group', { name: 'desktop.tail1234.ts.net 的通行密钥' })).toBeTruthy();
  // Face ID exists on another domain only, so this one cannot trade until it has its own.
  expect(screen.getByText('需先启用面容 ID')).toBeTruthy();
  expect(screen.queryByLabelText('登录密码')).toBeNull();
  expect(screen.getByText(/studio-trader enroll-code/)).toBeTruthy();

  const enable = await screen.findByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await typeCode(screen, '   ');
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  await typeCode(screen, CODE);
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(enable);
  await waitFor(() => expect(trading.registerPasskey).toHaveBeenCalledWith(attestation));
  expect(trading.passkeyOptions).toHaveBeenCalledWith(CODE);
  expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'reg-1', rp: { id: 'localhost', name: 'Agent Cloud Studio 交易代理' } } });
  expect(await screen.findByText('当前')).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith(`已在 ${window.location.hostname} 启用面容 ID / 触控 ID 下单`);
  expect(screen.getByRole('button', { name: '在这台设备上也启用面容 ID / 触控 ID' })).toBeTruthy();
  expect(screen.getByText('可下单')).toBeTruthy();
});

test('the daily cap is shown per account, with what each has used and has left', async () => {
  trading.config.mockImplementation(json({
    ...CONFIG, allowedEnvs: ['live', 'demo'], maxDailyOrderValue: 2000,
    dailyOrderValue: { live: { currency: 'GBP', used: 160, remaining: 1840 }, demo: { currency: 'EUR', used: 0, remaining: 2000 } },
  }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText(/每个账户每日累计上限/)).toBeTruthy();
  const budget = screen.getByText(/实盘剩余/).textContent ?? '';
  expect(budget).toContain('实盘剩余 £1,840.00（已用 £160.00）');
  expect(budget).toContain('模拟盘剩余 €2,000.00（已用 €0.00）');
  expect(budget).toContain('分别计算');
  cleanup();

  // Without a daily cap, or without figures from the broker, no budget row is shown.
  trading.config.mockImplementation(json({ ...CONFIG, maxDailyOrderValue: 0, dailyOrderValue: { demo: { currency: 'GBP', used: 10, remaining: null } } }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('已连接')).toBeTruthy();
  expect(screen.queryByText(/剩余/)).toBeNull();
});

test('a wrong enrollment code is shown and nothing is registered', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, passkeys: [] }));
  trading.passkeyOptions.mockImplementation(json('注册码无效、已用过或已过期：请在服务器上用 studio-trader enroll-code 重新生成', 403, 'T212_ENROLL_CODE_INVALID'));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('需先启用面容 ID')).toBeTruthy();
  await typeCode(screen, 'guess');
  fireEvent.click(screen.getByRole('button', { name: '启用面容 ID / 触控 ID 下单' }));
  expect((await screen.findByRole('alert')).textContent).toContain('注册码无效');
  expect(webauthn.startRegistration).not.toHaveBeenCalled();
  expect(trading.registerPasskey).not.toHaveBeenCalled();
});

test('removing a passkey from a domain without its own passkey needs an enrollment code', async () => {
  trading.config.mockImplementationOnce(json({ ...CONFIG, passkeys: [OTHER_DOMAIN] })).mockImplementation(json({ ...CONFIG, passkeys: [] }));
  trading.removePasskey.mockImplementationOnce(json('注册码无效、已用过或已过期', 403, 'T212_ENROLL_CODE_INVALID')).mockImplementation(json({ removed: true }));
  render(<StudioSettingsTrading />);

  fireEvent.click(await screen.findByRole('button', { name: '移除 desktop.tail1234.ts.net 的通行密钥（Windows）' }));
  const alert = await screen.findByRole('alertdialog', { name: '移除 desktop.tail1234.ts.net 的通行密钥？' });
  // This domain has no passkey of its own, so Face ID cannot authorise the removal here.
  expect(within(alert).queryByRole('button', { name: /用面容 ID/ })).toBeNull();
  const remove = within(alert).getByRole('button', { name: '移除' }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);

  await typeCode(within(alert), 'guess');
  fireEvent.click(remove);
  expect((await within(alert).findByRole('alert')).textContent).toContain('注册码无效');
  expect(screen.getByRole('alertdialog')).toBeTruthy();

  await typeCode(within(alert), CODE);
  fireEvent.click(within(alert).getByRole('button', { name: '移除' }));
  await waitFor(() => expect(trading.removePasskey).toHaveBeenLastCalledWith('k-tailnet', { enrollmentCode: CODE }));
  await waitFor(() => expect(screen.queryByText('desktop.tail1234.ts.net')).toBeNull());
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(trading.removalOptions).not.toHaveBeenCalled();
});

test('any passkey of this domain can authorise a removal with Face ID; a cancelled registration explains itself', async () => {
  trading.config.mockImplementationOnce(json({ ...CONFIG, passkeys: [THIS_DOMAIN, THIS_DOMAIN_PHONE] })).mockImplementation(json({ ...CONFIG, passkeys: [] }));
  const options = { challenge: 'rm-1', allowCredentials: [{ id: 'cred-local', type: 'public-key' }, { id: 'cred-phone', type: 'public-key' }], userVerification: 'required' };
  const assertion = { id: 'cred-phone', rawId: 'cred-phone', type: 'public-key', response: { signature: 'sig' }, clientExtensionResults: {} };
  trading.removalOptions.mockImplementation(json(options));
  trading.removePasskey.mockImplementation(json({ removed: true }));
  webauthn.startAuthentication.mockResolvedValue(assertion);
  render(<StudioSettingsTrading />);

  // Both passkeys of this domain are listed in one group.
  const group = await screen.findByRole('group', { name: `${window.location.hostname} 的通行密钥` });
  expect(within(group).getAllByRole('button').length).toBe(2);
  fireEvent.click(within(group).getByRole('button', { name: `移除 ${window.location.hostname} 的通行密钥（iPad）` }));
  const alert = await screen.findByRole('alertdialog');
  fireEvent.click(within(alert).getByRole('button', { name: '用面容 ID / 触控 ID 验证' }));
  await waitFor(() => expect(trading.removePasskey).toHaveBeenCalledWith('k-local', { assertion }));
  expect(trading.removalOptions).toHaveBeenCalledWith('k-local');
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

  trading.passkeyOptions.mockImplementation(json({ challenge: 'reg-2' }));
  webauthn.startRegistration.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  const enable = await screen.findByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await typeCode(screen, CODE);
  fireEvent.click(enable);
  expect((await screen.findByRole('alert')).textContent).toContain('已取消');
  expect(trading.registerPasskey).not.toHaveBeenCalled();
});

test('an address outside the broker’s allowlist cannot enrol, and trading-off and missing keys are explained', async () => {
  trading.config.mockImplementation(json({ ...CONFIG, allowedEnvs: ['live', 'demo'], trustedOrigins: ['https://studio.ajarche.com'], passkeys: [] }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('未列入白名单')).toBeTruthy();
  expect((screen.getByRole('button', { name: '启用面容 ID / 触控 ID 下单' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('注册码') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/config\.json 的 origins/)).toBeTruthy();
  expect(screen.getByText(/交易代理还没有实盘下单密钥/)).toBeTruthy();
  cleanup();

  trading.config.mockImplementation(json({ ...CONFIG, allowedEnvs: [] }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('已关闭')).toBeTruthy();
  expect(screen.getByText('allowedEnvs')).toBeTruthy();
});

test('an invalid isolation state is surfaced as a warning on the settings page', async () => {
  trading.config.mockImplementation(json({
    ...CONFIG,
    isolation: { ok: false, interopActive: true, interopBinfmt: true, interopSocket: true, windowsDrives: ['/mnt/c'], notes: ['WSL 互操作仍然开着：可以运行 wsl.exe -u root 读出下单密钥。'] },
  }));
  render(<StudioSettingsTrading />);
  const badges = await screen.findAllByText('隔离无效');
  // Both the row heading and its status badge read 隔离无效; the note explains why.
  expect(badges.length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText(/wsl\.exe -u root/)).toBeTruthy();
});

test('without the broker, Settings says how to install it and offers no enrollment', async () => {
  trading.config.mockImplementation(json({
    broker: { status: 'off', message: 'Studio 没有连接交易代理（STUDIO_T212_BROKER_SOCKET 未设置），下单已关闭。' },
    allowedEnvs: [], maxOrderValue: 0, maxOrdersPerHour: 0, passkeys: [], trustedOrigins: [], demoConfirm: false,
  }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('未安装')).toBeTruthy();
  expect(screen.getByText(/STUDIO_T212_BROKER_SOCKET 未设置/)).toBeTruthy();
  expect(screen.getByText('docs/t212-broker.md')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /启用面容 ID/ })).toBeNull();
  cleanup();

  trading.config.mockImplementation(json({
    broker: { status: 'unreachable', message: '交易代理没有运行：在服务器上检查 systemctl status studio-trader-broker' },
    allowedEnvs: [], maxOrderValue: 0, maxOrdersPerHour: 0, passkeys: [], trustedOrigins: [], demoConfirm: false,
  }));
  render(<StudioSettingsTrading />);
  expect(await screen.findByText('无法连接')).toBeTruthy();
  expect(screen.getByText(/systemctl status studio-trader-broker/)).toBeTruthy();
});
