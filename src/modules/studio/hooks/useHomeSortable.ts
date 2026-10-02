import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { KeyboardCode, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, pointerWithin, useSensor, useSensors } from '@dnd-kit/core';
import type {
  Announcements, CollisionDetection, DragCancelEvent, DragEndEvent, DragOverEvent, DragStartEvent, KeyboardCodes, PointerSensorOptions,
  UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import type { SortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Holding an item this long lifts it and enters edit mode, like the iPadOS home screen.
const LONG_PRESS_MS = 450;
// Movement allowed during the hold before it counts as a scroll instead of a press.
const PRESS_TOLERANCE_PX = 8;
// In edit mode a mouse drags after a few pixels; a finger holds briefly so swipes still scroll on iPad.
const EDIT_MOUSE_DISTANCE_PX = 6;
const EDIT_TOUCH_DELAY_MS = 160;
// Neighbours glide aside while sorting; a gentle spring with a hint of overshoot.
const SORT_TRANSITION = { duration: 340, easing: 'cubic-bezier(.3, 1.18, .55, 1)' };
// Dropped items (and items reflowing after a removal or resize) settle into place with this spring.
const GLIDE_MS = 460;
const GLIDE_EASING = 'cubic-bezier(.28, 1.24, .5, 1)';
// A click arriving this soon after a pointer drag belongs to that drag, not to the item under it.
const CLICK_SWALLOW_MS = 400;

// dnd-kit's defaults in edit mode; outside it no key picks an item up, so Enter and Space still open an app.
// (Swapping the codes rather than dropping the sensor keeps DndContext's sensor list a constant length.)
const EDIT_KEYBOARD_CODES: KeyboardCodes = {
  start: [KeyboardCode.Space, KeyboardCode.Enter], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
};
const IDLE_KEYBOARD_CODES: KeyboardCodes = { ...EDIT_KEYBOARD_CODES, start: [] };

const SCREEN_READER_INSTRUCTIONS = {
  draggable: '按空格键或回车键拿起，用方向键移动，再按空格键或回车键放下；按 Esc 取消。也可以用编辑模式里的「前移」「后移」按钮。',
};

/**
 * Only a mouse drags through pointer events. Touch and Apple Pencil go to the TouchSensor: it holds before lifting
 * (so swipes still scroll) and, once lifted, cancels touchmove, so Safari never starts panning the home screen and
 * ends the drag with a pointercancel (which is what happens to a pen on the pointer path).
 */
class MousePointerSensor extends PointerSensor {
  static activators = PointerSensor.activators.map(activator => ({
    ...activator,
    handler: (event: ReactPointerEvent, options: PointerSensorOptions) => event.nativeEvent.pointerType === 'mouse' && activator.handler(event, options),
  }));
}

// Widgets reorder for real while dragging, so nothing is displaced by a transform: the grid itself is the preview.
const NO_DISPLACEMENT: SortingStrategy = () => null;

/**
 * With two widget sizes the nearest centre can belong to a card the pointer is nowhere near, so a live reorder asks
 * what is under the pointer first. Keyboard drags (no pointer) and the gaps between cards use the nearest centre.
 */
const pointerFirstCollision: CollisionDetection = args => {
  const underPointer = pointerWithin(args);
  return underPointer.length ? underPointer : closestCenter(args);
};

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * dnd-kit already stops a post-drag click from propagating, but stopping propagation does not stop a link
 * from navigating. A one-shot capture listener on window (ahead of every other listener) cancels it outright.
 * A touch drag produces no click at all, so the guard also ends at the next press: that press starts a new
 * gesture, and its click (a tap on another icon's badge, on 完成) belongs to the user.
 */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); release(); };
  const release = () => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerdown', release, true);
    window.clearTimeout(timer);
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerdown', release, true);
  const timer = window.setTimeout(release, CLICK_SWALLOW_MS);
}

function isKeyboardEvent(event: Event | null) {
  return typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent;
}

