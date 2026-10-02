import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { i18n } from '@/modules/i18n';

/**
 * Switching front doors (docs/network.md): the other door's page sends the browser here with
 * ?handoff=<one-time code>. On boot the code is taken out of the address, redeemed once (also
 * under StrictMode), and the session is stored exactly like a password login. A refused code
 * falls back to the ordinary boot and only explains itself when that ends at the login form.
 */

const makeToken = (issuedAtSeconds: number, username = 'andrew') => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { userId: 1, username, iat: issuedAtSeconds, exp: issuedAtSeconds + 7 * 86400 };
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig${issuedAtSeconds}${username}`;
};

const REDEEM_PATH = '/api/auth/handoff/redeem';
const TAILSCALE_PATH = '/api/auth/tailscale-session';
const handoffToken = makeToken(Math.floor(Date.now() / 1000), 'handoff');

let requests: { url: string; body: unknown }[] = [];
let redeemGrants = true;
let storedTokenValid = true;
let seenError: string | null = null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const stubServer = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (url === REDEEM_PATH) {
      assert.equal(init?.method, 'POST');
      return redeemGrants
        ? json({ success: true, user: { id: 1, username: 'andrew' }, token: handoffToken, target: 'tailnet' })
        : json({ success: false, error: { code: 'AUTH_HANDOFF_INVALID' } }, 400);
    }
    if (url === '/api/auth/status') {
      return json({ needsSetup: false });
    }
    if (url === TAILSCALE_PATH) {
      return json({ success: false, error: { code: 'AUTH_TAILSCALE_UNAVAILABLE' } }, 403);
    }
    if (url === '/api/auth/user') {
      return storedTokenValid ? json({ user: { id: 1, username: 'andrew' } }) : json({ error: 'Invalid token' }, 401);
    }
    if (url === '/api/user/onboarding-status') {
      return json({ hasCompletedOnboarding: true });
    }
    return json({});
  }));
};

function Gate() {
  const { isLoading, user, error } = useAuth();
  useEffect(() => {
    seenError = error;
  }, [error]);
  if (isLoading) {
    return <div>loading</div>;
  }
  return user ? <div>workspace {user.username}</div> : <div>login</div>;
}

const renderApp = () => render(
  <StrictMode>
    <AuthProvider>
      <Gate />
    </AuthProvider>
  </StrictMode>,
);

const calls = (path: string) => requests.filter((request) => request.url === path);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  localStorage.clear();
  requests = [];
  redeemGrants = true;
  storedTokenValid = true;
  seenError = null;
  window.history.replaceState(null, '', '/apps/connections?handoff=one-time-code&tab=network');
  stubServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

test('a handoff code is redeemed once, stored like a login, and removed from the address', async () => {
  renderApp();

  await screen.findByText('workspace andrew');
  assert.equal(calls(REDEEM_PATH).length, 1);
  assert.deepEqual(calls(REDEEM_PATH)[0].body, { code: 'one-time-code' });
  assert.equal(localStorage.getItem('auth-token'), handoffToken);
  assert.equal(`${window.location.pathname}${window.location.search}`, '/apps/connections?tab=network');
  // The choice made on the other origin is remembered on this one too.
  assert.equal(localStorage.getItem('studio-ingress-v1'), 'tailnet');
  assert.equal(calls(TAILSCALE_PATH).length, 0);
  assert.equal(calls('/api/auth/user').length, 0);
  assert.equal(seenError, null);
});

test('a handoff code replaces a session already stored on this door', async () => {
  localStorage.setItem('auth-token', makeToken(Math.floor(Date.now() / 1000)));
  renderApp();

  await screen.findByText('workspace andrew');
  assert.equal(localStorage.getItem('auth-token'), handoffToken);
  assert.equal(calls('/api/auth/user').length, 0);
});

test('a refused code without any other session explains itself on the login form', async () => {
  redeemGrants = false;
  renderApp();

  await screen.findByText('login');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(calls(REDEEM_PATH).length, 1);
  assert.equal(calls(TAILSCALE_PATH).length, 1);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(seenError, i18n.t('auth:errors.handoffExpired'));
  assert.match(seenError ?? '', /switch link has expired/);
  assert.equal(window.location.search, '?tab=network');
});

test('a refused code is silent when the stored session still works', async () => {
  redeemGrants = false;
  const storedToken = makeToken(Math.floor(Date.now() / 1000));
  localStorage.setItem('auth-token', storedToken);
  renderApp();

  await screen.findByText('workspace andrew');
  assert.equal(localStorage.getItem('auth-token'), storedToken);
  assert.equal(seenError, null);
});

test('without a code nothing is redeemed', async () => {
  window.history.replaceState(null, '', '/');
  localStorage.setItem('auth-token', makeToken(Math.floor(Date.now() / 1000)));
  renderApp();

  await screen.findByText('workspace andrew');
  assert.equal(calls(REDEEM_PATH).length, 0);
});
