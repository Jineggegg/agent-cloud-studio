import { LaunchScreen } from '@/shared/ui/LaunchScreen';

/**
 * Rendered by the auth module's ProtectedRoute while the initial auth status check is in flight.
 * On a cold start the index.html splash still covers it; it draws the same launch screen so a later
 * session re-check (or a slow check that outlives the splash) never flashes a different design.
 */
export default function AuthLoadingScreen() {
  return <LaunchScreen label="正在验证登录状态" />;
}
