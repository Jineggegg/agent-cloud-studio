import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { DragCancelEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { expect, test } from 'vitest';

import { useHomeSortableList } from '@/modules/studio/hooks/useHomeSortable';

// A keyboard activator keeps these drags from arming the post-drag click guard (it is for pointer drags).
const ACTIVE = { id: 'a', data: { current: undefined }, rect: { current: { initial: null, translated: null } } };

function dragEvent(overId: string | null, delta: { x: number; y: number }) {
  const over = overId ? { id: overId, rect: { left: 0, top: 0, width: 100, height: 100 }, disabled: false, data: { current: undefined } } : null;
  return { active: ACTIVE, over, delta, collisions: null, activatorEvent: new KeyboardEvent('keydown') };
}

// A live-reordering list (as the widget grid uses it) whose order lives in state, the way a grid keeps it.
function renderLiveList(initial: string[]) {
  return renderHook(() => {
    // The order the hook reorders; every live move lands here.
    const [ids, setIds] = useState(initial);
    const list = useHomeSortableList({ ids, editing: true, onEnterEdit: () => {}, onReorder: setIds, labelOf: id => id, reorderWhileDragging: true });
    return { ids, list };
  });
}

function startDrag(list: ReturnType<typeof useHomeSortableList>) {
  act(() => list.dndProps.onDragStart({ active: ACTIVE, activatorEvent: new KeyboardEvent('keydown') } as unknown as DragStartEvent));
}

test('a reflow that reports a new item under a pointer that has not moved never cycles the live order back', () => {
  const { result } = renderLiveList(['a', 'b', 'c']);
  startDrag(result.current.list);
  act(() => result.current.list.dndProps.onDragOver?.(dragEvent('c', { x: 200, y: 0 }) as unknown as DragOverEvent));
  expect(result.current.ids).toEqual(['b', 'c', 'a']);
  // The grid reflowed and b now sits under the unmoved pointer. Following it would restore the order the drag just
  // left (and the next reflow would undo that again): it is ignored.
  act(() => result.current.list.dndProps.onDragOver?.(dragEvent('b', { x: 200, y: 0 }) as unknown as DragOverEvent));
  expect(result.current.ids).toEqual(['b', 'c', 'a']);
  // Once the pointer really moves onto b, b is a target again.
  act(() => result.current.list.dndProps.onDragOver?.(dragEvent('b', { x: 20, y: 0 }) as unknown as DragOverEvent));
  expect(result.current.ids).toEqual(['a', 'b', 'c']);
});

test('a reflow may still settle the layout one step further when that reaches a new order', () => {
  const { result } = renderLiveList(['a', 'b', 'c', 'd']);
  startDrag(result.current.list);
  act(() => result.current.list.dndProps.onDragOver?.(dragEvent('c', { x: 200, y: 0 }) as unknown as DragOverEvent));
  expect(result.current.ids).toEqual(['b', 'c', 'a', 'd']);
  act(() => result.current.list.dndProps.onDragOver?.(dragEvent('d', { x: 200, y: 0 }) as unknown as DragOverEvent));
  expect(result.current.ids).toEqual(['b', 'c', 'd', 'a']);
});

test('cancelling a live drag restores the order it started from', () => {
  const { result } = renderLiveList(['a', 'b', 'c']);
  startDrag(result.current.list);
  act(() => result.current.list.dndProps.onDragOver?.(dragEvent('c', { x: 200, y: 0 }) as unknown as DragOverEvent));
  expect(result.current.ids).toEqual(['b', 'c', 'a']);
  act(() => result.current.list.dndProps.onDragCancel(dragEvent(null, { x: 200, y: 0 }) as unknown as DragCancelEvent));
  expect(result.current.ids).toEqual(['a', 'b', 'c']);
});

test('a live drop keeps the order already shown, even when the item last under the pointer was not followed', () => {
  const { result } = renderLiveList(['a', 'b', 'c']);
  startDrag(result.current.list);
  act(() => result.current.list.dndProps.onDragOver?.(dragEvent('c', { x: 200, y: 0 }) as unknown as DragOverEvent));
  act(() => result.current.list.dndProps.onDragEnd(dragEvent('b', { x: 200, y: 0 }) as unknown as DragCancelEvent));
  expect(result.current.ids).toEqual(['b', 'c', 'a']);
});
