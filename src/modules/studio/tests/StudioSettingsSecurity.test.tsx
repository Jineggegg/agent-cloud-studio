import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const security = vi.hoisted(() => ({ overview: vi.fn(), passkeyOptions: vi.fn(), registerPasskey: vi.fn(), removePasskey: vi.fn(), revokeAll: vi.fn() }));
const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn(), browserSupportsWebAuthn: vi.fn(() => true) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const auth = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock('@/shared/api', () => ({
  api: { auth: { security } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error.message), { code: value.error.code });
    return value;
  },
}));
vi.mock('@simplewebauthn/browser', () => webauthn);
vi.mock('sonner', () => ({ toast }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));

const { StudioSettingsSecurity } = await import('@/modules/studio/StudioSettingsSecurity');

const ok = (value: unknown) => async () => Response.json(value);
const refused = (status: number, code: string, message: string) => async () => Response.json({ success: false, error: { code, message } }, { status });
const OTHER_DOMAIN = { id: 'k-public', rpId: 'studio.ajarche.com', label: 'iPhone', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: '2026-09-30T08:00:00Z' };
const THIS_DOMAIN = { id: 'k-here', rpId: window.location.hostname, label: 'iPad', createdAt: '2026-10-02T00:00:00Z', lastUsedAt: null };
const EVENTS = [
  { id: 3, at: '2026-10-02T09:30:00Z', type: 'account-locked', door: 'cloudflare', client: '198.51.*.*', detail: '锁定 15 分钟' },
  { id: 2, at: '2026-10-02T09:29:00Z', type: 'login-failed', door: 'cloudflare', client: '198.51.*.*', detail: 'unknown-user (login)' },
  { id: 1, at: '2026-10-02T09:00:00Z', type: 'passkey-signin', door: 'tailnet', client: '100.101.*.*', detail: 'studio.ajarche.com' },
];
const OVERVIEW = {
  passkeyOrigins: [window.location.origin, 'https://studio.ajarche.com'],
  passkeys: [OTHER_DOMAIN],
  events: EVENTS,
  passwordLock: { locked: true, lockedUntil: '2026-10-02T09:45:00Z' },
};

beforeEach(() => {
  vi.clearAllMocks();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
});
afterEach(cleanup);

test('shows the lock, the passkeys by domain and the recent events in plain words', async () => {
  security.overview.mockImplementation(ok(OVERVIEW));
  render(<StudioSettingsSecurity />);

  expect(await screen.findByText('已锁定')).toBeTruthy();
  expect(screen.getByText(/前不能用密码登录/)).toBeTruthy();
  expect(screen.getByText('studio.ajarche.com')).toBeTruthy();
  expect(screen.getByText('密码登录已锁定')).toBeTruthy();
  expect(screen.getByText('密码登录失败')).toBeTruthy();
  expect(screen.getByText(/公网 · 198\.51\.\*\.\* · 用户名不存在/)).toBeTruthy();
  expect(screen.getByText('面容 ID 登录')).toBeTruthy();
  expect(screen.getByRole('button', { name: '在这台设备启用面容 ID 登录' })).toBeTruthy();
});

test('adding a passkey for this domain needs the password first, then registers it', async () => {
  security.overview.mockImplementationOnce(ok(OVERVIEW)).mockImplementation(ok({ ...OVERVIEW, passkeys: [OTHER_DOMAIN, THIS_DOMAIN] }));
  security.passkeyOptions.mockImplementation(ok({ challenge: 'reg-1', rp: { id: window.location.hostname, name: 'Agent Cloud Studio' } }));
  security.registerPasskey.mockImplementation(ok(THIS_DOMAIN));
  const attestation = { id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: { attestationObject: 'x' } };
  webauthn.startRegistration.mockResolvedValue(attestation);
  render(<StudioSettingsSecurity />);

  const enable = await screen.findByRole('button', { name: '在这台设备启用面容 ID 登录' });
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'studio-password' } });
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(enable);

  await waitFor(() => expect(security.registerPasskey).toHaveBeenCalledWith(attestation));
  expect(security.passkeyOptions).toHaveBeenCalledWith('studio-password');
  expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'reg-1', rp: { id: window.location.hostname, name: 'Agent Cloud Studio' } } });
  expect(await screen.findByText('当前')).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith(`已在 ${window.location.hostname} 启用面容 ID 登录`);
  expect(screen.getByRole('button', { name: '在这台设备上也启用面容 ID 登录' })).toBeTruthy();
});

