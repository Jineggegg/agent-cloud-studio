import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';

// Keeps the panel off the screen edges and its anchor.
const EDGE = 8;
const GAP = 6;
// Below this much room under the anchor the panel opens upwards (e.g. a row near the bottom of the list).
const MIN_ROOM_BELOW = 260;

type Placement = { top?: number; bottom?: number; left: number; width: number; maxHeight: number; origin: string };

function place(anchor: DOMRect, width: number, align: 'start' | 'end'): Placement {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const panelWidth = Math.min(width, viewportWidth - EDGE * 2);
  const preferred = align === 'end' ? anchor.right - panelWidth : anchor.left;
  const left = Math.min(Math.max(EDGE, preferred), viewportWidth - panelWidth - EDGE);
  const roomBelow = viewportHeight - anchor.bottom - GAP - EDGE;
  const roomAbove = anchor.top - GAP - EDGE;
  const horizontalOrigin = align === 'end' ? 'right' : 'left';
  if (roomBelow >= MIN_ROOM_BELOW || roomBelow >= roomAbove) {
    return { top: anchor.bottom + GAP, left, width: panelWidth, maxHeight: Math.max(160, roomBelow), origin: `top ${horizontalOrigin}` };
  }
  return { bottom: viewportHeight - anchor.top + GAP, left, width: panelWidth, maxHeight: Math.max(160, roomAbove), origin: `bottom ${horizontalOrigin}` };
}

/**
 * Used across the workbench module (project switcher, new-session menu, row menus) as a glass popover anchored
 * to its trigger. Rendered in a portal over a transparent layer, so a tap outside closes it and no scrolling
 * ancestor clips it; Escape closes it and returns focus to the trigger, and arrow keys move between menu items.
 */
export function WorkbenchPopover({ open, anchor, onClose, label, role = 'menu', align = 'start', width = 260, children }: {
  open: boolean; anchor: HTMLElement | null; onClose: () => void; label: string;
  role?: 'menu' | 'dialog'; align?: 'start' | 'end'; width?: number; children: ReactNode;
}) {
  // Where the panel sits, measured from the trigger when it opens and when the window resizes.
  const [placement, setPlacement] = useState<Placement | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return undefined;
    const measure = () => setPlacement(place(anchor.getBoundingClientRect(), width, align));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, anchor, width, align]);

  useEffect(() => {
    if (!open || !placement) return undefined;
    // Focus starts inside the panel (a search field or the first item) and goes back to the trigger afterwards.
    const frame = window.requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>('[data-autofocus], [role="menuitem"], button, input, a[href]');
      first?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, placement]);

  const close = () => {
    onClose();
    anchor?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]), [role="option"]') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(<AnimatePresence>
    {open && placement && <div className="studio-layer wb-popover-layer" key="layer" onPointerDown={event => { if (event.target === event.currentTarget) close(); }}
      onKeyDown={onKeyDown}>
      <m.div ref={panel} className="wb-popover" role={role} aria-label={label}
        style={{ top: placement.top, bottom: placement.bottom, left: placement.left, width: placement.width, maxHeight: placement.maxHeight, transformOrigin: placement.origin }}
        initial={{ opacity: 0, scale: 0.94, filter: 'blur(4px)' }}
        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
        {children}
      </m.div>
    </div>}
  </AnimatePresence>, document.body);
}
