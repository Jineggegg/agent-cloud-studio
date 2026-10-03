import { useCallback, useEffect, useRef } from 'react';
import type { ComponentType, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { animate, m, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from 'motion/react';
import { MoreHorizontal } from 'lucide-react';
import type { LucideProps } from 'lucide-react';

// Movement before a press commits to an axis; until then it may still be a tap or a vertical scroll of the list.
const AXIS_SLOP_PX = 8;
// Each action's width once the row is fully open, about iOS Mail's.
const ACTION_WIDTH_PX = 72;
// A release faster than this (px/s) opens or closes the row whatever its position; slower, the nearer state wins.
const FLICK_PX_PER_S = 400;
// The release velocity is measured over the last 100 ms of movement, and is zero if the pointer held still before lifting.
const VELOCITY_WINDOW_MS = 100;
const STILL_BEFORE_RELEASE_MS = 80;
// Past fully open (or past closed, to the right) the row follows the pointer with this share of its movement.
const OVERDRAG_SHARE = 0.25;
// The settle after a release: an iOS-like spring that carries the flick's speed.
const SETTLE_SPRING = { type: 'spring', stiffness: 420, damping: 40 } as const;

type SwipeAction = { label: string; icon: ComponentType<LucideProps>; destructive?: boolean; onSelect: () => void };

type Drag = {
  pointerId: number; startX: number; startY: number;
  // The row's offset when the press began (a row caught while springing included).
  origin: number;
  // Set once the press moved sideways past the slop; a vertical move drops the drag for the list's own scrolling.
  axis: 'x' | null;
  samples: { time: number; x: number }[];
};

// Rubber band past either end, so the row never jumps away from the pointer.
function resist(offset: number, openOffset: number) {
  if (offset > 0) return offset * OVERDRAG_SHARE;
  if (offset < openOffset) return openOffset + (offset - openOffset) * OVERDRAG_SHARE;
  return offset;
}

/**
 * Used by the workbench project switcher and session list: a row that swipes left like iOS Mail to reveal its
 * actions (the destructive one red, at the far edge). The pointer moves the row 1:1 (touch and mouse), a release
 * springs it open or shut by position and speed, a vertical move is left to the list's scrolling, and the click
 * that ends a swipe never reaches the row. Open state is the owner's (`open` / `onOpenChange`), so a list keeps one
 * row open at a time; a tap outside, a tap on the open row or Escape closes it. With `revealLabel` a "…" button
 * (and the context menu: right click, the menu key) opens the actions without swiping, moving focus onto them.
 */
export function WorkbenchSwipeRow({ open, onOpenChange, actions, disabled = false, revealLabel, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: SwipeAction[];
  // Off while the row is edited in place.
  disabled?: boolean;
  // The accessible name of the "…" button; rows that already have a menu of their own leave it out.
  revealLabel?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const actionBar = useRef<HTMLDivElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  // The content's horizontal offset: 0 shut, `openOffset` open; the actions fill the space it leaves.
  const offset = useMotionValue(0);
  const revealed = useTransform(offset, value => Math.max(0, -value));
  const openOffset = -actions.length * ACTION_WIDTH_PX;
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  // Where the row is settling; a prop change asking for the same place does not restart the spring.
  const target = useRef(0);
  // Set when the actions were opened by the "…" button or the context menu, so focus moves onto them.
  const focusActions = useRef(false);
  // The latest callback for the document listener, which is added once per opening.
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; });

  const settle = useCallback((next: number, velocity = 0) => {
    target.current = next;
    if (reduceMotion) { offset.stop(); offset.set(next); return; }
    void animate(offset, next, { ...SETTLE_SPRING, velocity });
  }, [offset, reduceMotion]);
  // After a tap or a vertical move the row goes back to where it was asked to be.
  const resume = () => { if (offset.get() !== target.current) settle(target.current); };

  // Clipped only while displaced, so a selection gliding between rows (the history's highlight) is never cut.
  useMotionValueEvent(offset, 'change', value => { root.current?.toggleAttribute('data-swiped', value !== 0); });

  // The owner opened or closed the row (another row opened, a tap elsewhere); a drag in progress decides itself.
  useEffect(() => {
    const next = open ? openOffset : 0;
    if (!drag.current?.axis && next !== target.current) settle(next);
  }, [open, openOffset, settle]);

  useEffect(() => {
    // Closed actions are out of the tab order and the accessibility tree.
    if (actionBar.current) actionBar.current.inert = !open;
    if (open && focusActions.current) actionBar.current?.querySelector<HTMLElement>('button')?.focus();
    focusActions.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // A press anywhere else closes the row (and still does what it was for).
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      onOpenChangeRef.current(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // The row's own control (its link or button) takes focus back when an action is chosen, so a confirmation that
  // follows returns focus there; Escape goes back to the "…" button when there is one.
  const focusContent = () => content.current?.querySelector<HTMLElement>('a[href], button:not(.wb-swipe-reveal), input')?.focus();
  const reveal = () => {
    if (open) { actionBar.current?.querySelector<HTMLElement>('button')?.focus(); return; }
    focusActions.current = true;
    onOpenChange(true);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (disabled || !actions.length || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // A press on a revealed action is a tap on it.
    if (event.target instanceof Node && actionBar.current?.contains(event.target)) return;
    offset.stop();
    drag.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: offset.get(), axis: null,
      samples: [{ time: performance.now(), x: event.clientX }],
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.axis) {
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (Math.abs(dx) < AXIS_SLOP_PX && Math.abs(dy) < AXIS_SLOP_PX) return;
      // A vertical move scrolls the list (touch-action: pan-y hands it to the browser).
      if (Math.abs(dx) <= Math.abs(dy)) { drag.current = null; resume(); return; }
      current.axis = 'x';
      // Follow from here, so the row does not jump by the slop.
      current.startX = event.clientX;
      suppressClick.current = true;
      try { root.current?.setPointerCapture?.(event.pointerId); } catch { /* The pointer may already be gone. */ }
    }
    const time = performance.now();
    current.samples.push({ time, x: event.clientX });
    while (current.samples.length > 2 && time - current.samples[0].time > VELOCITY_WINDOW_MS) current.samples.shift();
    offset.set(resist(current.origin + event.clientX - current.startX, openOffset));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    if (current.axis !== 'x') { resume(); return; }
    const first = current.samples[0];
    const last = current.samples[current.samples.length - 1];
    const still = performance.now() - last.time > STILL_BEFORE_RELEASE_MS;
    const velocity = still ? 0 : (last.x - first.x) / Math.max(1, last.time - first.time) * 1000;
    const shouldOpen = velocity <= -FLICK_PX_PER_S ? true : velocity >= FLICK_PX_PER_S ? false : offset.get() < openOffset / 2;
    settle(shouldOpen ? openOffset : 0, velocity);
    if (shouldOpen !== open) onOpenChange(shouldOpen);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    resume();
  };

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const swiped = suppressClick.current;
    suppressClick.current = false;
    // The actions and the "…" button always act.
    const target = event.target instanceof Node ? event.target : null;
    if (target && (actionBar.current?.contains(target) || revealButton.current?.contains(target))) return;
    // A swipe is never also a tap on the row it moved; a tap on an open row's content closes it instead of acting.
    if (!swiped && !open) return;
    event.preventDefault();
    event.stopPropagation();
    if (!swiped) onOpenChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return;
    // Escape closes the actions only; the popover or sheet around the row stays.
    event.preventDefault();
    event.stopPropagation();
    if (revealButton.current) revealButton.current.focus(); else focusContent();
    onOpenChange(false);
  };

  // Keyboard focus leaving the row closes it, as a tap elsewhere does.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (open && event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) onOpenChange(false);
  };

  return <div ref={root} className="wb-swipe" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel} onClickCapture={onClickCapture} onKeyDown={onKeyDown} onBlur={onBlur}
    // A link would otherwise start the browser's own drag when moved with a mouse.
    onDragStart={event => event.preventDefault()}
    onContextMenu={revealLabel && !disabled && actions.length ? event => { event.preventDefault(); reveal(); } : undefined}>
    <m.div ref={content} className="wb-swipe-content" style={{ x: offset }}>
      {children}
      {revealLabel && <button ref={revealButton} type="button" className="wb-swipe-reveal" aria-label={revealLabel} aria-expanded={open}
        disabled={disabled} onClick={() => (open ? onOpenChange(false) : reveal())}>
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>}
    </m.div>
    <m.div ref={actionBar} className="wb-swipe-actions" style={{ width: revealed }} aria-hidden={!open || undefined}>
      {actions.map(action => {
        const Icon = action.icon;
        return <button key={action.label} type="button" className="wb-swipe-action" data-destructive={action.destructive || undefined}
          tabIndex={open ? undefined : -1}
          onClick={() => { focusContent(); onOpenChange(false); action.onSelect(); }}>
          <Icon size={18} aria-hidden="true" /><span>{action.label}</span>
        </button>;
      })}
    </m.div>
  </div>;
}