test('a wrong password is shown and nothing is registered', async () => {
  security.overview.mockImplementation(ok({ ...OVERVIEW, passwordLock: { locked: false, lockedUntil: null } }));
  security.passkeyOptions.mockImplementation(refused(403, 'AUTH_STEP_UP_FAILED', '密码不正确'));
  render(<StudioSettingsSecurity />);
  expect(await screen.findByText('正常')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'guess' } });
  fireEvent.click(screen.getByRole('button', { name: '在这台设备启用面容 ID 登录' }));

  expect((await screen.findByRole('alert')).textContent).toBe('密码不正确');
  expect(webauthn.startRegistration).not.toHaveBeenCalled();
  expect(security.registerPasskey).not.toHaveBeenCalled();
});

test('a page outside the configured doors cannot enrol and says why', async () => {
  security.overview.mockImplementation(ok({ ...OVERVIEW, passkeyOrigins: ['https://studio.ajarche.com'] }));
  render(<StudioSettingsSecurity />);
  expect(await screen.findByText(/当前网址不是 Studio 配置的入口/)).toBeTruthy();
  expect((screen.getByLabelText('登录密码') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '在这台设备启用面容 ID 登录' }) as HTMLButtonElement).disabled).toBe(true);
});

test('removing a passkey asks for the password in an alert', async () => {
  security.overview.mockImplementationOnce(ok(OVERVIEW)).mockImplementation(ok({ ...OVERVIEW, passkeys: [] }));
  security.removePasskey.mockImplementationOnce(refused(403, 'AUTH_STEP_UP_FAILED', '密码不正确')).mockImplementation(ok(OTHER_DOMAIN));
  render(<StudioSettingsSecurity />);
  fireEvent.click(await screen.findByRole('button', { name: '移除 studio.ajarche.com 的登录通行密钥' }));

  const alert = await screen.findByRole('alertdialog');
  const field = within(alert).getByLabelText('登录密码');
  fireEvent.change(field, { target: { value: 'guess' } });
  fireEvent.click(within(alert).getByRole('button', { name: '移除' }));
  expect((await within(alert).findByRole('alert')).textContent).toBe('密码不正确');

  fireEvent.change(field, { target: { value: 'studio-password' } });
  fireEvent.click(within(alert).getByRole('button', { name: '移除' }));
  await waitFor(() => expect(security.removePasskey).toHaveBeenLastCalledWith('k-public', 'studio-password'));
  await waitFor(() => expect(screen.queryByText('studio.ajarche.com')).toBeNull());
  expect(toast.success).toHaveBeenCalledWith('已移除 studio.ajarche.com 的登录通行密钥');
});

test('退出所有设备 asks first, revokes every session and signs this page out', async () => {
  security.overview.mockImplementation(ok(OVERVIEW));
  security.revokeAll.mockImplementation(ok({ success: true }));
  render(<StudioSettingsSecurity />);
  fireEvent.click(await screen.findByRole('button', { name: '退出所有设备' }));
  expect(security.revokeAll).not.toHaveBeenCalled();

  const confirm = await screen.findByRole('alertdialog');
  fireEvent.click(within(confirm).getByRole('button', { name: '退出所有设备' }));
  await waitFor(() => expect(security.revokeAll).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1));
  expect(toast.success).toHaveBeenCalledWith('已退出所有设备，请重新登录');
});
