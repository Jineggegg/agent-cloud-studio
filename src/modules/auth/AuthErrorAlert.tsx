import { AlertCircle } from 'lucide-react';

type AuthErrorAlertProps = {
  errorMessage: string;
};

/** Rendered by the auth module's LoginForm and SetupForm to surface submit and session errors. */
export default function AuthErrorAlert({ errorMessage }: AuthErrorAlertProps) {
  if (!errorMessage) {
    return null;
  }

  return (
    <div role="alert" className="auth-alert">
      <AlertCircle size={17} aria-hidden="true" />
      <span>{errorMessage}</span>
    </div>
  );
}
