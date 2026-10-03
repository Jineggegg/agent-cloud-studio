import { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Navigate, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';

import { ThemeProvider } from '@/shared/context/ThemeContext';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { LaunchErrorBoundary, LaunchScreen, LaunchSplashRelease } from '@/shared/ui/LaunchScreen';
import { AuthProvider, ProtectedRoute } from '@/modules/auth';
import { i18n } from '@/modules/i18n';
import { StudioPage } from '@/modules/studio';

// The workbench (chat, editor, terminal, Git) is large; the Studio home screen loads without it. Its chat-wide
// providers (websocket, plugins, TaskMaster) live inside the chunk too, in WorkbenchRoute.
const WorkbenchRoute = lazy(() => import('@/modules/workbench').then(module => ({ default: module.WorkbenchRoute })));
// The inherited CloudCLI IDE, kept only as a hidden fallback at /legacy/… (nothing links there).
const ProjectWorkspaceRoute = lazy(() => import('@/modules/project-workspace').then(module => ({ default: module.ProjectWorkspaceRoute })));

const DEPLOYMENT_ASSET_DIRECTORIES = new Set(['assets', 'static', 'icons', 'images']);

/**
 * Detect the router basename from explicit runtime config or deployment hints.
 *
 * The app can be served from a path prefix by a reverse proxy, for example:
 *   /ai/manifest.json
 *   /ai/assets/index-abc123.js
 *   /ai/icons/icon-192x192.png
 *
 * React Router needs that prefix as its basename, but the packaged app should
 * also keep working when served directly from the domain root. The direct-root
 * case is easy to misread because asset URLs such as /icons/icon-192x192.png
 * contain a directory even though there is no application basename.
 */
function detectRouterBasename() {
  // Deployments can pin the router basename by setting window.__ROUTER_BASENAME__ in
  // index.html, so read it through a local widening instead of augmenting global Window.
  const explicitBasename =
    typeof window !== 'undefined'
      ? (window as Window & { __ROUTER_BASENAME__?: string }).__ROUTER_BASENAME__ || ''
      : '';
  if (explicitBasename) {
    // Keep the deployment escape hatch authoritative. A trailing slash is
    // harmless for humans but React Router expects a normalized basename.
    return explicitBasename.replace(/\/+$/, '');
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return '';
  }

  const candidatePaths = [
    { kind: 'manifest' as const, value: document.querySelector('link[rel="manifest"]')?.getAttribute('href') },
    { kind: 'script' as const, value: document.querySelector('script[type="module"][src]')?.getAttribute('src') },
    ...Array.from(
      document.querySelectorAll(
        'link[rel~="icon"][href], link[rel="apple-touch-icon"][href], link[rel="apple-touch-icon-precomposed"][href], link[rel="mask-icon"][href]'
      )
    ).map((node) => ({
      kind: 'icon' as const,
      value: node.getAttribute('href'),
    })),
  ].filter((candidate): candidate is { kind: 'manifest' | 'script' | 'icon'; value: string } => Boolean(candidate.value));

  let detectedBasename = '';
  for (const candidate of candidatePaths) {
    try {
      const candidateUrl = new URL(candidate.value, document.baseURI || window.location.href);
      if (candidateUrl.origin !== window.location.origin) {
        continue;
      }

      const pathname = candidateUrl.pathname;
      const normalizedPathname = pathname.replace(/\/+$/, '');

      let normalized = '';
      if (candidate.kind === 'script') {
        const match = normalizedPathname.match(/^(.*)\/assets\//);
        normalized = match?.[1] ? match[1].replace(/\/+$/, '') : '';
      } else {
        const manifestMatch = normalizedPathname.match(/^(.*)\/(?:manifest\.json|site\.webmanifest)$/);
        const iconMatch = normalizedPathname.match(
          /^(.*)\/(?:favicon(?:\.[^/]+)?|apple-touch-icon(?:-[^/]+)?(?:\.[^/]+)?|mask-icon(?:\.[^/]+)?|[^/]*icon[^/]*)$/
        );
        const match = candidate.kind === 'manifest' ? manifestMatch : iconMatch;
        if (match?.[1]) {
          const segments = match[1].split('/').filter(Boolean);

          // Strip directories that describe where static files live, not where
          // the app is mounted. This must also run for a single segment:
          //   /icons/icon-192x192.png       -> ''
          //   /ai/icons/icon-192x192.png    -> '/ai'
          // The previous implementation only stripped while more than one
          // segment remained, which incorrectly turned root deployments into a
          // Router basename of /icons and caused a blank page after login.
          while (segments.length > 0 && DEPLOYMENT_ASSET_DIRECTORIES.has(segments[segments.length - 1])) {
            segments.pop();
          }

          normalized = segments.length > 0 ? `/${segments.join('/')}` : '';
        }
      }

      if (normalized.length > detectedBasename.length) {
        detectedBasename = normalized;
      }
    } catch {
      // Ignore invalid candidate URLs and continue checking other hints.
    }
  }

  return detectedBasename;
}

/**
 * Rendered by main.tsx; mounts the shared providers, the auth gate and the routes. Every route
 * renders LaunchSplashRelease beside its screen so the index.html splash crossfades away only once
 * that screen has painted; the workbench's sits inside its Suspense boundary, so a cold start on
 * /work keeps the splash (not a spinner) up until the workbench itself is ready. An unknown path
 * goes to the Studio home, and a screen that throws (or a chunk that fails to download) shows
 * LaunchErrorBoundary's error screen, so the splash can never be left up with nothing behind it.
 */
export default function App() {
  const routerBasename = detectRouterBasename();
  // One element shape for all three Studio routes, so opening an app keeps the home screen mounted.
  const studioScreen = <><StudioPage /><LaunchSplashRelease /></>;
  // One element for every /work route, so opening another session keeps the workbench (and its websocket) mounted.
  const workbenchScreen = (
    <Suspense fallback={<LaunchScreen label="正在打开工作台" />}>
      <WorkbenchRoute />
      <LaunchSplashRelease />
    </Suspense>
  );
  // The inherited IDE's addresses (bookmarks, notifications, older Studio links) open in the workbench.
  const legacyRedirect = (kind: 'workspace' | 'session') => (
    <Suspense fallback={<LaunchScreen label="正在打开工作台" />}>
      <WorkbenchRoute legacy={kind} />
      <LaunchSplashRelease />
    </Suspense>
  );
  const legacyIdeScreen = (
    <Suspense fallback={<LaunchScreen label="正在打开旧版开发工具" />}>
      <ProjectWorkspaceRoute />
      <LaunchSplashRelease />
    </Suspense>
  );

  return (
    <LaunchErrorBoundary homeHref={`${routerBasename}/`}>
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <UiPreferencesProvider>
        <AuthProvider>
          {/* Last-resort boundary: every lazy screen has its own, this only catches a stray suspension. */}
          <Suspense fallback={<LaunchScreen label="正在加载" />}>
            <ProtectedRoute>
              <Router basename={routerBasename}>
                <Routes>
                  <Route path="/" element={studioScreen} />
                  <Route path="/projects/:id" element={studioScreen} />
                  <Route path="/apps/:app" element={studioScreen} />
                  <Route path="/work" element={workbenchScreen} />
                  <Route path="/work/:projectId" element={workbenchScreen} />
                  <Route path="/work/:projectId/s/:sessionId" element={workbenchScreen} />
                  <Route path="/work/:projectId/d/:conversationId" element={workbenchScreen} />
                  <Route path="/workspace" element={legacyRedirect('workspace')} />
                  <Route path="/session/:sessionId" element={legacyRedirect('session')} />
                  <Route path="/legacy/workspace" element={legacyIdeScreen} />
                  <Route path="/legacy/session/:sessionId" element={legacyIdeScreen} />
                  {/* Old bookmarks and mistyped links land on the home screen instead of an empty page. */}
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Router>
            </ProtectedRoute>
          </Suspense>
        </AuthProvider>
        </UiPreferencesProvider>
      </ThemeProvider>
    </I18nextProvider>
    </LaunchErrorBoundary>
  );
}
