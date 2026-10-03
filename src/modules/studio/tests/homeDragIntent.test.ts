import { describe, expect, test } from 'vitest';

import {
  MERGE_DWELL_MS, REORDER_DWELL_MS, dragIntentWakeAt, inCentreArea, initialDragIntent, nextDragIntent, resolveDrop,
} from '@/modules/studio/utils/homeDragIntent';
import type { DragRect, HomeDragInput, HomeDragIntent } from '@/modules/studio/utils/homeDragIntent';

// Four icons in a row of 100 px slots: a (dragged), b, c, d. Each slot's icon card is its top 70 px, centred.
const IDS = ['a', 'b', 'c', 'd'];
const slotAt = (index: number): DragRect => ({ left: index * 100, top: 0, width: 100, height: 100 });
const SLOTS = new Map(IDS.map((id, index) => [id, slotAt(index)]));
const iconOf = (slot: DragRect): DragRect => ({ left: slot.left + 15, top: slot.top, width: 70, height: 70 });

function input(point: { x: number; y: number }, now: number, overrides: Partial<HomeDragInput> = {}): HomeDragInput {
  return { now, point, activeId: 'a', ids: IDS, slots: SLOTS, iconOf, canMerge: () => true, ...overrides };
}

// Feeds pointer samples (x, y, time) through the intent, as successive drag moves would.
function run(samples: Array<[number, number, number]>, start: HomeDragIntent = initialDragIntent('a'), overrides: Partial<HomeDragInput> = {}) {
  return samples.reduce((intent, [x, y, now]) => nextDragIntent(intent, input({ x, y }, now, overrides)), start);
}

describe('centre area', () => {
  test('is the inner 55 % of the icon card, centred', () => {
    const card = { left: 0, top: 0, width: 100, height: 100 };
    expect(inCentreArea({ x: 50, y: 50 }, card)).toBe(true);
    expect(inCentreArea({ x: 77, y: 50 }, card)).toBe(true);
    expect(inCentreArea({ x: 78, y: 50 }, card)).toBe(false);
    expect(inCentreArea({ x: 50, y: 20 }, card)).toBe(false);
  });
});

describe('merge intent', () => {
  test('resting on the middle of an icon holds the grid still and becomes ready after the dwell', () => {
    // b's icon centre is (150, 35).
    const early = run([[150, 35, 0], [151, 36, MERGE_DWELL_MS - 1]]);
    expect(early).toEqual({ overId: 'a', merge: { id: 'b', since: 0, ready: false }, pending: null });
    expect(dragIntentWakeAt(early)).toBe(MERGE_DWELL_MS);
    const ready = nextDragIntent(early, input({ x: 151, y: 36 }, MERGE_DWELL_MS));
    expect(ready.merge).toEqual({ id: 'b', since: 0, ready: true });
    // The target never moved out from under the finger.
    expect(ready.overId).toBe('a');
    expect(dragIntentWakeAt(ready)).toBeNull();
  });

  test('a small wobble keeps the target; moving on to another icon starts over', () => {
    const held = run([[150, 35, 0], [176, 35, 100]]);
    expect(held.merge?.id).toBe('b');
    expect(held.merge?.since).toBe(0);
    const moved = run([[150, 35, 0], [250, 35, 200]]);
    expect(moved.merge).toEqual({ id: 'c', since: 200, ready: false });
  });

  test('never offered for an item that cannot take the dragged one (a folder dragged onto anything)', () => {
    const intent = run([[150, 35, 0], [150, 35, 1000]], initialDragIntent('a'), { canMerge: () => false });
    expect(intent.merge).toBeNull();
    expect(intent.overId).toBe('b');
  });
});

describe('reorder intent', () => {
  test('an icon passed over on the way to another never dodges: the grid waits for a dwell', () => {
    // Over b's lower edge (its name), briefly: pending only.
    const passing = run([[150, 92, 0], [160, 92, REORDER_DWELL_MS - 20]]);
    expect(passing.overId).toBe('a');
    expect(passing.pending).toEqual({ id: 'b', since: 0 });
    expect(dragIntentWakeAt(passing)).toBe(REORDER_DWELL_MS);
    // Held there: the grid makes room at b's slot.
    const settled = nextDragIntent(passing, input({ x: 160, y: 92 }, REORDER_DWELL_MS));
    expect(settled).toEqual({ overId: 'b', merge: null, pending: null });
  });

  test('after the grid made room, the merge zone follows where icons now show', () => {
    // a has taken b's slot, so b shows in a's old slot (0–100): its middle there makes a folder, not its old place.
    const moved: HomeDragIntent = { overId: 'b', merge: null, pending: null };
    expect(nextDragIntent(moved, input({ x: 50, y: 35 }, 0)).merge?.id).toBe('b');
    expect(nextDragIntent(moved, input({ x: 150, y: 35 }, 0)).merge).toBeNull();
  });

  test('slots off the page in view are never targets', () => {
    const intent = run([[350, 35, 0], [350, 35, 1000]], initialDragIntent('a'), { inView: slot => slot.left < 200 });
    expect(intent.merge).toBeNull();
    expect(intent.overId).toBe('b');
  });

  test('without measured slots nothing changes', () => {
    const start = initialDragIntent('a');
    expect(nextDragIntent(start, input({ x: 150, y: 35 }, 1000, { slots: new Map() }))).toBe(start);
    expect(resolveDrop(start, input({ x: 150, y: 35 }, 1000, { slots: new Map() }))).toBeNull();
  });
});

describe('drop', () => {
  test('on a ready target it merges; on one not yet ready it takes that icon\'s place', () => {
    const ready = run([[150, 35, 0], [150, 35, MERGE_DWELL_MS]]);
    expect(resolveDrop(ready, input({ x: 150, y: 35 }, MERGE_DWELL_MS + 16))).toEqual({ kind: 'merge', id: 'b' });
    expect(resolveDrop(initialDragIntent('a'), input({ x: 250, y: 35 }, 0))).toEqual({ kind: 'move', overId: 'c' });
  });

  test('between icons it lands where the finger is, without waiting for the dwell', () => {
    expect(resolveDrop(initialDragIntent('a'), input({ x: 350, y: 95 }, 0))).toEqual({ kind: 'move', overId: 'd' });
    // Back on its own (empty) slot: it stays.
    expect(resolveDrop(initialDragIntent('a'), input({ x: 50, y: 95 }, 0))).toEqual({ kind: 'move', overId: 'a' });
  });
});
