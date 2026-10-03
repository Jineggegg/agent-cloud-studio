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

// Runs `callback` once the index.html launch splash (#launch-splash, removed by LaunchSplashRelease)
// is gone, i.e. once the first real screen is on display. Deliberately not tied to window `load`: a
// stylesheet that is slow or blocked (Google Fonts on mainland networks) can hold that back for tens
// of seconds, and the warm-up has nothing to wait for once the home screen is up.
function afterFirstScreen(callback: () => void) {
  const splash = document.getElementById('launch-splash');
  if (!splash?.parentNode) { callback(); return; }
  const observer = new MutationObserver(() => {
    if (splash.isConnected) return;
    observer.disconnect();
    callback();
  });
  observer.observe(splash.parentNode, { childList: true });
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
 * A chunk that failed to download is fetched again the next time the app opens or when the user taps
 * 重试, without reloading the Studio.
 */
export function lazyStudioPanel<Props extends object>(load: () => Promise<ComponentType<Props>>, skeleton: StudioPanelSkeleton) {
  let resolved: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  // React.lazy wraps generic Props in ref helpers TypeScript cannot resolve; at runtime it takes Props unchanged.
  const createLazyPanel = () => lazy(() => ensureLoaded().then(component => ({ default: component }))) as unknown as ComponentType<Props>;
  // React.lazy remembers a rejection for good, so a failed load swaps in a fresh wrapper; panels
  // mounted (or retried) after that use it and request the chunk again.
  let LazyPanel = createLazyPanel();
  // One shared request for both React.lazy and the warm-up.
  function ensureLoaded() {
    pending ??= load().then(component => { resolved = component; return component; }, failure => {
      pending = null;
      LazyPanel = createLazyPanel();
      throw failure;
    });
    return pending;
  }
  warmupLoaders.push(ensureLoaded);
  if (warmupLoaders.length === 1) scheduleWarmup();

  function PanelContent({ panelProps }: { panelProps: Props }) {
    // Chosen once per mount: a chunk that is already warm renders directly (not even one skeleton
    // frame); a cold one suspends. Fixed so a later re-render never swaps the subtree and remounts it.
    // A retry remounts this component, so it picks again (and a fresh wrapper after a failure).
    const [Panel] = useState(() => resolved ?? LazyPanel);
    // Suspense on both paths: a warm sub-app can still suspend (for example on strings of a language
    // that load on demand), and that must show its skeleton, not hand the whole Studio to App's fallback.
    return <Suspense fallback={<StudioPanelPlaceholder variant={skeleton} />}>{createElement(Panel, panelProps)}</Suspense>;
  }

  function StudioLazyPanel(props: Props) {
    // Bumped by the error panel's 重试 button: a new key gives the boundary and the panel a fresh mount.
    const [attempt, setAttempt] = useState(0);
    return <StudioPanelBoundary key={attempt} onRetry={() => setAttempt(current => current + 1)}>
      <PanelContent panelProps={props} />
    </StudioPanelBoundary>;
  }
  return StudioLazyPanel;
}
