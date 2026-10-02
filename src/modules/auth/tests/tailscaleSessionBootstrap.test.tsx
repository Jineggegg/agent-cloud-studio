import assert from 'node:assert/strict';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import '@/modules/i18n';

/**
 * On boot without a usable token, the app asks the server once whether this
 * device's Tailscale identity may sign in without a password. Success stores
 * the token exactly like a password login; any refusal, error or slow answer
 * shows the ordinary login form without an error message.
 */

const makeToken = (issuedAtSeconds: number) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { userId: 1, username: 'andrew', iat: issuedAtSeconds, exp: issuedAtSeconds + 7 * 86400 };
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig${issuedAtSeconds}`;
};

const TAILSCALE_PATH = '/api/auth/tailscale-session';
const tailscaleToken = makeToken(Math.floor(Date.now() / 1000));

type TailscaleBehaviour = 'grant' | 'refuse' | 'hang';

let requestedPaths: string[] = [];
let tailscaleBehaviour: TailscaleBehaviour = 'grant';
let needsSetup = false;
let storedTokenValid = true;
let loginScreens = 0;
let seenError: string | null = null;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const stubServer = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requestedPaths.push(url);
    if (url === '/api/auth/status') {
      return json({ needsSetup });
    }
    if (url === TAILSCALE_PATH) {
      assert.equal(init?.method, 'POST');
      if (tailscaleBehaviour === 'hang') {
        return new Promise<Response>(() => undefined);
      }
      return tailscaleBehaviour === 'grant'
        ? json({ success: true, user: { id: 1, username: 'andrew' }, token: tailscaleToken })
        : json({ success: false, error: { code: 'AUTH_TAILSCALE_UNAVAILABLE' } }, 403);
    }
    if (url === '/api/auth/user') {
      return storedTokenValid
        ? json({ user: { id: 1, username: 'andrew' } })
        : json({ error: 'Invalid token' }, 401, { 'X-Auth-Error': 'invalid-token' });
    }
    if (url === '/api/user/onboarding-status') {
      return json({ hasCompletedOnboarding: true });
    }
    return json({});
  }));
};

function LoginScreen() {
  useEffect(() => {
    loginScreens += 1;
  }, []);
  return <div>login</div>;
}

function Gate() {
  const { isLoading, user, error } = useAuth();
  useEffect(() => {
    seenError = error;
  }, [error]);
  if (isLoading) {
    return <div>loading</div>;
  }
  return user ? <div>workspace {user.username}</div> : <LoginScreen />;
}

// StrictMode runs the bootstrap effect twice, as the real app does in development.
const renderApp = () => render(
  <StrictMode>
    <AuthProvider>
      <Gate />
    </AuthProvider>
  </StrictMode>,
);

const tailscaleCalls = () => requestedPaths.filter((path) => path === TAILSCALE_PATH).length;

beforeEach(() => {
  localStorage.clear();
  requestedPaths = [];
  tailscaleBehaviour = 'grant';
  needsSetup = false;
  storedTokenValid = true;
  loginScreens = 0;
  seenError = null;
  stubServer();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('without a stored token the Tailscale session signs in once and the login form never shows', async () => {
  renderApp();

  await screen.findByText('workspace andrew');
  assert.equal(tailscaleCalls(), 1);
  assert.equal(localStorage.getItem('auth-token'), tailscaleToken);
  assert.equal(loginScreens, 0);
  assert.equal(seenError, null);
  // The token from the Tailscale session is enough; no user lookup is needed first.
  assert.equal(requestedPaths.includes('/api/auth/user'), false);
});

test('a refused Tailscale session falls back to the login form without an error', async () => {
  tailscaleBehaviour = 'refuse';
  renderApp();

  await screen.findByText('login');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(tailscaleCalls(), 1);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(seenError, null);
});

test('a Tailscale session that does not answer within 3 seconds falls back to the login form', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  tailscaleBehaviour = 'hang';
  renderApp();

  await waitFor(() => assert.equal(tailscaleCalls(), 1));
  assert.ok(screen.getByText('loading'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });

  await screen.findByText('login');
  assert.equal(tailscaleCalls(), 1);
  assert.equal(seenError, null);
});

test('an invalid stored token is cleared and the Tailscale session replaces it', async () => {
  storedTokenValid = false;
  localStorage.setItem('auth-token', makeToken(Math.floor(Date.now() / 1000) - 86400));
  renderApp();

  await screen.findByText('workspace andrew');
  assert.equal(tailscaleCalls(), 1);
  assert.equal(localStorage.getItem('auth-token'), tailscaleToken);
  assert.equal(seenError, null);
});

test('a valid stored token never calls the Tailscale session', async () => {
  localStorage.setItem('auth-token', makeToken(Math.floor(Date.now() / 1000)));
  renderApp();

  await screen.findByText('workspace andrew');
  assert.equal(tailscaleCalls(), 0);
});

test('first-run setup never calls the Tailscale session', async () => {
  needsSetup = true;
  renderApp();

  await screen.findByText('login');
  assert.equal(tailscaleCalls(), 0);
});
