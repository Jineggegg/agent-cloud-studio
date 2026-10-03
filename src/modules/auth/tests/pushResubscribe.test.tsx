import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import '@/modules/i18n';

/**
 * "退出所有设备" removes every Web Push subscription on the server. A browser that still holds a
 * subscription sends it again after signing in (marked `resubscribe`, so the server only stores
 * it), or the device would never get notifications again.
 */

const makeToken = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId: 1, username: 'andrew', iat: now, exp: now + 7 * 86400 })}.sig`;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SUBSCRIPTION = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'key', auth: 'auth' } };
let subscribeBodies: unknown[] = [];
let hasSubscription = true;
let permission: NotificationPermission = 'granted';

beforeEach(() => {
  subscribeBodies = [];
  hasSubscription = true;
  permission = 'granted';
  localStorage.setItem('auth-token', makeToken());
  vi.stubGlobal('Notification', { get permission() { return permission; } });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => (hasSubscription ? { toJSON: () => SUBSCRIPTION } : null) },
      }),
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/status') return json({ needsSetup: false });
    if (url === '/api/auth/user') return json({ user: { id: 1, username: 'andrew' } });
    if (url === '/api/user/onboarding-status') return json({ hasCompletedOnboarding: true });
    if (url === '/api/settings/push/subscribe') {
      subscribeBodies.push(JSON.parse(String(init?.body)));
      return json({ success: true });
    }
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.removeItem('auth-token');
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

function SignedIn() {
  const { user } = useAuth();
  return <p>{user ? `signed in as ${user.username}` : 'signed out'}</p>;
}

test('a signed-in browser sends its existing push subscription again, as a re-registration', async () => {
  render(<AuthProvider><SignedIn /></AuthProvider>);
  expect(await screen.findByText('signed in as andrew')).toBeTruthy();
  await waitFor(() => expect(subscribeBodies).toEqual([{ ...SUBSCRIPTION, resubscribe: true }]));
});

test('nothing is sent without a subscription or without notification permission', async () => {
  hasSubscription = false;
  render(<AuthProvider><SignedIn /></AuthProvider>);
  expect(await screen.findByText('signed in as andrew')).toBeTruthy();
  cleanup();
  hasSubscription = true;
  permission = 'default';
  render(<AuthProvider><SignedIn /></AuthProvider>);
  expect(await screen.findByText('signed in as andrew')).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(subscribeBodies).toEqual([]);
});
