import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import '@/modules/i18n';

/**
 * Auth routes answer errors as AppError bodies ({ success: false, error: { code, message } }). The
 * login form must show the server's message as text, e.g. the throttle's "try again in 10
 * minutes", instead of handing the error object to React.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let loginAnswer: Response;
let loginResult: { success: boolean; error?: string } | null = null;

beforeEach(() => {
  localStorage.clear();
  loginResult = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/auth/status') return json({ needsSetup: false });
    if (url === '/api/auth/tailscale-session') return json({ success: false, error: { code: 'AUTH_TAILSCALE_UNAVAILABLE' } }, 403);
    if (url === '/api/auth/login') return loginAnswer;
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function LoginProbe() {
  const { isLoading, login, error } = useAuth();
  if (isLoading) return <div>loading</div>;
  return <div>
    <button type="button" onClick={() => { void login('andrew', 'guess').then(result => { loginResult = result; }); }}>log in</button>
    <p data-testid="error">{error}</p>
  </div>;
}

test('a throttled login shows the server message as text', async () => {
  loginAnswer = json({ success: false, error: { code: 'AUTH_RATE_LIMITED', message: '登录失败次数过多，请 10 分钟后再试' } }, 429);
  render(<AuthProvider><LoginProbe /></AuthProvider>);
  const button = await screen.findByRole('button', { name: 'log in' });
  await act(async () => { button.click(); });

  await waitFor(() => expect(loginResult).not.toBeNull());
  expect(loginResult).toEqual({ success: false, error: '登录失败次数过多，请 10 分钟后再试' });
  expect(screen.getByTestId('error').textContent).toBe('登录失败次数过多，请 10 分钟后再试');
});

test('a plain string error and an empty body still give a string', async () => {
  loginAnswer = json({ error: 'Invalid username or password' }, 401);
  render(<AuthProvider><LoginProbe /></AuthProvider>);
  const loginButton = await screen.findByRole('button', { name: 'log in' });
  await act(async () => { loginButton.click(); });
  await waitFor(() => expect(loginResult).toEqual({ success: false, error: 'Invalid username or password' }));

  cleanup();
  loginResult = null;
  loginAnswer = json({ success: false, error: { code: 'AUTH_INVALID_CREDENTIALS' } }, 401);
  render(<AuthProvider><LoginProbe /></AuthProvider>);
  const secondButton = await screen.findByRole('button', { name: 'log in' });
  await act(async () => { secondButton.click(); });
  await waitFor(() => expect(loginResult).not.toBeNull());
  // Re-read through a cast: TypeScript still narrows the module variable to the null set above.
  const settled = loginResult as { success: boolean; error?: string } | null;
  expect(typeof settled?.error).toBe('string');
  expect(settled?.error).not.toBe('');
});
