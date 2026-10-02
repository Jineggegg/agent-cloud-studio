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

function box(left: number, top: number, width: number, height: number) {
  return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) } as DOMRect;
}

// dnd-kit's DragOverlay is a fixed box placed with inline top/left/width/height; it measures where that puts it.
function overlayBox(element: Element) {
  if (!(element instanceof HTMLElement) || element.style.position !== 'fixed') return null;
  const px = (value: string) => Number.parseFloat(value) || 0;
  return box(px(element.style.left), px(element.style.top), px(element.style.width), px(element.style.height));
}

/**
 * jsdom lays nothing out, so every rect is empty and keyboard sorting has no neighbour to move to. This lays the
 * sortable items (`[data-sort-id]`) out in one row, in document order, well inside the viewport.
 */
export function layOutSortablesInARow() {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const index = Array.from(document.querySelectorAll('[data-sort-id]')).indexOf(this);
    return index < 0 ? overlayBox(this) ?? box(0, 0, 0, 0) : box(20 + index * 120, 20, 100, 100);
  });
}

// Each cell of `layOutSortablesInGrid` is a square of this many pixels, with no gap.
export const GRID_CELL_PX = 100;

/**
 * Lays the sortable items out the way CSS grid auto-placement does without dense packing: row by row in document
 * order, each item spanning the columns `spanOf` gives it, wrapping to a new row when it does not fit in what is
 * left of the current one (and never back-filling an earlier gap). It re-reads the DOM on every call, so a
 * reorder moves the boxes just as the real grid reflows.
 */
export function layOutSortablesInGrid(columns: number, spanOf: (item: Element) => number) {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    let row = 0;
    let column = 0;
    for (const item of Array.from(document.querySelectorAll('[data-sort-id]'))) {
      const span = Math.min(columns, Math.max(1, spanOf(item)));
      if (column + span > columns) { row += 1; column = 0; }
      if (item === this) return box(column * GRID_CELL_PX, row * GRID_CELL_PX, span * GRID_CELL_PX, GRID_CELL_PX);
      column += span;
    }
    return overlayBox(this) ?? box(0, 0, 0, 0);
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
