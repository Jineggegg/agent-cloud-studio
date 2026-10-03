/*
 * What a dragged home-screen icon means to do, the iPadOS way, as pure functions. Resting its centre on the middle
 * of another icon for a moment makes a folder of the two (or puts it into that folder): the other icon holds still
 * meanwhile instead of sliding away. Resting between icons, or on an icon's edge, makes room there: the grid reflows
 * only after a short dwell, so an icon the finger merely passes over on its way never dodges aside. StudioHomeScreen
 * feeds these the pointer and the icons' slots on every move (and when a dwell runs out), and drives dnd-kit's
 * sorting with the result.
 */

/** A point in viewport px. */
type DragPoint = { x: number; y: number };
/** A box in viewport px (a DOMRect or dnd-kit's ClientRect fits). */
export type DragRect = { left: number; top: number; width: number; height: number };

// Held this long on the middle of another icon, the icon there is ready to make a folder on release.
export const MERGE_DWELL_MS = 350;
// Held this long between icons (or on an icon's edge), the grid makes room there.
export const REORDER_DWELL_MS = 180;
// The middle of an icon that starts a folder: this share of the icon card, around its centre.
export const MERGE_CENTRE_SHARE = 0.55;
// Once an icon is the merge target, a little wobble of the finger keeps it so: the zone grows to this share.
const MERGE_KEEP_SHARE = 0.75;

/**
 * The drag's intent. `overId` is the item whose slot the dragged icon takes (the grid has made room there; the
 * dragged icon's own id means nothing moved). `merge` is an icon the pointer rests on the middle of, `ready` once
 * held long enough to make a folder. `pending` is a slot the pointer rests near, waiting to become `overId`.
 */
export type HomeDragIntent = {
  overId: string;
  merge: { id: string; since: number; ready: boolean } | null;
  pending: { id: string; since: number } | null;
};

/** Everything one evaluation looks at. */
export type HomeDragInput = {
  // When (performance.now() ms) and where the pointer is.
  now: number;
  point: DragPoint;
  activeId: string;
  // The grid's items in order, and each item's own slot (where it sits with nothing displaced).
  ids: readonly string[];
  slots: ReadonlyMap<string, DragRect>;
  // The icon card inside a slot (the slot also holds the name below it); the slot itself without it.
  iconOf?: (slot: DragRect) => DragRect;
  // Whether a slot is on the page in view; slots off screen are never targets.
  inView?: (slot: DragRect) => boolean;
  // Whether the dragged item may go into this one (an app onto an app or a folder; never a folder into anything).
  canMerge: (targetId: string) => boolean;
};

/** Where a drop lands: in a folder made with (or held by) `id`, or in the slot of `overId`. */
export type HomeDropTarget = { kind: 'merge'; id: string } | { kind: 'move'; overId: string };

/** A drag that has just begun: nothing displaced, nothing pending. */
export function initialDragIntent(activeId: string): HomeDragIntent {
  return { overId: activeId, merge: null, pending: null };
}

const centreOf = (rect: DragRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const contains = (rect: DragRect, point: DragPoint) => point.x >= rect.left && point.x <= rect.left + rect.width && point.y >= rect.top && point.y <= rect.top + rect.height;

/** Whether `point` lies within the middle `share` of `rect` (that share of its width and height, centred). */
export function inCentreArea(point: DragPoint, rect: DragRect, share = MERGE_CENTRE_SHARE): boolean {
  const centre = centreOf(rect);
  return Math.abs(point.x - centre.x) <= (rect.width * share) / 2 && Math.abs(point.y - centre.y) <= (rect.height * share) / 2;
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = items.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * Where each item shows while the dragged one has taken `overId`'s place: the items between slide one slot along,
 * exactly as dnd-kit's rectSortingStrategy displaces them. Returns [id, the slot it shows in] for every item.
 */
function shownSlots(input: HomeDragInput, overId: string): Array<[string, DragRect]> {
  const { ids, slots, activeId } = input;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  const order = from >= 0 && to >= 0 ? moveItem(ids, from, to) : ids.slice();
  return order.flatMap((id, position) => {
    const slot = slots.get(ids[position]);
    return slot ? [[id, slot] as [string, DragRect]] : [];
  });
}

// The slot whose centre is nearest the pointer, on the page in view, named by the item that owns it.
function nearestSlot(input: HomeDragInput): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const id of input.ids) {
    const slot = input.slots.get(id);
    if (!slot || (input.inView && !input.inView(slot))) continue;
    const centre = centreOf(slot);
    const distance = Math.hypot(centre.x - input.point.x, centre.y - input.point.y);
    if (!best || distance < best.distance) best = { id, distance };
  }
  return best?.id ?? null;
}

