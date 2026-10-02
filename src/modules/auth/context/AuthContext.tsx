import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

import { IS_PLATFORM, takeHandoffCodeFromUrl, writeIngressPreference } from '@/shared/utils';
import { api } from '@/shared/api';
import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT, getAuthTokenRefreshDelay, isValidRefreshedToken, storeAuthToken } from '@/shared/authToken';
import { hydrateChatDrafts, resetChatDrafts } from '@/shared/chatDrafts';
import { hydrateUserPreferences, resetUserPreferences } from '@/shared/userSettings';
import type { StudioIngressId } from '@/shared/types';
/** The signed-in account held by AuthContext - a required `username` plus an optional id and any additional fields the auth API returns - and should be read through `useAuth()` rather than re-derived from raw auth responses. */
type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

// Passwordless Tailscale sign-in is only a shortcut on boot; a slow or absent Serve must not
// keep the loading screen up for longer than this before the login form appears.
const TAILSCALE_SESSION_TIMEOUT_MS = 3000;

// A handoff code lives 60 s on the server; a redemption slower than this falls back to the
// ordinary boot (stored session, Tailscale sign-in or the login form).
const HANDOFF_REDEEM_TIMEOUT_MS = 8000;

const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'errors.authStatusCheckFailed',
  loginFailed: 'errors.loginFailed',
  registrationFailed: 'errors.registrationFailed',
  networkError: 'errors.networkError',
  sessionExpired: 'errors.sessionExpired',
  handoffExpired: 'errors.handoffExpired',
  passkeyCancelled: 'login.errors.passkeyCancelled',
  passkeyFailed: 'login.errors.passkeyFailed',
} as const;

// Outcome of the one handoff attempt of a page load: no code in the URL, a session, or a refusal.
type HandoffOutcome = 'none' | 'redeemed' | 'failed';

type AuthActionResult = { success: true } | { success: false; error: string };

// Auth routes answer errors as AppError bodies ({ error: { code, message } }); older routes used
// a plain string. Both shapes are read by resolveApiErrorMessage.
type ApiErrorField = string | { code?: unknown; message?: unknown };

type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: ApiErrorField;
  message?: string;
};

type AuthStatusPayload = {
  needsSetup?: boolean;
};

type AuthUserPayload = {
  user?: AuthUser;
};

type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

