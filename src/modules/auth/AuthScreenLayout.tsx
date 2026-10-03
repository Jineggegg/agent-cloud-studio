import type { ReactNode } from 'react';

import { LaunchMark } from '@/shared/ui/LaunchScreen';
import '@/modules/auth/auth-studio.css';

type AuthScreenLayoutProps = {
  title: string;
  description: string;
  children: ReactNode;
  footerText: string;
  logo?: ReactNode;
};

/**
 * Wraps the auth module's LoginForm and SetupForm so both full-screen auth pages share one layout:
 * the launch screen's backdrop and the Studio's logo, so the splash hands over without a visible change.
 * (The upstream CloudCLI UI attribution required by the license lives in the README and Settings → 关于.)
 */
export default function AuthScreenLayout({
  title,
  description,
  children,
  footerText,
  logo,
}: AuthScreenLayoutProps) {
  return (
    <div className="auth-studio">
      <div aria-hidden className="auth-studio-wallpaper"><span /><span /><span /></div>

      <main className="auth-studio-main">
        <div className="auth-studio-card">
          <div className="auth-studio-head">
            <div className="auth-studio-emblem" aria-hidden>{logo ?? <LaunchMark />}</div>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>

          <div className="auth-studio-body">{children}</div>

          <div className="auth-studio-foot">
            <p>{footerText}</p>
          </div>
        </div>
      </main>
    </div>
  );
}
