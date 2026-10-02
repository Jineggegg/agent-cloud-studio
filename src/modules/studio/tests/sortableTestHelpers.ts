import { act, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * jsdom has no PointerEvent, so fireEvent.pointerDown would build a plain Event without the `isPrimary`,
 * `button` and `pointerType` fields dnd-kit's pointer sensor reads. Installed once per test file.
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

/**
 * jsdom lays nothing out, so every rect is empty and keyboard sorting has no neighbour to move to. This lays the
 * sortable items (`[data-sort-id]`) out in one row, in document order, well inside the viewport.
 */
export function layOutSortablesInARow() {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const index = Array.from(document.querySelectorAll('[data-sort-id]')).indexOf(this);
    const left = index < 0 ? 0 : 20 + index * 120;
    const size = index < 0 ? 0 : 100;
    return { x: left, y: 20, left, top: 20, right: left + size, bottom: 20 + size, width: size, height: size, toJSON: () => ({}) } as DOMRect;
  });
}

// The keyboard sensor starts listening for arrow keys one tick after it activates.
async function nextTick() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

/** Picks an item up with Space, moves it one place with an arrow key and drops it with Space, as a keyboard user would. */
export async function moveOnePlaceWithKeyboard(handle: HTMLElement, direction: 'ArrowRight' | 'ArrowLeft') {
  handle.focus();
  fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
  await nextTick();
  fireEvent.keyDown(handle, { code: direction, key: direction });
  await nextTick();
  fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
  await nextTick();
}
