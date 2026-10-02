import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, ShieldCheck, User } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type SetupFormState = {
  username: string;
  password: string;
  confirmPassword: string;
};

const initialState: SetupFormState = {
  username: '',
  password: '',
  confirmPassword: '',
};

/**
 * Validates the account-setup form state.
 * @returns An error message string if validation fails, or `null` when the
 *   form is valid.
 */
function validateSetupForm(formState: SetupFormState, t: (key: string) => string): string | null {
  if (!formState.username.trim() || !formState.password || !formState.confirmPassword) {
    return t('register.errors.requiredFields');
  }

  if (formState.username.trim().length < 3) {
    return t('register.errors.usernameLength');
  }

  if (formState.password.length < 6) {
    return t('register.errors.passwordLength');
  }

  if (formState.password !== formState.confirmPassword) {
    return t('register.errors.passwordMismatch');
  }

  return null;
}

/**
 * Account setup / registration form.
 * Rendered by the auth module's ProtectedRoute when the server reports that no account exists yet.
 * Uses `autoComplete="new-password"` on password fields so that password
 * managers recognise this as a registration flow and offer to save the new
 * credentials after submission.
 */
export default function SetupForm() {
  const { t } = useTranslation('auth');
  const { register } = useAuth();

  const [formState, setFormState] = useState<SetupFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof SetupFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateSetupForm(formState, t);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await register(formState.username.trim(), formState.password);
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [formState, register, t],
  );

  return (
    <AuthScreenLayout
      title={t('register.title')}
      description={t('register.description')}
      footerText={t('register.footerText')}
    >
      <form onSubmit={handleSubmit} className="auth-studio-form">
        <AuthInputField
          id="username"
          name="username"
          label={t('register.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('register.placeholderUsername')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          name="password"
          label={t('register.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('register.placeholderPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          icon={Lock}
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label={t('register.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('register.placeholderConfirm')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          icon={ShieldCheck}
        />

        <p className="auth-hint">
          <ShieldCheck size={14} aria-hidden="true" />
          {t('register.hint')}
        </p>

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="auth-submit"
        >
          {isSubmitting ? (
            <>
              <span className="auth-spinner" aria-hidden="true" />
              {t('register.settingUp')}
            </>
          ) : (
            t('register.submit')
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
