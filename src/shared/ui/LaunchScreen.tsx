import { Component, useEffect } from 'react';
import type { ReactNode } from 'react';

import { StarSpark } from '@/shared/ui/StarSpark';
import { STAR_TIP, freezeStarHalo, placeStarOutline, runStarZoom, starCoverRadius, starTurnRemaining, starWindowHole } from '@/shared/ui/starSpark';

// The `.acs-launch*` and `.acs-star` styles live inline in index.html so the very first paint needs no stylesheet;
// the components below reuse them, which keeps every loading state pixel-identical to the splash
// and lets the error screen work even when the app's stylesheet never arrived.

// The splash star's draw-in (--star-draw in index.html); it starts turning right after. A fast start lets the draw-in
// finish before the splash leaves instead of cutting it short; a slow one is never held back, it is long over by then.
const SPLASH_DRAW_MS = 1100;
// The star's size on the splash (.acs-launch-star in index.html), for when the browser cannot measure it.
const SPLASH_STAR_PX = 132;
// Under reduced motion the splash just fades (#launch-splash[data-phase="fade"]); the cleanup waits a little longer.
const SPLASH_FADE_MS = 200;
const SPLASH_FADE_CLEANUP_MS = SPLASH_FADE_MS + 60;

// The production build loads the entry stylesheet without blocking the first paint and marks its
// link with this attribute (vite.config.js); the dev server injects styles from JavaScript instead.
const ENTRY_STYLESHEET_SELECTOR = 'link[data-acs-entry-style]';
// How often the splash re-checks those stylesheets between their load events.
const STYLESHEET_POLL_MS = 100;
// How long the splash waits for the two animation frames before it leaves anyway.
const FRAME_FALLBACK_MS = 400;

const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

// When the splash first showed (index.html stamps it), in performance.now() time; NaN without a stamp (as in tests).
function splashShownAt(): number {
  const stamp = document.getElementById('launch-splash')?.getAttribute('data-shown-at');
  return stamp ? Number(stamp) : Number.NaN;
}

// How long the splash star has been turning by the stamp, for browsers that cannot report their animations.
function splashTurnElapsed(): number {
  const shownAt = splashShownAt();
  return Number.isFinite(shownAt) ? performance.now() - shownAt - SPLASH_DRAW_MS : 0;
}

/**
 * The splash's way out once the app has painted underneath: the star comes to rest upright at the end of its quarter
 * turn, then grows into a star-shaped window cut out of the splash backdrop (starSpark.ts), its outline riding the
 * window's edge as a thin line and fading, while the app seen through it settles from slightly larger and blurred
 * (`html.acs-app-entering`). Then the node and the class are removed, so no transform lingers on #root (a transformed
 * ancestor would re-anchor every `position: fixed` sheet). `instant` (a hidden tab, or a page starved of animation
 * frames) just removes it; under reduced motion it fades.
 */
function releaseLaunchSplash(exit: 'animate' | 'instant') {
  const splash = document.getElementById('launch-splash');
  if (!splash || splash.dataset.state === 'leaving') return;
  splash.dataset.state = 'leaving';
  splash.setAttribute('aria-hidden', 'true');
  const star = splash.querySelector<SVGSVGElement>('.acs-star');
  if (exit === 'instant') {
    splash.remove();
    return;
  }
  if (!star || prefersReducedMotion()) {
    splash.dataset.phase = 'fade';
    window.setTimeout(() => splash.remove(), SPLASH_FADE_CLEANUP_MS);
    return;
  }
  const wait = starTurnRemaining(star, splashTurnElapsed());
  if (wait > 0) window.setTimeout(() => zoomThroughSplash(splash, star), wait);
  else zoomThroughSplash(splash, star);
}

