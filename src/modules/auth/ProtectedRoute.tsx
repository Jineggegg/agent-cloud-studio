import { Suspense, lazy } from 'react';
import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { LaunchSplashRelease } from '@/shared/ui/LaunchScreen';
import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

// Onboarding reaches provider sign-in, which embeds the terminal and chat; only a first run needs it.
const Onboarding = lazy(() => import('@/modules/onboarding').then(module => ({ default: module.Onboarding })));

type ProtectedRouteProps = {
  children: ReactNode;
};

/**
 * Used by App to gate the routed application behind setup, login and onboarding.
 * Each auth screen releases the launch splash once it has painted; the routed children release
 * it themselves (see App), so a signed-in start crossfades straight from the splash to the Studio.
 */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  // The launch-styled fallback keeps the splash look while the onboarding chunk loads.
  const onboarding = (
    <Suspense fallback={<AuthLoadingScreen />}>
      <Onboarding onComplete={refreshOnboardingStatus} />
      <LaunchSplashRelease />
    </Suspense>
  );

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return onboarding;
    }

    return <>{children}</>;
  }

  // The forms suspend while a non-English language's strings load (see the i18n module); the
  // launch-styled fallback keeps the splash look until they can paint.
  if (needsSetup) {
    return <Suspense fallback={<AuthLoadingScreen />}><SetupForm /><LaunchSplashRelease /></Suspense>;
  }

  if (!user) {
    return <Suspense fallback={<AuthLoadingScreen />}><LoginForm /><LaunchSplashRelease /></Suspense>;
  }

  if (!hasCompletedOnboarding) {
    return onboarding;
  }

  return <>{children}</>;
}
