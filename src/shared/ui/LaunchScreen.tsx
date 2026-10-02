import { Component, useEffect } from 'react';
import type { ReactNode } from 'react';

// The `.acs-launch*` styles live inline in index.html so the very first paint needs no stylesheet;
// the components below reuse them, which keeps every loading state pixel-identical to the splash
// and lets the error screen work even when the app's stylesheet never arrived.

// Matches the #launch-splash opacity transition in index.html; the cleanup waits a little longer.
const SPLASH_FADE_MS = 420;
const SPLASH_CLEANUP_MS = SPLASH_FADE_MS + 180;

// The production build loads the entry stylesheet without blocking the first paint and marks its
// link with this attribute (vite.config.js); the dev server injects styles from JavaScript instead.
const ENTRY_STYLESHEET_SELECTOR = 'link[data-acs-entry-style]';
// How often the splash re-checks those stylesheets between their load events.
const STYLESHEET_POLL_MS = 100;

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
 * Runs `onApplied` once every entry stylesheet is applied (at once when there is none or they already
 * are), so the splash never reveals a screen React rendered before its styles arrived. The preload link
 * fires `load` once when downloaded (its inline handler then makes it a stylesheet) and again when the
 * stylesheet is applied; `sheet` exists only after the latter. A slow poll backs the events up, so a
 * browser that skips the second event cannot strand the splash. A stylesheet that fails to load keeps
 * waiting: the splash's own slow-network hint and reload button cover that case. Returns a canceller.
 */
function whenEntryStylesApplied(onApplied: () => void): () => void {
  const pendingLinks = () => Array.from(document.querySelectorAll<HTMLLinkElement>(ENTRY_STYLESHEET_SELECTOR)).filter(link => !link.sheet);
  const watched = pendingLinks();
  if (watched.length === 0) {
    onApplied();
    return () => {};
  }
  let poll = 0;
  const stopWatching = () => {
    window.clearInterval(poll);
    watched.forEach(link => link.removeEventListener('load', check));
  };
  function check() {
    if (pendingLinks().length > 0) return;
    stopWatching();
    onApplied();
  }
  watched.forEach(link => link.addEventListener('load', check));
  poll = window.setInterval(check, STYLESHEET_POLL_MS);
  return stopWatching;
}

// Two frames: the first lets the browser paint the new screen under the splash, the second starts
// the fade from that painted frame, so the crossfade never reveals a blank page. Returns a canceller.
function releaseAfterNextPaint(): () => void {
  // A hidden tab gets no animation frames until it is shown, and there is no fade to see, so the
  // splash goes at once instead of waiting (and later claiming the network is slow).
  if (document.visibilityState === 'hidden') {
    releaseLaunchSplash();
    return () => {};
  }
  let secondFrame = 0;
  const firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(releaseLaunchSplash);
  });
  return () => {
    window.cancelAnimationFrame(firstFrame);
    window.cancelAnimationFrame(secondFrame);
  };
}

/**
 * Used by App (Studio and IDE routes) and the auth module's ProtectedRoute (setup, login and
 * onboarding screens). Rendering it next to a screen marks that screen as the first real paint,
 * so the launch screen leaves only once there is something to reveal — never earlier, never later —
 * and only once the app's stylesheet is applied, so nothing is ever revealed unstyled.
 * Place it inside the same Suspense boundary as lazily loaded content so it waits for that content.
 */
export function LaunchSplashRelease() {
  useEffect(() => {
    let cancelRelease = () => {};
    const cancelStyleWait = whenEntryStylesApplied(() => { cancelRelease = releaseAfterNextPaint(); });
    return () => {
      cancelStyleWait();
      cancelRelease();
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
        <LaunchMark />
      </div>
      <div className="acs-launch-line" aria-hidden="true" />
      <p className="acs-launch-hint">
        网络较慢，仍在加载…
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </p>
    </div>
  );
}

/** The glass cloud mark of the splash: used here by the loading and error screens, and by the auth module's sign-in layout. */
export function LaunchMark() {
  return (
    <span className="acs-launch-mark">
      <svg viewBox="0 0 512 512" focusable="false">
        <path className="acs-launch-cloud" d="M165 345h178c53 0 85-32 85-77s-34-80-80-80c-20-59-63-85-108-85-58 0-100 40-107 94-36 8-63 37-63 72 0 46 38 76 95 76Z" />
        <path className="acs-launch-base" d="M198 397h116" />
      </svg>
    </span>
  );
}

// Chrome, Safari and Firefox word a failed `import()` differently; Vite adds its own for CSS preloads.
const CHUNK_LOAD_ERROR = /dynamically imported module|importing a module script failed|unable to preload css/i;

// What went wrong decides what the error screen can honestly say.
type LaunchFailureKind = 'download' | 'render';

function LaunchErrorScreen({ kind, homeHref }: { kind: LaunchFailureKind; homeHref: string }) {
  // Released without waiting for the app stylesheet: this screen is styled inline (index.html), and
  // after a failed download that stylesheet may never arrive.
  useEffect(() => releaseAfterNextPaint(), []);
  return (
    <div className="acs-launch acs-launch-error" role="alert">
      <LaunchMark />
      <h1>页面没能打开</h1>
      <p>
        {kind === 'download'
          ? '需要的文件没能下载，可能是网络中断，或 Studio 刚刚更新过。'
          : 'Studio 在显示这个页面时出错了，这不是网络问题。返回主屏或重新加载通常就能恢复。'}
      </p>
      <div className="acs-launch-actions">
        <a href={homeHref}>返回主屏</a>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </div>
    </div>
  );
}

type LaunchErrorBoundaryProps = { homeHref: string; children: ReactNode };

// Set once a screen throws; the boundary then shows the error screen instead of its children.
type LaunchErrorBoundaryState = { failure: LaunchFailureKind | null };

/**
 * Used by App around everything it renders. A screen that throws while rendering, or a lazy screen
 * whose chunk cannot be downloaded, would otherwise leave the launch splash up forever with a
 * misleading "slow network" hint (or a blank page once the splash is gone). Instead this shows an
 * honest error screen that releases the splash and offers 返回主屏 (a fresh load of `homeHref`)
 * and 重新加载. Sub-apps inside the Studio keep their own, smaller boundaries.
 */
export class LaunchErrorBoundary extends Component<LaunchErrorBoundaryProps, LaunchErrorBoundaryState> {
  // Which kind of failure replaced the app, if any.
  state: LaunchErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): LaunchErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { failure: CHUNK_LOAD_ERROR.test(message) ? 'download' : 'render' };
  }

  componentDidCatch(error: unknown) {
    console.error('[App] a screen failed to load or render', error);
  }

  render() {
    if (!this.state.failure) return this.props.children;
    return <LaunchErrorScreen kind={this.state.failure} homeHref={this.props.homeHref} />;
  }
}