function zoomThroughSplash(splash: HTMLElement, star: SVGSVGElement) {
  if (!splash.isConnected) return;
  const root = document.documentElement;
  const backdrop = splash.querySelector<HTMLElement>('.acs-launch-backdrop') ?? splash;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const box = star.getBoundingClientRect();
  const x = box.width ? box.left + box.width / 2 : width / 2;
  const y = box.height ? box.top + box.height / 2 : height / 2;
  freezeStarHalo(star, splashTurnElapsed());
  star.classList.remove('is-turning');
  star.classList.add('is-zooming');
  splash.dataset.phase = 'zoom';
  root.classList.add('acs-app-entering');
  runStarZoom({
    from: ((box.width || SPLASH_STAR_PX) * STAR_TIP) / 100,
    to: starCoverRadius(x, y, width, height),
    onFrame: (radius, progress) => {
      backdrop.style.clipPath = starWindowHole(x, y, radius, width, height);
      placeStarOutline(star, x, y, radius, progress);
    },
    onDone: () => {
      splash.remove();
      root.classList.remove('acs-app-entering');
    },
  });
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
// the zoom from that painted frame, so the star window never opens onto a blank page. Returns a canceller.
function releaseAfterNextPaint(): () => void {
  // A hidden tab gets no animation frames until it is shown, and there is no zoom to see, so the
  // splash goes at once instead of waiting (and later claiming the network is slow).
  if (document.visibilityState === 'hidden') {
    releaseLaunchSplash('instant');
    return () => {};
  }
  let secondFrame = 0;
  const firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(() => releaseLaunchSplash('animate'));
  });
  // A visible page can still be starved of frames (a throttled or freshly restored tab); the screen is
  // already rendered, so after a short wait the splash goes without the handshake (and without a zoom,
  // which would need those frames too).
  const fallback = window.setTimeout(() => releaseLaunchSplash('instant'), FRAME_FALLBACK_MS);
  return () => {
    window.cancelAnimationFrame(firstFrame);
    window.cancelAnimationFrame(secondFrame);
    window.clearTimeout(fallback);
  };
}

/**
 * How much longer the index.html splash should stay so its star can finish drawing in: what is left of SPLASH_DRAW_MS
 * since the `data-shown-at` stamp. 0 without a stamp (as in tests) or once the draw-in is over, and never more than
 * SPLASH_DRAW_MS whatever the stamp says.
 */
function splashIntroRemaining(): number {
  const shownAt = splashShownAt();
  if (!Number.isFinite(shownAt)) return 0;
  return Math.min(SPLASH_DRAW_MS, Math.max(0, shownAt + SPLASH_DRAW_MS - performance.now()));
}

// Runs `start` (which returns its own canceller) once the splash star has drawn in; at once in a hidden tab, where
// nothing is seen and timers are throttled. Returns a canceller for both the wait and whatever `start` began.
function afterSplashIntro(start: () => () => void): () => void {
  const wait = document.visibilityState === 'hidden' ? 0 : splashIntroRemaining();
  if (wait <= 0) return start();
  let cancelStarted = () => {};
  const timer = window.setTimeout(() => { cancelStarted = start(); }, wait);
  return () => {
    window.clearTimeout(timer);
    cancelStarted();
  };
}

/**
 * Used by App (Studio and IDE routes) and the auth module's ProtectedRoute (setup, login and
 * onboarding screens). Rendering it next to a screen marks that screen as the first real paint,
 * so the launch screen leaves only once there is something to reveal — never earlier, never later —
 * and only once the app's stylesheet is applied, so nothing is ever revealed unstyled. On a fast
 * start it also lets the splash star finish drawing in (at most SPLASH_DRAW_MS after its first paint),
 * so the launch never just flashes; a slow start is not held back by that at all. Leaving, a star that
 * is mid-turn first comes to rest upright (under STAR_TURN_MS), then the app opens through the star window.
 * Place it inside the same Suspense boundary as lazily loaded content so it waits for that content.
 */
export function LaunchSplashRelease() {
  useEffect(() => {
    let cancelRelease = () => {};
    const cancelStyleWait = whenEntryStylesApplied(() => { cancelRelease = afterSplashIntro(releaseAfterNextPaint); });
    return () => {
      cancelStyleWait();
      cancelRelease();
    };
  }, []);
  return null;
}

/**
 * Used by App while the workbench or IDE chunk loads and by the auth module's AuthLoadingScreen while the
 * session check runs: the launch screen's star, drawing in and then turning, so a later loading state
 * looks exactly like the splash it replaces instead of flashing a different spinner.
 */
export function LaunchScreen({ label }: { label: string }) {
  return (
    <div className="acs-launch" role="status" aria-live="polite" aria-label={label}>
      <StarSpark className="acs-launch-star" turning turnAfterDraw />
      <p className="acs-launch-hint">
        网络较慢，仍在加载…
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </p>
    </div>
  );
}

/**
 * The Studio's logo as its app icon shows it (public/studio-icon.svg): the four-pointed spark in its halo, drawing
 * itself in on a dark tile. Used here by the error screen, by the auth module's sign-in layout and by the studio
 * module's Settings → 关于本机 header and Harness app header.
 */
export function LaunchMark() {
  return (
    <span className="acs-launch-mark">
      <StarSpark drawMs={900} />
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
