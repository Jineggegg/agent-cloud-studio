import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

const { AuthProvider } = await import('@/modules/auth/context/AuthContext');
const { default: LoginForm } = await import('@/modules/auth/LoginForm');
await import('@/modules/i18n');

/**
 * "用面容 ID 登录" on the login screen: a challenge for this door, the device's passkey prompt,
 * then the assertion for a session stored like a password login. The suite runs in English
 * (vitest.setup.ts), so the button reads "Sign in with Face ID".
 */

const makeToken = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId: 1, username: 'andrew', iat: now, exp: now + 7 * 86400 })}.sig`;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const OPTIONS = { challenge: 'challenge-1', rpId: 'localhost', userVerification: 'required', timeout: 60000 };
const ASSERTION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } };
let requests: { url: string; body: unknown }[] = [];
let signInAnswer: () => Response;

beforeEach(() => {
  localStorage.removeItem('auth-token');
  requests = [];
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.startAuthentication.mockReset();
  signInAnswer = () => json({ success: true, user: { id: 1, username: 'andrew' }, token: makeToken() });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/auth/status') return json({ needsSetup: false });
    if (url === '/api/auth/tailscale-session') return json({ success: false, error: { code: 'AUTH_TAILSCALE_UNAVAILABLE' } }, 403);
    if (url === '/api/auth/passkey/options') return json(OPTIONS);
    if (url === '/api/auth/passkey') return signInAnswer();
    if (url === '/api/user/onboarding-status') return json({ hasCompletedOnboarding: true });
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function clickPasskeyButton() {
  const button = await screen.findByRole('button', { name: 'Sign in with Face ID' });
  await act(async () => { button.click(); });
}

test('the Face ID button signs in with the device passkey and stores the session', async () => {
  webauthn.startAuthentication.mockResolvedValue(ASSERTION);
  render(<AuthProvider><LoginForm /></AuthProvider>);
  await clickPasskeyButton();

  await waitFor(() => expect(localStorage.getItem('auth-token')).toBeTruthy());
  expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
  expect(requests.find((request) => request.url === '/api/auth/passkey')?.body).toEqual({ response: ASSERTION });
  // No username or password was sent anywhere.
  expect(requests.some((request) => request.url === '/api/auth/login')).toBe(false);
});

test('a cancelled Face ID prompt explains itself and asks the server for nothing more', async () => {
  webauthn.startAuthentication.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
  render(<AuthProvider><LoginForm /></AuthProvider>);
  await clickPasskeyButton();

  expect((await screen.findByRole('alert')).textContent).toBe('Cancelled, or the device did not finish Face ID / Touch ID');
  expect(requests.some((request) => request.url === '/api/auth/passkey')).toBe(false);
  expect(localStorage.getItem('auth-token')).toBeNull();
});

test('a refused assertion shows the server message', async () => {
  webauthn.startAuthentication.mockResolvedValue(ASSERTION);
  signInAnswer = () => json({ success: false, error: { code: 'AUTH_PASSKEY_FAILED', message: '通行密钥登录失败，请重试或改用密码登录' } }, 401);
  render(<AuthProvider><LoginForm /></AuthProvider>);
  await clickPasskeyButton();

  expect((await screen.findByRole('alert')).textContent).toBe('通行密钥登录失败，请重试或改用密码登录');
  expect(localStorage.getItem('auth-token')).toBeNull();
});

test('without WebAuthn the login screen offers only the password', async () => {
  webauthn.browserSupportsWebAuthn.mockReturnValue(false);
  render(<AuthProvider><LoginForm /></AuthProvider>);
  expect(await screen.findByRole('button', { name: 'Sign In' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sign in with Face ID' })).toBeNull();
});
