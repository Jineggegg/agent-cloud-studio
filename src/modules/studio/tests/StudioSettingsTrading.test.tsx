import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const trading = vi.hoisted(() => ({ config: vi.fn(), passkeyOptions: vi.fn(), registerPasskey: vi.fn(), removePasskey: vi.fn() }));
const webauthn = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
  platformAuthenticatorIsAvailable: vi.fn(async () => true),
}));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { studio: { t212Trading: trading } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));
vi.mock('@simplewebauthn/browser', () => webauthn);
vi.mock('sonner', () => ({ toast }));

const { StudioSettingsTrading } = await import('@/modules/studio/StudioSettingsTrading');

const json = (value: unknown) => async () => Response.json(value);
const OTHER_DOMAIN = { id: 'k-tailnet', rpId: 'desktop.tail1234.ts.net', label: 'Windows', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null };
const THIS_DOMAIN = { id: 'k-local', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null };
const CONFIG = { allowedEnvs: ['demo'], maxOrderValue: 250, currency: 'GBP', passkeys: [OTHER_DOMAIN], trustedOrigins: [], allowLocalhost: true };

beforeEach(() => {
  vi.clearAllMocks();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.platformAuthenticatorIsAvailable.mockResolvedValue(true);
});
afterEach(cleanup);

test('shows the allowed accounts, the cap and passkeys by domain, then registers one for this domain', async () => {
  trading.config.mockImplementationOnce(json(CONFIG)).mockImplementation(json({ ...CONFIG, passkeys: [OTHER_DOMAIN, THIS_DOMAIN] }));
  trading.passkeyOptions.mockImplementation(json({ challenge: 'reg-1', rp: { id: 'localhost', name: 'Agent Cloud Studio' } }));
  trading.registerPasskey.mockImplementation(json(THIS_DOMAIN));
  const attestation = { id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: { attestationObject: 'x' } };
  webauthn.startRegistration.mockResolvedValue(attestation);
  render(<StudioSettingsTrading />);

  expect(await screen.findByText('仅模拟盘')).toBeTruthy();
  expect(screen.getByText('£250.00')).toBeTruthy();
  expect(screen.getByText('可下单')).toBeTruthy();
  expect(screen.getByText('desktop.tail1234.ts.net')).toBeTruthy();
  expect(screen.getByText(/每笔订单都需要二次确认/)).toBeTruthy();

  const enable = await screen.findByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(enable);
  await waitFor(() => expect(trading.registerPasskey).toHaveBeenCalledWith(attestation));
  expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'reg-1', rp: { id: 'localhost', name: 'Agent Cloud Studio' } } });
  expect(await screen.findByText('当前')).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith(`已在 ${window.location.hostname} 启用面容 ID / 触控 ID 下单`);
  expect(screen.getByRole('button', { name: '在这台设备上也启用面容 ID / 触控 ID' })).toBeTruthy();
});

test('removing a passkey asks first; a cancelled registration explains itself', async () => {
  trading.config.mockImplementationOnce(json({ ...CONFIG, passkeys: [OTHER_DOMAIN] })).mockImplementation(json({ ...CONFIG, passkeys: [] }));
  trading.removePasskey.mockImplementation(json({ removed: true }));
  trading.passkeyOptions.mockImplementation(json({ challenge: 'reg-2' }));
  webauthn.startRegistration.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  render(<StudioSettingsTrading />);

  fireEvent.click(await screen.findByRole('button', { name: '移除 desktop.tail1234.ts.net 的通行密钥' }));
  const alert = await screen.findByRole('alertdialog', { name: '移除 desktop.tail1234.ts.net 的通行密钥？' });
  fireEvent.click(within(alert).getByRole('button', { name: '移除' }));
  await waitFor(() => expect(trading.removePasskey).toHaveBeenCalledWith('k-tailnet'));
  await waitFor(() => expect(screen.queryByText('desktop.tail1234.ts.net')).toBeNull());

  const enable = screen.getByRole('button', { name: '启用面容 ID / 触控 ID 下单' });
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
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
  expect(screen.getByText(/STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN/)).toBeTruthy();
  expect(screen.getByText('STUDIO_T212_TRADING=demo')).toBeTruthy();
});
