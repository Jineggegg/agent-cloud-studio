import { afterEach, expect, test, vi } from 'vitest';

import { AUTH_SESSION_EXPIRED_EVENT, expireAuthSession } from '@/shared/authToken';

afterEach(() => localStorage.removeItem('auth-token'));

test('a 401 before signing in does not announce an expired session', () => {
  const listener = vi.fn();
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  try {
    localStorage.removeItem('auth-token');
    expireAuthSession();
    expect(listener).not.toHaveBeenCalled();

    localStorage.setItem('auth-token', 'stored');
    expireAuthSession();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('auth-token')).toBeNull();
  } finally {
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  }
});
