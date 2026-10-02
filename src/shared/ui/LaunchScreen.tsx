import { useEffect } from 'react';

// The `.acs-launch*` styles live inline in index.html so the very first paint needs no stylesheet;
// the components below reuse them, which keeps every loading state pixel-identical to the splash.

// Matches the #launch-splash opacity transition in index.html; the cleanup waits a little longer.
const SPLASH_FADE_MS = 420;
const SPLASH_CLEANUP_MS = SPLASH_FADE_MS + 180;

/**
 * Crossfades the index.html launch screen into the screen React just painted.
 * The splash fades and the app settles from 0.985 to 1 (`html.acs-app-entering`),
 * then both the node and the class are removed so no transform lingers on #root
 * (a transformed ancestor would re-anchor every `position: fixed` sheet).
 */
function releaseLaunchSplash() {
  const splash = document.getElementById('launch-splash');
  if (!splash || splash.dataset.state === 'leaving') return;
  const root = document.documentElement;
  splash.dataset.state = 'leaving';
  splash.setAttribute('aria-hidden', 'true');
  root.classList.add('acs-app-entering');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    splash.remove();
    root.classList.remove('acs-app-entering');
  };
  splash.addEventListener('transitionend', event => {
    if (event.target === splash && event.propertyName === 'opacity') finish();
  });
  // transitionend never fires when the tab is hidden or transitions are disabled.
  window.setTimeout(finish, SPLASH_CLEANUP_MS);
}

/**
 * Used by App (Studio and IDE routes) and the auth module's ProtectedRoute (setup, login and
 * onboarding screens). Rendering it next to a screen marks that screen as the first real paint,
 * so the launch screen leaves only once there is something to reveal — never earlier, never later.
 * Place it inside the same Suspense boundary as lazily loaded content so it waits for that content.
 */
export function LaunchSplashRelease() {
  useEffect(() => {
    // Two frames: the first lets the browser paint the new screen under the splash, the second
    // starts the fade from that painted frame, so the crossfade never reveals a blank page.
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(releaseLaunchSplash);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, []);
  return null;
}

/**
 * Used by App while the IDE chunk loads and by the auth module's AuthLoadingScreen while the
 * session check runs: the launch screen's emblem and hairline, so a later loading state looks
 * exactly like the splash it replaces instead of flashing a different spinner.
 */
export function LaunchScreen({ label }: { label: string }) {
  return (
    <div className="acs-launch" role="status" aria-live="polite" aria-label={label}>
      <div className="acs-launch-emblem" aria-hidden="true">
        <span className="acs-launch-halo" />
        <span className="acs-launch-mark">
          <svg viewBox="0 0 512 512" focusable="false">
            <path className="acs-launch-cloud" d="M165 345h178c53 0 85-32 85-77s-34-80-80-80c-20-59-63-85-108-85-58 0-100 40-107 94-36 8-63 37-63 72 0 46 38 76 95 76Z" />
            <path className="acs-launch-base" d="M198 397h116" />
          </svg>
        </span>
      </div>
      <div className="acs-launch-line" aria-hidden="true" />
      <p className="acs-launch-hint">
        网络较慢，仍在加载…
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </p>
    </div>
  );
}
