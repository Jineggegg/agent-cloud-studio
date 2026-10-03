import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Keeps the transcript on its newest line while the dock under it changes height — a permission or question sheet
 * rising or sinking, a queued draft or recovery note appearing, the composer growing with its text or attachments.
 * (The run status lives inside the composer's toolbar and its steps float above it, so it no longer moves the dock.)
 * The scroller gives up that height at its bottom edge, which would
 * otherwise push the last lines out of view; a transcript the owner has scrolled up (`pinned` false) is left alone.
 * Used by WorkbenchAgentChat.
 */
export function useDockScrollPin({
  dockRef,
  scrollRef,
  pinned,
}: {
  dockRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  pinned: boolean;
}) {
  // Latest `pinned`, read by the long-lived observer without re-subscribing it.
  const pinnedRef = useRef(pinned);
  useLayoutEffect(() => {
    pinnedRef.current = pinned;
  });

  useEffect(() => {
    const dock = dockRef.current;
    // jsdom and very old browsers have no ResizeObserver; the transcript then simply keeps its scroll offset.
    if (!dock || typeof ResizeObserver === 'undefined') return undefined;
    let lastHeight = dock.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = dock.offsetHeight;
      if (height === lastHeight) return;
      lastHeight = height;
      const scroller = scrollRef.current;
      if (scroller && pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, [dockRef, scrollRef]);
}
