import { useState } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

type AuthInputFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  placeholder: string;
  isDisabled: boolean;
  type?: 'text' | 'password' | 'email';
  name?: string;
  autoComplete?: string;
  icon?: ComponentType<{ className?: string }>;
};

/**
 * A labelled input field for authentication forms.
 * Used by the auth module's LoginForm and SetupForm for their credential inputs.
 * Renders a `<label>` / `<input>` pair and forwards browser autofill hints
 * (`name`, `autoComplete`) so that password managers can identify and fill
 * the field correctly. Password fields gain a show/hide visibility toggle.
 */
export default function AuthInputField({
  id,
  label,
  value,
  onChange,
  placeholder,
  isDisabled,
  type = 'text',
  name,
  autoComplete,
  icon: Icon,
}: AuthInputFieldProps) {
  const { t } = useTranslation('auth');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  const isPasswordField = type === 'password';
  const resolvedType = isPasswordField && isPasswordVisible ? 'text' : type;

  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-field-box">
        {Icon && <Icon className="auth-field-icon" />}
        <input
          id={id}
          type={resolvedType}
          name={name ?? id}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`auth-input${Icon ? ' has-icon' : ''}${isPasswordField ? ' has-toggle' : ''}`}
          placeholder={placeholder}
          required
          disabled={isDisabled}
        />
        {isPasswordField && (
          <button
            type="button"
            onClick={() => setIsPasswordVisible((previous) => !previous)}
            disabled={isDisabled}
            aria-label={isPasswordVisible ? t('misc.hide') : t('misc.show')}
            className="auth-field-toggle"
          >
            {isPasswordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
    </div>
  );
}