function centerOf(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Sorting reports ids as UniqueIdentifier; every home item uses a string id.
const idOf = (id: UniqueIdentifier) => String(id);
// An order as one comparable value (item ids never contain a newline).
const orderKey = (ids: string[]) => ids.join('\n');

/**
 * Used by StudioWidgets and StudioHomeScreen to make a grid sortable the iPadOS way: a long press lifts an item
 * (entering edit mode), edit mode drags with mouse, touch, pen or keyboard, and drops settle with a spring.
 * Spread `dndProps` on DndContext and `sortableProps` on SortableContext, attach `containerRef` to the grid, wrap
 * layout changes that should glide (removing or resizing an item) in `glide`, wire visible move buttons to `move`
 * and announce `moveMessage` in a polite live region. With `reorderWhileDragging`, render the lifted item in a
 * DragOverlay and attach `overlayRef` to it.
 */
export function useHomeSortableList({ ids, editing, onEnterEdit, onReorder, labelOf, reorderWhileDragging = false }: {
  ids: string[];
  editing: boolean;
  // Called when a long press lifts an item while the home screen is not yet in edit mode.
  onEnterEdit: () => void;
  // Receives every id in its new order after a move (live while dragging, with `reorderWhileDragging`).
  onReorder: (ids: string[]) => void;
  // Accessible name of an item, spoken in the drag and move announcements.
  labelOf: (id: string) => string;
  // Mixed-size grids (widgets) reorder for real on every hover, so the preview is exactly the layout a drop keeps;
  // same-size grids (icons) slide their neighbours aside with transforms and reorder on drop.
  reorderWhileDragging?: boolean;
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  // The lifted card inside the DragOverlay (live reordering only); a drop glides the real item from there.
  const overlayRef = useRef<HTMLElement | null>(null);
  // Item rects captured just before a layout change; the effect below glides items from there.
  const pendingRects = useRef<Map<string, DOMRect> | null>(null);
  // The item a drop brings down from the overlay, which also shrinks back from its lifted size as it lands.
  const pendingLanding = useRef<string | null>(null);
  const runningGlides = useRef(new Map<Element, Animation>());
  // The order when the current drag began, restored if the drag is cancelled after live moves.
  const startOrder = useRef<string[] | null>(null);
  // Orders reached since the pointer last moved. A move re-measures the grid, which can report a new item under a
  // pointer that has not moved; following it may settle the layout further but must never cycle between orders.
  const settling = useRef<{ x: number; y: number; seen: Set<string> } | null>(null);
  // The move button that was pressed; it keeps focus even when React re-inserts its item's node to reorder it.
  const refocus = useRef<HTMLElement | null>(null);
  // Bumped with every change that should glide, so the layout effect runs after exactly that commit
  // (a drop that lands in place changes no list state, yet the lifted item still has to settle).
  const [glideVersion, setGlideVersion] = useState(0);
  // What the last move button did, read out by a polite live region (dnd-kit only announces drags).
  const [moveMessage, setMoveMessage] = useState('');

  const pointerOptions = useMemo(() => ({
    activationConstraint: editing ? { distance: EDIT_MOUSE_DISTANCE_PX } : { delay: LONG_PRESS_MS, tolerance: PRESS_TOLERANCE_PX },
  }), [editing]);
  const touchOptions = useMemo(() => ({
    activationConstraint: { delay: editing ? EDIT_TOUCH_DELAY_MS : LONG_PRESS_MS, tolerance: PRESS_TOLERANCE_PX },
  }), [editing]);
  const keyboardOptions = useMemo(() => ({
    coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: editing ? EDIT_KEYBOARD_CODES : IDLE_KEYBOARD_CODES,
  }), [editing]);
  const pointerSensor = useSensor(MousePointerSensor, pointerOptions);
  const touchSensor = useSensor(TouchSensor, touchOptions);
  const keyboardSensor = useSensor(KeyboardSensor, keyboardOptions);
  const sensors = useSensors(pointerSensor, touchSensor, keyboardSensor);

  const glide = useCallback((update: () => void, landing?: { id: string; rect: DOMRect }) => {
    const rects = new Map<string, DOMRect>();
    containerRef.current?.querySelectorAll<HTMLElement>('[data-sort-id]').forEach(node => {
      if (node.dataset.sortId) rects.set(node.dataset.sortId, node.getBoundingClientRect());
    });
    if (landing) rects.set(landing.id, landing.rect);
    pendingRects.current = rects;
    pendingLanding.current = landing?.id ?? null;
    setGlideVersion(version => version + 1);
    update();
  }, []);

  useLayoutEffect(() => {
    const before = pendingRects.current;
    const landingId = pendingLanding.current;
    pendingRects.current = null;
    pendingLanding.current = null;
    const container = containerRef.current;
    if (!before || !container || prefersReducedMotion()) return;
    container.querySelectorAll<HTMLElement>('[data-sort-id]').forEach(node => {
      const id = node.dataset.sortId ?? '';
      const from = before.get(id);
      if (!from || typeof node.animate !== 'function') return;
      // An unfinished glide is dropped before measuring, so the end point is the item's real place; the start
      // point was measured with that glide still running, so the new one picks up where the eye last saw it.
      runningGlides.current.get(node)?.cancel();
      const to = node.getBoundingClientRect();
      // Centres, not corners: the lifted item is still scaled up when it is measured.
      const start = centerOf(from);
      const end = centerOf(to);
      const dx = start.x - end.x;
      const dy = start.y - end.y;
      const scale = id === landingId && to.width > 0 ? from.width / to.width : 1;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.005) return;
      const animation = node.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'translate(0px, 0px) scale(1)' }],
        { duration: GLIDE_MS, easing: GLIDE_EASING },
      );
      runningGlides.current.set(node, animation);
      const forget = () => { if (runningGlides.current.get(node) === animation) runningGlides.current.delete(node); };
      animation.addEventListener('finish', forget);
      animation.addEventListener('cancel', forget);
    });
  }, [glideVersion]);

  useLayoutEffect(() => {
    const button = refocus.current;
    refocus.current = null;
    if (button?.isConnected && document.activeElement !== button) button.focus({ preventScroll: true });
  }, [glideVersion]);

  const onDragStart = useCallback((_event: DragStartEvent) => {
    // A settling glide animates `transform` and would override the drag's own transform.
    runningGlides.current.forEach(animation => animation.cancel());
    startOrder.current = ids;
    settling.current = null;
    if (!editing) onEnterEdit();
    // A tick of haptics where the platform has it (Android); browsers refuse it before the page's first tap.
    if (typeof navigator.vibrate === 'function' && navigator.userActivation?.hasBeenActive) navigator.vibrate(8);
  }, [editing, ids, onEnterEdit]);

  const onDragOver = useCallback(({ active, over, delta }: DragOverEvent) => {
    if (!over || over.id === active.id) return;
    const from = ids.indexOf(idOf(active.id));
    const to = ids.indexOf(idOf(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    if (!settling.current || settling.current.x !== delta.x || settling.current.y !== delta.y) {
      settling.current = { x: delta.x, y: delta.y, seen: new Set([orderKey(ids)]) };
    }
    if (settling.current.seen.has(orderKey(next))) return;
    settling.current.seen.add(orderKey(next));
    glide(() => onReorder(next));
  }, [glide, ids, onReorder]);

  // Where the lifted card is, so the real item can glide down from it (live reordering only).
  const landingFor = useCallback((id: UniqueIdentifier) => {
    const card = reorderWhileDragging ? overlayRef.current : null;
    return card ? { id: idOf(id), rect: card.getBoundingClientRect() } : undefined;
  }, [reorderWhileDragging]);

  const onDragEnd = useCallback(({ active, over, activatorEvent }: DragEndEvent) => {
    if (!isKeyboardEvent(activatorEvent)) swallowNextClick();
    startOrder.current = null;
    settling.current = null;
    // A live grid already shows the order the drop keeps; only the lifted card still has to land.
    if (reorderWhileDragging) { glide(() => {}, landingFor(active.id)); return; }
    const from = ids.indexOf(idOf(active.id));
    const to = over ? ids.indexOf(idOf(over.id)) : -1;
    glide(() => { if (from >= 0 && to >= 0 && from !== to) onReorder(arrayMove(ids, from, to)); });
  }, [glide, ids, landingFor, onReorder, reorderWhileDragging]);

  const onDragCancel = useCallback(({ active, activatorEvent }: DragCancelEvent) => {
    if (!isKeyboardEvent(activatorEvent)) swallowNextClick();
    const original = startOrder.current;
    startOrder.current = null;
    settling.current = null;
    glide(() => { if (original && orderKey(original) !== orderKey(ids)) onReorder(original); }, landingFor(active.id));
  }, [glide, ids, landingFor, onReorder]);

  const move = useCallback((id: string, step: -1 | 1) => {
    const from = ids.indexOf(id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= ids.length) return;
    refocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    glide(() => onReorder(arrayMove(ids, from, to)));
    setMoveMessage(`「${labelOf(id)}」已移到第 ${to + 1} 个，共 ${ids.length} 个。`);
  }, [glide, ids, labelOf, onReorder]);

  const announcements = useMemo<Announcements>(() => ({
    onDragStart: ({ active }) => `已拿起「${labelOf(idOf(active.id))}」。`,
    onDragOver: ({ active, over }) => over && over.id !== active.id ? `「${labelOf(idOf(active.id))}」移到「${labelOf(idOf(over.id))}」的位置。` : undefined,
    onDragEnd: ({ active, over }) => !reorderWhileDragging && over && over.id !== active.id
      ? `「${labelOf(idOf(active.id))}」已放在「${labelOf(idOf(over.id))}」的位置。` : `已放下「${labelOf(idOf(active.id))}」。`,
    onDragCancel: ({ active }) => `已取消移动「${labelOf(idOf(active.id))}」。`,
  }), [labelOf, reorderWhileDragging]);

  return {
    containerRef,
    overlayRef,
    glide,
    move,
    moveMessage,
    dndProps: {
      sensors,
      collisionDetection: reorderWhileDragging ? pointerFirstCollision : closestCenter,
      onDragStart,
      onDragOver: reorderWhileDragging ? onDragOver : undefined,
      onDragEnd,
      onDragCancel,
      accessibility: { announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS },
    },
    sortableProps: { items: ids, strategy: reorderWhileDragging ? NO_DISPLACEMENT : rectSortingStrategy },
  };
}

// The jiggle of each item starts at its own point and runs at a slightly different speed, so a grid
// never moves in lockstep. Derived from the id, so it stays put across renders.
function jigglePhase(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const unit = Math.abs(hash);
  return { delay: `${-(unit % 9) * 29}ms`, duration: `${248 + (unit % 5) * 7}ms` };
}

// dnd-kit's own post-drop layout animation is replaced by the list's glide (one animation, no double motion).
const NO_LAYOUT_ANIMATION = () => false;
// dnd-kit writes an inline `transition` (transform only, sometimes 0 ms after a drop); the lift's grow and
// shadow ride along in the same declaration so a drop still shrinks the item back with a spring.
const LIFT_TRANSITION = 'scale 380ms cubic-bezier(.34, 1.3, .64, 1), box-shadow 380ms cubic-bezier(.22, .8, .2, 1)';

/**
 * Used by StudioWidgets and StudioHomeScreen for each sortable item. Attach `setNodeRef` and `style` to the
 * element that moves, `setActivatorNodeRef` and `listeners` to the element that is pressed, and spread
 * `itemAttributes` on the moving element (the data attribute the list's glide looks for).
 */
export function useHomeSortableItem(id: string) {
  const sortable = useSortable({ id, transition: SORT_TRANSITION, animateLayoutChanges: NO_LAYOUT_ANIMATION, attributes: { roleDescription: '可拖动排序' } });
  const phase = useMemo(() => jigglePhase(id), [id]);
  const style = {
    // Translate only: a sorting strategy's scale would squash an item into a slot of another size.
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition ? `${sortable.transition}, ${LIFT_TRANSITION}` : LIFT_TRANSITION,
    '--jiggle-delay': phase.delay,
    '--jiggle-duration': phase.duration,
  } as CSSProperties;
  return { ...sortable, style, itemAttributes: { 'data-sort-id': id } };
}
