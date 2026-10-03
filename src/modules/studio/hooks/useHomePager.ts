import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, MouseEvent, PointerEvent } from 'react';

import { PAGING_SPRING, applyRubberBand, springAtRest, springStep, targetPage } from '@/modules/studio/utils/homePaging';

// Movement before a touch commits to an axis; until then it may still be a tap, a long press or a vertical scroll.
const AXIS_SLOP_PX = 8;
// The release velocity is measured over the finger's last 100 ms, and is zero if it held still before lifting.
const VELOCITY_WINDOW_MS = 100;
const STILL_BEFORE_RELEASE_MS = 80;
// Past an edge the content moved less than the finger, so the spring only gets that share of the release velocity.
const OVERSCROLL_VELOCITY_SHARE = 0.35;
// The page control stays lit this long after the last movement.
const LIT_MS = 1200;
// A frame longer than this (a background tab, a debugger) is treated as this long, so the spring never jumps.
const MAX_FRAME_S = 0.064;
// Trackpad: this much sideways scrolling turns a page; the gesture then has to pause before it can turn another.
const WHEEL_TURN_PX = 60;
const WHEEL_PAUSE_MS = 180;
const WHEEL_MIN_LOCK_MS = 400;
// A trackpad turn starts with this much velocity (px/s), so it feels like a flick rather than a slow glide.
const WHEEL_TURN_VELOCITY = 900;
// Scrolling past the first or last page nudges the track by this share of a page, rubber-banded, and back.
const WHEEL_NUDGE_SHARE = 0.25;
// Deltas reported in lines or pages (some mice) are converted to pixels with these.
const WHEEL_LINE_PX = 16;

type Drag = {
  pointerId: number; startX: number; startY: number;
  // Track offset when the finger went down (a caught, still-moving page included).
  origin: number;
  axis: 'x' | 'y' | null;
  samples: { time: number; x: number }[];
};

const now = () => performance.now();
const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Keys typed into a field, or steering a slider, belong to that control.
function ownsArrowKeys(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [role="slider"]')));
}

/**
 * Used by StudioHomeScreen: horizontal paging with UIScrollView's physics. The finger moves the pages 1:1 (rubber-
 * banded past the first and last), a release springs to the page its position and speed point at (one page per
 * swipe, a moving page can be caught), vertical swipes stay with the page's own scrolling, and the click that ends a
 * swipe never reaches the icon it started on. Sideways trackpad scrolling and the arrow keys turn pages too.
 * Spread `viewportProps` on the clipping viewport and attach `trackRef` to the row of pages inside it; each page
 * carries `data-home-page="<index>"` so focus moving onto another page brings that page into view.
 */
