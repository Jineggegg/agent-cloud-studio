import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, ScanFace, User } from 'lucide-react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

/**
 * Login form component.
 * Rendered by the auth module's ProtectedRoute when no user session exists.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials, and offers
 * "用面容 ID 登录" (a sign-in passkey for this domain) wherever the browser supports WebAuthn.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { error: sessionError, login, loginWithPasskey } = useAuth();

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The Face ID / Touch ID prompt is open or its assertion is being checked; locks both buttons.
  const [isPasskeyPending, setIsPasskeyPending] = useState(false);
  // WebAuthn needs a secure context (HTTPS or localhost); elsewhere the button is not offered.
  const passkeySupported = browserSupportsWebAuthn();
  const isBusy = isSubmitting || isPasskeyPending;

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  const handlePasskeyLogin = useCallback(async () => {
    setErrorMessage('');
    setIsPasskeyPending(true);
    const result = await loginWithPasskey();
    if (!result.success) {
      setErrorMessage(result.error);
    }
    setIsPasskeyPending(false);
  }, [loginWithPasskey]);

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description')}
      footerText={t('login.footerText')}
    >
      <form onSubmit={handleSubmit} className="auth-studio-form">
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isBusy}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isBusy}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isBusy}
          className="auth-submit"
        >
          {isSubmitting ? (
            <>
              <span className="auth-spinner" aria-hidden="true" />
              {t('login.loading')}
            </>
          ) : (
            t('login.submit')
          )}
        </button>

        {passkeySupported && (
          <>
            <div className="auth-divider" aria-hidden="true"><span>{t('login.or')}</span></div>
            <button
              type="button"
              disabled={isBusy}
              className="auth-passkey"
              onClick={() => void handlePasskeyLogin()}
            >
              {isPasskeyPending ? (
                <>
                  <span className="auth-spinner" aria-hidden="true" />
                  {t('login.passkeyLoading')}
                </>
              ) : (
                <>
                  <ScanFace size={19} aria-hidden="true" />
                  {t('login.passkey')}
                </>
              )}
            </button>
          </>
        )}
      </form>
    </AuthScreenLayout>
  );
}
