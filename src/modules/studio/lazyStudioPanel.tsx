import { Suspense, createElement, lazy, useState } from 'react';
import type { ComponentProps, ComponentType } from 'react';

import { StudioPanelBoundary, StudioPanelPlaceholder } from '@/modules/studio/StudioPanelFallback';

// The shape a placeholder sketches while its sub-app's chunk downloads.
type StudioPanelSkeleton = ComponentProps<typeof StudioPanelPlaceholder>['variant'];

// Background warm-up starts this long after the first screen is up, so it never competes with the
// home screen's own first requests (projects, status, quota) or its entrance animation.
const WARMUP_DELAY_MS = 1200;

// Every registered sub-app loader; warmed together once the home screen is idle.
const warmupLoaders: Array<() => Promise<unknown>> = [];

// Runs `callback` once the page has loaded and the index.html launch splash (#launch-splash,
// removed by LaunchSplashRelease) is gone, i.e. once the first real screen is on display.
function afterFirstScreen(callback: () => void) {
  const waitForSplash = () => {
    const splash = document.getElementById('launch-splash');
    if (!splash?.parentNode) { callback(); return; }
    const observer = new MutationObserver(() => {
      if (splash.isConnected) return;
      observer.disconnect();
      callback();
    });
    observer.observe(splash.parentNode, { childList: true });
  };
  if (document.readyState === 'complete') waitForSplash();
  else window.addEventListener('load', waitForSplash, { once: true });
}

function scheduleWarmup() {
  if (typeof window === 'undefined' || import.meta.env.MODE === 'test') return;
  // Respect Data Saver: those users get each chunk only when they open its app.
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return;
  const warmAll = () => { for (const load of warmupLoaders) void load().catch(() => {}); };
  // Safari has no requestIdleCallback; a plain timeout after the first screen is a fine stand-in there.
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warmAll, { timeout: 4000 });
    else warmAll();
  };
  afterFirstScreen(() => window.setTimeout(whenIdle, WARMUP_DELAY_MS));
}

/**
 * Used by StudioPage to code-split its sub-apps (chat, Trading 212, mail, SNR, agents, tasks, settings,
 * project editor) out of the home screen's entry bundle. Returns a drop-in component with the same
 * props: a cold chunk loads through React.lazy behind an iOS-style skeleton, and every chunk is warmed
 * in the background once the home screen is idle, so opening an app afterwards renders immediately.
 */
export function lazyStudioPanel<Props extends object>(load: () => Promise<ComponentType<Props>>, skeleton: StudioPanelSkeleton) {
  let resolved: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  // One shared request for both React.lazy and the warm-up; a failed load is retried on next use.
  const ensureLoaded = () => {
    pending ??= load().then(component => { resolved = component; return component; }, failure => { pending = null; throw failure; });
    return pending;
  };
  // React.lazy wraps generic Props in ref helpers TypeScript cannot resolve; at runtime it takes Props unchanged.
  const LazyPanel = lazy(() => ensureLoaded().then(component => ({ default: component }))) as unknown as ComponentType<Props>;
  warmupLoaders.push(ensureLoaded);
  if (warmupLoaders.length === 1) scheduleWarmup();

  function StudioLazyPanel(props: Props) {
    // Chosen once per mount: a chunk that is already warm renders directly (not even one skeleton
    // frame); a cold one suspends. Fixed so a later re-render never swaps the subtree and remounts it.
    const [WarmPanel] = useState(() => resolved);
    return <StudioPanelBoundary>
      {WarmPanel ? createElement(WarmPanel, props)
        : <Suspense fallback={<StudioPanelPlaceholder variant={skeleton} />}>{createElement(LazyPanel, props)}</Suspense>}
    </StudioPanelBoundary>;
  }
  return StudioLazyPanel;
}