type ApiErrorPayload = {
  error?: ApiErrorField;
  message?: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  // "用面容 ID 登录": the device's passkey for this domain instead of the password.
  loginWithPasskey: () => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

type AuthProviderProps = {
  children: ReactNode;
};

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

// Resolves to a session only when the server accepts this device's Tailscale identity. Refusals,
// network errors and answers slower than the timeout all resolve to null, so the caller shows the
// normal login form without an error. The shared API helper takes no AbortSignal, so a late
// answer is simply ignored.
async function requestTailscaleSession(): Promise<{ user: AuthUser; token: string } | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), TAILSCALE_SESSION_TIMEOUT_MS);
  });
  const attempt = (async () => {
    const response = await api.auth.tailscaleSession();
    if (!response.ok) {
      return null;
    }
    const payload = await parseJsonSafely<AuthSessionPayload>(response);
    return payload?.token && payload.user ? { user: payload.user, token: payload.token } : null;
  })().catch(() => null);

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Redeems a one-time code from the other front door (docs/network.md) for a session, like a
// password login. Refusals (expired, already used, wrong origin), network errors and answers
// slower than the timeout all resolve to null; the code is single-use either way.
async function requestHandoffSession(
  code: string,
): Promise<{ user: AuthUser; token: string; target: StudioIngressId | null } | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), HANDOFF_REDEEM_TIMEOUT_MS);
  });
  const attempt = (async () => {
    const response = await api.studio.redeemHandoff(code);
    if (!response.ok) {
      return null;
    }
    const payload = await parseJsonSafely<AuthSessionPayload & { target?: unknown }>(response);
    if (!payload?.token || !payload.user) {
      return null;
    }
    const target: StudioIngressId | null = payload.target === 'public' ? 'public'
      : payload.target === 'tailnet' ? 'tailnet' : null;
    return { user: payload.user, token: payload.token, target };
  })().catch(() => null);

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  // The server's own message, e.g. the login throttle's "登录失败次数过多，请 10 分钟后再试".
  const { error } = payload;
  if (typeof error === 'string' && error) {
    return error;
  }
  if (typeof error === 'object' && error !== null && typeof error.message === 'string' && error.message) {
    return error.message;
  }
  return typeof payload.message === 'string' && payload.message ? payload.message : fallback;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  storeAuthToken(token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

/** Used by App to expose the session, and its login/logout actions, to every module through useAuth. */
export function AuthProvider({ children }: AuthProviderProps) {
  // Never suspend here: the provider sits above every Suspense boundary and must start the session
  // check at once. Until a non-English language's strings arrive, `t` falls back to bundled English.
  const { t } = useTranslation('auth', { useSuspense: false });
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
    // Otherwise the next person to sign in on this device would start out
    // looking at the previous user's theme, language, permissions and drafts.
    resetUserPreferences();
    resetChatDrafts();
  }, []);

  // Preferences live in auth.db, so they can only be fetched once there is a
  // user to fetch them for. Until this resolves, every reader falls back to the
  // localStorage mirror of the last known server state.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!userKey) {
      return;
    }
    void hydrateUserPreferences();
    void hydrateChatDrafts();
  }, [userKey]);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const response = await api.user.onboardingStatus();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<OnboardingStatusPayload>(response);
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const refreshSession = useCallback(async () => {
    if (IS_PLATFORM || !token || !user) {
      return;
    }

    try {
      const response = await api.auth.refresh();
      if (!response.ok) {
        return;
      }

      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (isValidRefreshedToken(payload?.token)) {
        setToken(payload.token);
        persistToken(payload.token);
      }
    } catch (caughtError) {
      // A transient network failure must not sign the user out. Focus/visibility
      // and the next scheduled refresh will retry while the token remains valid.
      console.warn('[Auth] Session refresh failed:', caughtError);
    }
  }, [token, user]);

  useEffect(() => {
    const handleTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<unknown>).detail;
      if (isValidRefreshedToken(nextToken)) {
        setToken(nextToken);
      }
    };
    const handleSessionExpired = () => {
      clearSession();
      setError(t(AUTH_ERROR_MESSAGES.sessionExpired));
    };

    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, handleTokenRefreshed);
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [clearSession, t]);

  // The startup check below needs `t` only for its failure message.
  // react-i18next gives `t` a new identity on every language change, so
  // depending on it would re-run that check - and swap the whole app for the
  // loading screen - whenever the language changes, including when sign-in
  // adopts the language saved on another device.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // ProtectedRoute shows the workspace as soon as there is a user, so the
  // onboarding status is settled before the user is published; otherwise a
  // user who still has to onboard would see the workspace mount for a whole
  // round trip before Onboarding replaced it. The token is stored first
  // because that request reads it from storage.
  const publishSession = useCallback(async (nextUser: AuthUser, nextToken: string) => {
    persistToken(nextToken);
    await checkOnboardingStatus();
    setUser(nextUser);
    setToken(nextToken);
    setNeedsSetup(false);
  }, [checkOnboardingStatus]);

  // The single Tailscale sign-in attempt of this page load. StrictMode runs the
  // bootstrap effect twice; both runs await this one request instead of sending
  // a second, and neither shows the login form before it settles.
  const tailscaleSignInRef = useRef<Promise<boolean> | null>(null);

  const signInWithTailscaleOnce = useCallback(() => {
    tailscaleSignInRef.current ??= requestTailscaleSession()
      .then(async (session) => {
        if (!session) {
          return false;
        }
        await publishSession(session.user, session.token);
        // A stale stored token may have raised "session expired" on the way here.
        setError(null);
        return true;
      })
      .catch((caughtError: unknown) => {
        console.warn('[Auth] Tailscale sign-in could not be completed:', caughtError);
        return false;
      });
    return tailscaleSignInRef.current;
  }, [publishSession]);

  // The single handoff redemption of this page load (a ?handoff= code from the other front door,
  // docs/network.md). The code is taken out of the URL on the first call, so StrictMode's second
  // bootstrap run awaits the same request instead of sending a second one for a spent code.
  const handoffRedemptionRef = useRef<Promise<HandoffOutcome> | null>(null);

  const redeemHandoffOnce = useCallback(() => {
    handoffRedemptionRef.current ??= (async (): Promise<HandoffOutcome> => {
      const code = takeHandoffCodeFromUrl();
      if (!code) {
        return 'none';
      }
      const session = await requestHandoffSession(code);
      if (!session) {
        return 'failed';
      }
      await publishSession(session.user, session.token);
      // The switch was chosen on the other origin, whose localStorage this page cannot see.
      if (session.target) {
        writeIngressPreference(session.target);
      }
      setError(null);
      return 'redeemed';
    })().catch((caughtError: unknown) => {
      console.warn('[Auth] Handoff could not be completed:', caughtError);
      return 'failed';
    });
    return handoffRedemptionRef.current;
  }, [publishSession]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // A code from the other front door replaces whatever session this origin had stored.
      const handoff = await redeemHandoffOnce();
      if (handoff === 'redeemed') {
        return;
      }
      // An expired or spent code only matters when nothing else signs the user in.
      const explainFailedHandoff = (signedIn: boolean) => {
        if (!signedIn && handoff === 'failed') {
          setError(tRef.current(AUTH_ERROR_MESSAGES.handoffExpired));
        }
      };

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      // Read the stored token instead of depending on `token` state: this
      // bootstrap flips `isLoading`, which swaps the whole app for the loading
      // screen, so it must run once on mount and not again on every
      // X-Refreshed-Token rotation (each one remounted the workspace, #1269).
      // Without a usable token, the owner's own Tailscale device may be signed
      // in without a password; on any refusal the login form appears silently.
      if (!readStoredToken()) {
        explainFailedHandoff(await signInWithTailscaleOnce());
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        explainFailedHandoff(await signInWithTailscaleOnce());
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (!userPayload?.user) {
        clearSession();
        explainFailedHandoff(false);
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(tRef.current(AUTH_ERROR_MESSAGES.authStatusCheckFailed));
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, redeemHandoffOnce, signInWithTailscaleOnce]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus]);

  useEffect(() => {
    if (IS_PLATFORM || !token || !user) {
      return undefined;
    }

    const refreshIfNeeded = () => {
      const refreshDelay = getAuthTokenRefreshDelay(token);
      if (refreshDelay !== null && refreshDelay <= 0) {
        void refreshSession();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfNeeded();
      }
    };

    const refreshDelay = getAuthTokenRefreshDelay(token);
    const refreshTimer = refreshDelay === null
      ? null
      : window.setTimeout(() => void refreshSession(), refreshDelay);

    window.addEventListener('focus', refreshIfNeeded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      window.removeEventListener('focus', refreshIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshSession, token, user]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, t(AUTH_ERROR_MESSAGES.loginFailed));
          setError(message);
          return { success: false, error: message };
        }

        await publishSession(payload.user, payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [publishSession, t],
  );

  // Passkey sign-in: a fresh ceremony for this door (its id and challenge), the device's Face ID /
  // Touch ID prompt (discoverable credential, so no username), then the assertion, named by the
  // ceremony id, for a session. A cancelled prompt is not an error worth the server's time.
  const loginWithPasskey = useCallback<AuthContextValue['loginWithPasskey']>(async () => {
    const fail = (message: string): AuthActionResult => {
      setError(message);
      return { success: false, error: message };
    };
    try {
      setError(null);
      const optionsResponse = await api.auth.passkeyOptions();
      const started = await parseJsonSafely<{ ceremonyId?: string; options?: PublicKeyCredentialRequestOptionsJSON } & ApiErrorPayload>(optionsResponse);
      if (!optionsResponse.ok || !started?.ceremonyId || !started.options?.challenge) {
        return fail(resolveApiErrorMessage(started, t(AUTH_ERROR_MESSAGES.passkeyFailed)));
      }

      let assertion: Awaited<ReturnType<typeof startAuthentication>>;
      try {
        assertion = await startAuthentication({ optionsJSON: started.options });
      } catch (caughtError) {
        const cancelled = caughtError instanceof Error && ['NotAllowedError', 'AbortError'].includes(caughtError.name);
        return fail(t(cancelled ? AUTH_ERROR_MESSAGES.passkeyCancelled : AUTH_ERROR_MESSAGES.passkeyFailed));
      }

      const response = await api.auth.passkeySignIn(started.ceremonyId, assertion);
      const payload = await parseJsonSafely<AuthSessionPayload>(response);
      if (!response.ok || !payload?.token || !payload.user) {
        return fail(resolveApiErrorMessage(payload, t(AUTH_ERROR_MESSAGES.passkeyFailed)));
      }

      await publishSession(payload.user, payload.token);
      return { success: true };
    } catch (caughtError) {
      console.error('Passkey sign-in error:', caughtError);
      return fail(t(AUTH_ERROR_MESSAGES.networkError));
    }
  }, [publishSession, t]);

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, t(AUTH_ERROR_MESSAGES.registrationFailed));
          setError(message);
          return { success: false, error: message };
        }

        await publishSession(payload.user, payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(t(AUTH_ERROR_MESSAGES.networkError));
        return { success: false, error: t(AUTH_ERROR_MESSAGES.networkError) };
      }
    },
    [publishSession, t],
  );

  const logout = useCallback(() => {
    // JWT logout is client-side: the server endpoint does not maintain a
    // revocation list, so clearing the session is the complete operation.
    clearSession();
  }, [clearSession]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      login,
      loginWithPasskey,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      loginWithPasskey,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