export function useHomePager({ pageCount, keyboard, onSettle }: {
  pageCount: number;
  // Whether the arrow keys turn pages (off while an app covers the home screen).
  keyboard: boolean;
  // Called when the pages come to rest after moving.
  onSettle?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The page the track rests on or is heading to; the page control and the arrow keys follow it.
  const [page, setPage] = useState(0);
  // Whether the page control is lit, as it is on iPadOS while the pages move and for a moment after.
  const [lit, setLit] = useState(false);

  const pageRef = useRef(0);
  // The latest page count and settle callback, for event handlers and animation frames (synced after each render).
  const pageCountRef = useRef(pageCount);
  const onSettleRef = useRef(onSettle);
  // The track's offset in px (0 on the first page, negative further on) and its velocity while a spring runs.
  const motion = useRef({ x: 0, velocity: 0 });
  const widthRef = useRef(0);
  const frame = useRef<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  // Set while an icon or widget is being dragged: the pages then move only when asked to (edge turns).
  const blocked = useRef(false);
  const litTimer = useRef<number | undefined>(undefined);

  const width = useCallback(() => {
    if (!widthRef.current) widthRef.current = viewportRef.current?.clientWidth ?? 0;
    return widthRef.current;
  }, []);
  const render = useCallback(() => {
    if (trackRef.current) trackRef.current.style.transform = `translate3d(${motion.current.x}px, 0, 0)`;
  }, []);
  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const light = useCallback(() => {
    setLit(true);
    window.clearTimeout(litTimer.current);
    litTimer.current = window.setTimeout(() => setLit(false), LIT_MS);
  }, []);

  const springTo = useCallback((target: number, velocity: number) => {
    stop();
    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      motion.current = { x: target, velocity: 0 };
      render();
      onSettleRef.current?.();
      return;
    }
    motion.current.velocity = velocity;
    let last = now();
    const step = () => {
      const time = now();
      const seconds = Math.min(MAX_FRAME_S, (time - last) / 1000);
      last = time;
      const next = springStep({ position: motion.current.x, velocity: motion.current.velocity }, target, seconds, PAGING_SPRING);
      if (springAtRest(next, target)) {
        motion.current = { x: target, velocity: 0 };
        frame.current = null;
        render();
        onSettleRef.current?.();
        return;
      }
      motion.current = { x: next.position, velocity: next.velocity };
      render();
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [render, stop]);

  /** Moves to `next` (clamped to the pages that exist), starting with `velocity` px/s. */
  const goTo = useCallback((next: number, velocity = 0) => {
    const target = Math.max(0, Math.min(pageCountRef.current - 1, next));
    pageRef.current = target;
    setPage(target);
    springTo(-target * width(), velocity);
  }, [springTo, width]);

  /** Turns one page in `step`'s direction if there is a page there; says whether it did. */
  const turn = useCallback((step: -1 | 1) => {
    const next = pageRef.current + step;
    if (next < 0 || next >= pageCountRef.current) return false;
    goTo(next);
    light();
    return true;
  }, [goTo, light]);

  // A gesture that left the track between pages (a moving page caught, then let go) settles on the nearest page.
  const settle = useCallback(() => {
    const pageWidth = width();
    if (frame.current !== null || pageWidth <= 0 || Math.abs(motion.current.x + pageRef.current * pageWidth) <= 0.5) return;
    goTo(Math.round(-motion.current.x / pageWidth));
  }, [goTo, width]);

  /** Called by the home screen when an icon or widget drag starts and ends; a swipe in progress gives way. */
  const setGestureBlocked = useCallback((value: boolean) => {
    blocked.current = value;
    if (value && drag.current) {
      const wasSwiping = drag.current.axis === 'x';
      drag.current = null;
      if (wasSwiping) goTo(pageRef.current);
    }
  }, [goTo]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (pageCountRef.current < 2 || blocked.current) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A touch on a page that is still moving catches it, like UIScrollView; that touch is not also a tap.
    const moving = frame.current !== null;
    stop();
    suppressClick.current = moving;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: motion.current.x, axis: null, samples: [{ time: now(), x: event.clientX }] };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (blocked.current) { drag.current = null; return; }
    if (!current.axis) {
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (Math.abs(dx) < AXIS_SLOP_PX && Math.abs(dy) < AXIS_SLOP_PX) return;
      if (Math.abs(dx) <= Math.abs(dy)) {
        // A vertical swipe scrolls the page; a page caught mid-turn settles.
        drag.current = null;
        settle();
        return;
      }
      current.axis = 'x';
      // Follow from here, so the page does not jump by the slop.
      current.startX = event.clientX;
      suppressClick.current = true;
      try { viewportRef.current?.setPointerCapture?.(event.pointerId); } catch { /* The pointer may already be gone. */ }
    }
    const time = now();
    current.samples.push({ time, x: event.clientX });
    while (current.samples.length > 2 && time - current.samples[0].time > VELOCITY_WINDOW_MS) current.samples.shift();
    const pageWidth = width();
    motion.current.x = applyRubberBand(current.origin + event.clientX - current.startX, -(pageCountRef.current - 1) * pageWidth, 0, pageWidth);
    render();
    light();
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    const pageWidth = width();
    if (current.axis !== 'x' || pageWidth <= 0) { settle(); return; }
    const first = current.samples[0];
    const last = current.samples[current.samples.length - 1];
    const still = now() - last.time > STILL_BEFORE_RELEASE_MS;
    const velocity = still ? 0 : (last.x - first.x) / Math.max(1, last.time - first.time) * 1000;
    const pages = pageCountRef.current;
    const x = motion.current.x;
    const target = targetPage({ position: -x / pageWidth, velocity, startPage: Math.round(-current.origin / pageWidth), pageCount: pages });
    const overscrolled = x > 0 || x < -(pages - 1) * pageWidth;
    goTo(target, overscrolled ? velocity * OVERSCROLL_VELOCITY_SHARE : velocity);
    light();
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    settle();
  };

  // A swipe is never also a tap on the icon it started on (nor a tap on empty space that ends edit mode).
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // Tab, VoiceOver or a move button can put focus on another page; that page slides in.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    // The browser may have scrolled the clipped viewport to reveal the element; the track does that job.
    if (viewport && viewport.scrollLeft) viewport.scrollLeft = 0;
    const pageElement = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-home-page]') : null;
    const index = Number(pageElement?.dataset.homePage);
    if (Number.isInteger(index) && index !== pageRef.current && !drag.current) goTo(index);
  };

  // Sideways trackpad scrolling, one page per gesture, with a rubber-band nudge where there is no page.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = { sum: 0, lastAt: -Infinity, lockedUntil: -Infinity };
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || pageCountRef.current < 2) return;
      event.preventDefault();
      if (blocked.current || drag.current) return;
      const time = now();
      if (time < wheel.lockedUntil) { wheel.lockedUntil = Math.max(wheel.lockedUntil, time + WHEEL_PAUSE_MS); return; }
      if (time - wheel.lastAt > WHEEL_PAUSE_MS) wheel.sum = 0;
      wheel.lastAt = time;
      wheel.sum += event.deltaX * (event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? width() : 1);
      if (Math.abs(wheel.sum) < WHEEL_TURN_PX) return;
      const direction = Math.sign(wheel.sum);
      wheel.sum = 0;
      wheel.lockedUntil = time + WHEEL_MIN_LOCK_MS;
      const next = pageRef.current + direction;
      light();
      if (next >= 0 && next < pageCountRef.current) { goTo(next, -direction * WHEEL_TURN_VELOCITY); return; }
      const pageWidth = width();
      stop();
      motion.current.x = applyRubberBand(-pageRef.current * pageWidth - direction * pageWidth * WHEEL_NUDGE_SHARE, -(pageCountRef.current - 1) * pageWidth, 0, pageWidth);
      render();
      goTo(pageRef.current);
    };
    // Focus or find-in-page can scroll the clipped viewport, or a page, sideways; the track alone decides what shows.
    // (Scroll events do not bubble, but they pass through the viewport while capturing.)
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.scrollLeft) event.target.scrollLeft = 0;
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('scroll', onScroll, true);
    return () => { viewport.removeEventListener('wheel', onWheel); viewport.removeEventListener('scroll', onScroll, true); };
  }, [goTo, light, render, stop, width]);

  // The arrow keys turn pages, unless something else on the screen is using them.
  useEffect(() => {
    if (!keyboard) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (blocked.current || drag.current || ownsArrowKeys(event.target) || document.querySelector('[aria-modal="true"]')) return;
      const next = pageRef.current + (event.key === 'ArrowRight' ? 1 : -1);
      if (next < 0 || next >= pageCountRef.current) return;
      event.preventDefault();
      goTo(next);
      light();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goTo, keyboard, light]);

  // A new width (rotation, split view, a resized window) keeps the same page in view.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const next = viewport.clientWidth;
      if (next === widthRef.current) return;
      widthRef.current = next;
      stop();
      drag.current = null;
      motion.current = { x: -pageRef.current * next, velocity: 0 };
      render();
    };
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [render, stop]);

  useLayoutEffect(() => {
    pageCountRef.current = pageCount;
    onSettleRef.current = onSettle;
  });

  // Fewer pages (icons hidden, larger icons turned off) never leave the screen on a page that is gone.
  useLayoutEffect(() => {
    if (pageRef.current > pageCount - 1) goTo(pageCount - 1);
  }, [goTo, pageCount]);

  useEffect(() => () => { stop(); window.clearTimeout(litTimer.current); }, [stop]);

  return {
    viewportRef, trackRef, page, lit, goTo, turn, setGestureBlocked,
    viewportProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onFocus },
  };
}
