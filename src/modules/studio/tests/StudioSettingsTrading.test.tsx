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
const OTHER_DOMAIN = { id: 'k-tailnet', rpId: 'desktop.tail1234.ts.net', label: 'Windows', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null };
const THIS_DOMAIN = { id: 'k-local', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null };
const CONFIG = { allowedEnvs: ['demo'], maxOrderValue: 250, currency: 'GBP', passkeys: [OTHER_DOMAIN], trustedOrigins: [], allowLocalhost: true, requirePasskey: false };

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
  expect(screen.getByText('£250.00')).toBeTruthy();
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
