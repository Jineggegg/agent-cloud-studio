import { fireEvent } from '@testing-library/react';

/**
 * jsdom has no PointerEvent, so fireEvent.pointerDown would build a plain Event without the `clientX`, `pointerId`,
 * `pointerType` and `button` fields WorkbenchSwipeRow reads. Installed once per test file.
 */
export function installPointerEvent() {
  if (typeof window.PointerEvent === 'function') return;
  class TestPointerEvent extends MouseEvent {
    readonly pointerType: string;
    readonly isPrimary: boolean;
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
      this.pointerId = init.pointerId ?? 1;
    }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

/** A tap as the browser delivers it: press, lift without moving, then the click. */
export function tap(target: Element) {
  fireEvent.pointerDown(target, { pointerId: 8, pointerType: 'touch', button: 0, isPrimary: true, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(target, { pointerId: 8, pointerType: 'touch', clientX: 100, clientY: 100 });
  fireEvent.click(target);
}

/** Drags `target` by (dx, dy) in a few steps and lifts, as a finger (or a mouse) would on a swipe row. */
export function swipe(target: Element, { dx, dy = 0, pointerType = 'touch' }: { dx: number; dy?: number; pointerType?: 'touch' | 'mouse' }) {
  const from = { x: 240, y: 120 };
  const steps = 5;
  fireEvent.pointerDown(target, { pointerId: 7, pointerType, button: 0, isPrimary: true, clientX: from.x, clientY: from.y });
  for (let step = 1; step <= steps; step += 1) {
    fireEvent.pointerMove(target, { pointerId: 7, pointerType, clientX: from.x + (dx * step) / steps, clientY: from.y + (dy * step) / steps });
  }
  fireEvent.pointerUp(target, { pointerId: 7, pointerType, clientX: from.x + dx, clientY: from.y + dy });
}