// The icon (not the dragged one) whose middle the pointer rests on, as the grid shows it now; null if none.
function mergeCandidate(previous: HomeDragIntent, input: HomeDragInput): string | null {
  for (const [id, slot] of shownSlots(input, previous.overId)) {
    if (id === input.activeId || (input.inView && !input.inView(slot)) || !input.canMerge(id)) continue;
    const icon = input.iconOf ? input.iconOf(slot) : slot;
    const share = previous.merge?.id === id ? MERGE_KEEP_SHARE : MERGE_CENTRE_SHARE;
    if (contains(slot, input.point) && inCentreArea(input.point, icon, share)) return id;
  }
  return null;
}

/**
 * The drag's next intent from the previous one and where the pointer is now. On the middle of an icon: a merge
 * candidate (ready after MERGE_DWELL_MS there), with the grid held as it is. Anywhere else: the nearest slot becomes
 * a pending place, which the grid makes room at after REORDER_DWELL_MS. Without measured slots nothing changes.
 */
export function nextDragIntent(previous: HomeDragIntent, input: HomeDragInput): HomeDragIntent {
  if (!input.slots.size) return previous;
  const target = mergeCandidate(previous, input);
  if (target) {
    const since = previous.merge?.id === target ? previous.merge.since : input.now;
    return { overId: previous.overId, merge: { id: target, since, ready: input.now - since >= MERGE_DWELL_MS }, pending: null };
  }
  const nearest = nearestSlot(input);
  if (!nearest || nearest === previous.overId) return { overId: previous.overId, merge: null, pending: null };
  const since = previous.pending?.id === nearest ? previous.pending.since : input.now;
  if (input.now - since >= REORDER_DWELL_MS) return { overId: nearest, merge: null, pending: null };
  return { overId: previous.overId, merge: null, pending: { id: nearest, since } };
}

/** When the intent would change if the pointer stayed put (a dwell running out), in the same clock; null if never. */
export function dragIntentWakeAt(intent: HomeDragIntent): number | null {
  const times = [
    intent.merge && !intent.merge.ready ? intent.merge.since + MERGE_DWELL_MS : Number.POSITIVE_INFINITY,
    intent.pending ? intent.pending.since + REORDER_DWELL_MS : Number.POSITIVE_INFINITY,
  ];
  const next = Math.min(...times);
  return Number.isFinite(next) ? next : null;
}

/**
 * Where a release at `input.point` lands. A merge target held long enough takes the icon into a folder. Otherwise the
 * icon goes where the finger is, without waiting for a dwell: the slot of an icon it was only just over, the place it
 * was about to make room at, or the room already made. Null without measured slots (the caller keeps dnd-kit's own).
 */
export function resolveDrop(previous: HomeDragIntent, input: HomeDragInput): HomeDropTarget | null {
  if (!input.slots.size) return null;
  const intent = nextDragIntent(previous, input);
  if (intent.merge?.ready) return { kind: 'merge', id: intent.merge.id };
  if (intent.merge) {
    // Not held long enough for a folder: the icon takes that icon's place, wherever the grid shows it now.
    const shown = shownSlots(input, intent.overId).find(([id]) => id === intent.merge?.id)?.[1];
    const owner = shown ? input.ids.find(id => input.slots.get(id) === shown) : undefined;
    return { kind: 'move', overId: owner ?? intent.merge.id };
  }
  return { kind: 'move', overId: intent.pending?.id ?? intent.overId };
}
