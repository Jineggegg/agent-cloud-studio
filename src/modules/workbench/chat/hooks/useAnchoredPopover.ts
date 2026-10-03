import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { AnchoredMenuPlacement } from '@/shared/types';
import { placeAnchoredMenu, readMenuBounds, sameMenuPlacement } from '@/shared/utils';

// Opens as a bottom sheet at or below this viewport width (a phone, or an iPad slide-over).
const SHEET_MAX_VIEWPORT_WIDTH = 520;
// Panels never grow taller than this, even with room to spare, keeping an iPadOS menu's proportions.
const PANEL_MAX_HEIGHT = 600;

type PopoverLayout = AnchoredMenuPlacement | 'sheet';

const sameLayout = (current: PopoverLayout | null, next: PopoverLayout) => (
  current === next || (current !== null && current !== 'sheet' && next !== 'sheet' && sameMenuPlacement(current, next))
);

/**
 * Where an open workbench popover sits: anchored to its trigger like an iPadOS pull-down (placed by
 * `placeAnchoredMenu`, so it flips above or below and stays on screen), `'sheet'` on a phone-wide viewport, or null
 * while closed. Measured when it opens, again once the panel has rendered (its real height decides the flip, before
 * paint), and on resize or scroll. A press outside the trigger and the panel calls `onDismiss`.
 * Used by the workbench chat's WorkbenchMenu and WorkbenchEffortControl.
 */
export function useAnchoredPopover({
  open,
  triggerRef,
  panelRef,
  preferredSide,
  align,
  width,
  onDismiss,
}: {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  preferredSide: 'above' | 'below';
  align: 'start' | 'end';
  width: number;
  onDismiss: () => void;
}): PopoverLayout | null {
  // Where the open panel sits; null while closed or before the trigger has been measured.
  const [layout, setLayout] = useState<PopoverLayout | null>(null);
  // The `open` the layout was kept for: closing forgets the old placement (adjusted during render, not in an
  // effect), so a reopened panel is measured afresh, its real height included, before it paints.
  const [layoutOpen, setLayoutOpen] = useState(open);
  if (layoutOpen !== open) {
    setLayoutOpen(open);
    if (!open) setLayout(null);
  }
  // Latest dismiss callback, read by the long-lived outside-press listener without re-subscribing it.
  const dismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
  });

  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const bounds = readMenuBounds();
    const next: PopoverLayout = bounds.right - bounds.left <= SHEET_MAX_VIEWPORT_WIDTH
      ? 'sheet'
      : placeAnchoredMenu(rect, {
        bounds,
        viewportHeight: window.innerHeight,
        width,
        align,
        preferredSide,
        contentHeight: panelRef.current?.scrollHeight,
        maxHeight: PANEL_MAX_HEIGHT,
      });
    setLayout((current) => (sameLayout(current, next) ? current : next));
  }, [align, panelRef, preferredSide, triggerRef, width]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    const onScroll = (event: Event) => {
      // The panel's own list scrolling does not move its trigger.
      if (!panelRef.current?.contains(event.target as Node)) measure();
    };
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, measure, panelRef]);

  // Once the panel exists its natural height is known; re-placing before paint means a flip never shows.
  // `sameLayout` ends this after one extra pass.
  useLayoutEffect(() => {
    if (open && layout && layout !== 'sheet') measure();
  }, [layout, measure, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) dismissRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, panelRef, triggerRef]);

  return open ? layout : null;
}
