import { useCallback, useRef, useState } from 'react';

// One turn of a refresh icon (studio.css `.refreshing .refresh-icon`).
const REFRESH_TURN_MS = 900;
const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Used by StudioPage (home and app navigation-bar refresh) and StudioProjectAgents (the sessions list's refresh) to
 * spin a refresh icon while `task` runs. The spin lasts whole turns, at least one, so a fast answer still shows it
 * and the icon never snaps back mid-turn. A second call while one is running is ignored.
 */
export function useRefreshSpin() {
  const [spinning, setSpinning] = useState(false);
  // Synchronous guard: a double tap lands before React re-renders with `spinning`.
  const running = useRef(false);
  const run = useCallback(async (task: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setSpinning(true);
    const startedAt = performance.now();
    try {
      await task();
    } finally {
      const elapsed = performance.now() - startedAt;
      const rest = prefersReducedMotion() ? 0 : Math.max(1, Math.ceil(elapsed / REFRESH_TURN_MS)) * REFRESH_TURN_MS - elapsed;
      window.setTimeout(() => { running.current = false; setSpinning(false); }, rest);
    }
  }, []);
  return { spinning, run };
}
