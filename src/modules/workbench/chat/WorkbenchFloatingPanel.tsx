import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';

import type { AnchoredMenuPlacement } from '@/shared/types';

const POPOVER_SPRING = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 } as const;
const SHEET_SPRING = { type: 'spring', stiffness: 420, damping: 38 } as const;
// A bloom grows from its small trigger and shrinks back into it, so it starts (and ends) much smaller than a menu.
const BLOOM_SCALE = 0.35;
const BLOOM_SPRING = { type: 'spring', stiffness: 460, damping: 36, mass: 0.8 } as const;

/**
 * Used by the workbench chat's WorkbenchMenu, WorkbenchEffortControl and WorkbenchTokenRing to draw their glass panel
 * where `useAnchoredPopover` placed it: portalled to <body> inside a `.wbc-layer` (out of the chat column's overflow
 * and containment, which would clip it or re-anchor a fixed panel), growing in from the trigger, or rising as a sheet
 * over a light scrim on a phone. Nothing renders while `layout` is null; leaving plays the exit animation. `bloom`
 * makes the popover grow out of a small trigger and shrink back into it (the token ring's usage card).
 */
export function WorkbenchFloatingPanel({
  layout,
  panelRef,
  id,
  role,
  label,
  className,
  onKeyDown,
  bloom = false,
  tabIndex,
  children,
}: {
  layout: AnchoredMenuPlacement | 'sheet' | null;
  panelRef: Ref<HTMLDivElement>;
  id?: string;
  role: 'menu' | 'dialog';
  label: string;
  className: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  bloom?: boolean;
  // -1 lets a dialog without its own focusable control take focus when it opens, so Escape reaches it.
  tabIndex?: number;
  children: ReactNode;
}) {
  const popover = layout && layout !== 'sheet' ? layout : null;
  const popoverEnter = bloom ? { opacity: 0, scale: BLOOM_SCALE } : { opacity: 0, scale: 0.94, y: popover?.side === 'above' ? 8 : -8 };
  const popoverExit = bloom
    ? { opacity: 0, scale: BLOOM_SCALE, transition: { ...BLOOM_SPRING, opacity: { duration: 0.16, delay: 0.04 } } }
    : { opacity: 0, scale: 0.97, transition: { duration: 0.12 } };
  return createPortal(
    <AnimatePresence>
      {layout && (
        <div className="wbc-layer" key="layer">
          {!popover && (
            <m.div
              className="wbc-menu-scrim"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.16 } }}
            />
          )}
          <m.div
            ref={panelRef}
            id={id}
            role={role}
            aria-label={label}
            tabIndex={tabIndex}
            className={`${className} ${popover ? `is-${popover.side}` : 'is-sheet'}`}
            style={popover ? {
              top: popover.top,
              bottom: popover.bottom,
              left: popover.left,
              width: popover.width,
              maxHeight: popover.maxHeight,
              transformOrigin: popover.transformOrigin,
            } : undefined}
            // The grow-in from the trigger the owner likes; a sheet rises from the bottom edge instead.
            initial={popover ? popoverEnter : { opacity: 0, y: 40 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={popover ? popoverExit : { opacity: 0, y: 40, transition: { duration: 0.16 } }}
            transition={popover ? (bloom ? BLOOM_SPRING : POPOVER_SPRING) : SHEET_SPRING}
            onKeyDown={onKeyDown}
          >
            {children}
          </m.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
