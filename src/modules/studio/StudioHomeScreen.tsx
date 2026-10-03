import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MouseEvent, MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, MeasuringStrategy, useDndContext } from '@dnd-kit/core';
import type { CollisionDetection, DragCancelEvent, DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove } from '@dnd-kit/sortable';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { m } from 'motion/react';

import { IconAdjustmentsHorizontal, IconCheck, IconLayoutGrid, IconLogout, IconMoon, IconPlus, IconRefresh, IconSettings, IconSun } from '@/modules/studio/icons/tabler';
import { useTheme } from '@/shared/context/ThemeContext';
import { STUDIO_AJ_EXIT_TILE_ID, STUDIO_MOTION_OUT_MS } from '@/shared/constants';
import type { StudioHomeTile, StudioSnr } from '@/shared/types';
import { StudioAjExitSheet } from '@/modules/studio/StudioAjExitSheet';
import { StudioFluidBackground } from '@/modules/studio/StudioFluidBackground';
import { StudioHomeFolder } from '@/modules/studio/StudioHomeFolder';
import type { FolderSortable } from '@/modules/studio/StudioHomeFolder';
import { AddTile, FolderFace, SortableEntry, TileFace } from '@/modules/studio/StudioHomeTiles';
import type { SwitchState } from '@/modules/studio/StudioHomeTiles';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import { StudioWidgets } from '@/modules/studio/StudioWidgets';
import type { WidgetType } from '@/modules/studio/StudioWidgets';
import { useAjExit } from '@/modules/studio/hooks/useAjExit';
import { useHomePager } from '@/modules/studio/hooks/useHomePager';
import { useHomeSortableList } from '@/modules/studio/hooks/useHomeSortable';
import { useSheetClose } from '@/modules/studio/hooks/useSheetClose';
import { dragIntentWakeAt, initialDragIntent, nextDragIntent, resolveDrop } from '@/modules/studio/utils/homeDragIntent';
import type { DragRect, HomeDragInput, HomeDragIntent } from '@/modules/studio/utils/homeDragIntent';
import { HOME_FOLDER_PREFIX, cleanHomeName, movePageBreaks, releasePageBreak, tidyPageBreaks, useHomeLayout, useHomeNames, writeHomeName } from '@/modules/studio/utils/homeLayout';
import type { HomeFolder, HomeLayout } from '@/modules/studio/utils/homeLayout';
import { gridCapacity, pageRanges } from '@/modules/studio/utils/homePaging';
import { buildStatusText, setHomeFilling } from '@/modules/studio/utils/homeTiles';
import '@/modules/studio/studio-home.css';

// Integrations that are planned but not built; listed honestly as not connected.
const PLANNED: { name: string; caption: string; tone: string; glyph: string }[] = [
  // Outlook mail is built now (Settings → 邮箱); nothing else is planned at the moment.
];
// Taps on these keep edit mode; a tap anywhere else (the wallpaper, gaps between icons) ends it, as on iPadOS.
// `.studio-layer` covers the sheets, whose clicks bubble here through their React portals; an open folder closes on
// a tap beside it but stays in edit mode.
const KEEPS_EDITING = '.home-tile-slot, .widget-slot, button, a, input, label, .home-edit-bar, .studio-layer, .home-folder-layer';
// Dragging an icon to within this distance of the screen's side and holding it there turns the page, as on iPadOS.
const EDGE_ZONE_PX = 48;
const EDGE_HOLD_MS = 500;
// Held at the edge longer, the pages keep turning, one more each time the last turn has settled.
const EDGE_REPEAT_MS = 900;
// A folder just made from two icons settles from the merge target's enlarged size for this long.
const FOLDER_FORM_MS = 520;
// An icon dragged this far beyond an open folder's panel, and held there this long, closes the folder and carries on
// as a drag on the home screen, as on iPadOS.
const FOLDER_EXIT_MARGIN_PX = 10;
const FOLDER_EXIT_HOLD_MS = 240;
// The page dots gliding between the foot of the screen and the edit bar: the shared Studio timing (--motion-ease).
const PAGE_CONTROL_MOVE = { type: 'tween', duration: 0.38, ease: [0.32, 0.72, 0, 1] } as const;
// React 18 has no `inert` prop; an empty string sets the attribute (the edit bar, while it shrinks away).
const LEAVING_INERT = { inert: '' } as Record<string, string>;
// Pages move under a dragged icon, so dnd-kit measures where the icons are throughout, not just once per drag.
const ICON_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };
// A row that overflows the page by no more than this still counts as fitting: it only reaches into the space kept
// for the page control, and it keeps a few pixels of viewport jitter (iOS settling after an app switch) from moving
// the last row to a page of its own.
const FIT_TOLERANCE_PX = 12;
// Viewports shorter than this are transitional (a backgrounded web app, a window being restored) and never measured.
const MIN_MEASURABLE_HEIGHT_PX = 160;
// Fewer icons per page counts only once the screen has stayed that much shorter for this long (a Spotlight search, a
// keyboard or iOS settling after an app switch shrinks it only for a moment).
const VIEWPORT_SETTLE_MS = 700;
// After the page becomes visible again, iOS may still be settling the viewport; it is measured again after this.
const SETTLE_REMEASURE_MS = 400;

// How many icons fit on the first page (beside the widgets) and on each later one.
type Capacity = { first: number; page: number };
// What sits in the home grid: an app, or a folder of apps.
type Entry =
  | { kind: 'tile'; id: string; tile: StudioHomeTile }
  | { kind: 'folder'; id: string; folder: HomeFolder; tiles: StudioHomeTile[] };

// Switch theme with a circular reveal from the button, like Super Professor; instant where View Transitions are missing.
function revealTheme(apply: () => void, origin: HTMLElement) {
  const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> } };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!doc.startViewTransition || reduced) { apply(); return; }
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const root = document.documentElement;
  root.classList.add('theme-revealing');
  const transition = doc.startViewTransition(apply);
  void transition.finished.finally(() => root.classList.remove('theme-revealing'));
  void transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
}

// Items this device has placed come first, in its order; new ones (a project created since) follow in their natural order.
function orderById<T extends { id: string }>(items: T[], order: string[] | undefined) {
  if (!order?.length) return items;
  const rank = new Map(order.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, rank: rank.get(item.id) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.item);
}

const NO_TILES: StudioHomeTile[] = [];
const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Edit mode ending: every jiggling icon and widget eases from wherever its swing is to rest, instead of snapping
 * there when the jiggle animation is taken off. A Web Animation outranks the CSS one, so it takes over seamlessly.
 */
function settleJiggle(root: HTMLElement | null) {
  root?.querySelectorAll<HTMLElement>('.home-tile-slot[data-sort-id], .widget-slot > .widget').forEach(node => {
    if (typeof node.animate !== 'function') return;
    const { rotate, translate } = getComputedStyle(node);
    if (!rotate || rotate === 'none') return;
    node.animate([{ rotate, translate: translate === 'none' ? '0px 0px' : translate }, { rotate: '0deg', translate: '0px 0px' }],
      { duration: STUDIO_MOTION_OUT_MS, easing: 'cubic-bezier(.32, .72, 0, 1)' });
  });
}
// An id quoted in an attribute selector (CSS.escape where the browser has it; jsdom does not).
const cssEscape = (value: string) => typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
const folderEntryId = (folder: HomeFolder) => `${HOME_FOLDER_PREFIX}${folder.id}`;
const isFolderId = (id: string) => id.startsWith(HOME_FOLDER_PREFIX);
// Folder ids are short and only ever compared on this device.
const newFolderId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// A new folder is named after what it holds, the way iPadOS names one by its apps' category.
const folderNameFor = (ids: string[]) => ids.every(id => id.startsWith('project:')) ? '项目' : '工具';

/**
 * Every top-level id in the order the device shows them (hidden apps included, apps inside folders not): the base for
 * any change to the order.
 */
function topLevelOrder(layout: HomeLayout, tiles: StudioHomeTile[]) {
  const inFolders = new Set(layout.folders.flatMap(folder => folder.items));
  const ids = [...tiles.map(tile => tile.id).filter(id => !inFolders.has(id)), ...layout.folders.map(folderEntryId)];
  return orderById(ids.map(id => ({ id })), layout.order).map(entry => entry.id);
}

const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * How many icons fit on a page without scrolling, from the screen as laid out now: the pages' height less their
 * padding, the widgets on the first page, the gap above each page's grid (CSS custom properties on .home-screen),
 * and the grid's columns and tallest icon. Null until there is something to measure (and in layout-free tests),
 * which keeps every icon on one page.
 */
function measureCapacity(home: HTMLElement, viewport: HTMLElement, widgets: HTMLElement | null): Capacity | null {
  const page = viewport.querySelector<HTMLElement>('.home-page');
  const grid = viewport.querySelector<HTMLElement>('.home-grid');
  const slots = Array.from(viewport.querySelectorAll<HTMLElement>('.home-grid > .home-tile-slot'));
  if (!page || !grid || !slots.length) return null;
  const pageStyle = getComputedStyle(page);
  const gridStyle = getComputedStyle(grid);
  const homeStyle = getComputedStyle(home);
  const height = viewport.clientHeight - px(pageStyle.paddingTop) - px(pageStyle.paddingBottom);
  const rowGap = px(gridStyle.rowGap);
  const columnGap = px(gridStyle.columnGap);
  const rowHeight = Math.max(...slots.map(slot => slot.offsetHeight));
  // Browsers resolve the grid's tracks to pixel widths; without them, divide the grid's width by a cell's.
  const tracks = gridStyle.gridTemplateColumns.split(' ').filter(track => track.endsWith('px')).length;
  const cellWidth = slots[0].offsetWidth;
  const columns = tracks || (cellWidth > 0 ? Math.max(1, Math.floor((grid.clientWidth + columnGap) / (cellWidth + columnGap))) : 0);
  if (height <= 0 || rowHeight <= 0 || columns <= 0) return null;
  const firstGap = px(homeStyle.getPropertyValue('--home-grid-top'));
  const laterGap = px(homeStyle.getPropertyValue('--home-grid-top-later'));
  return {
    first: gridCapacity({ available: height - (widgets?.offsetHeight ?? 0) - firstGap + FIT_TOLERANCE_PX, rowHeight, rowGap, columns }),
    // A later page always takes at least a row, so even a tiny window makes progress through the icons.
    page: Math.max(columns, gridCapacity({ available: height - laterGap + FIT_TOLERANCE_PX, rowHeight, rowGap, columns })),
  };
}

const sameCapacity = (a: Capacity | null, b: Capacity | null) => a === b || (a !== null && b !== null && a.first === b.first && a.page === b.page);

// Where the pointer is during a drag (null for keyboard drags, which never make folders).
function pointerOf({ activatorEvent, delta }: { activatorEvent: Event | null; delta: { x: number; y: number } }) {
  const start = activatorEvent && !(activatorEvent instanceof KeyboardEvent) ? getEventCoordinates(activatorEvent) : null;
  return start ? { x: start.x + delta.x, y: start.y + delta.y } : null;
}

/**
 * Where the icon card sits in a slot (the slot also holds the name below it), measured from the dragged icon: the
 * middle of that card is where a held icon makes a folder (homeDragIntent.ts). Without layout to measure (tests), a
 * square at the top of the slot stands in.
 */
function measureIconBox(slot: Element | null): (rect: DragRect) => DragRect {
  const slotBox = slot?.getBoundingClientRect();
  const iconBox = slot?.querySelector('.home-icon')?.getBoundingClientRect();
  if (slotBox && iconBox && iconBox.width > 0 && slotBox.width > 0) {
    const offsetX = iconBox.left - slotBox.left;
    const offsetY = iconBox.top - slotBox.top;
    return rect => ({ left: rect.left + offsetX, top: rect.top + offsetY, width: iconBox.width, height: iconBox.height });
  }
  return rect => {
    const side = Math.min(rect.width, rect.height * 0.7);
    return { left: rect.left + (rect.width - side) / 2, top: rect.top, width: side, height: side };
  };
}

/**
 * The lifted icon while it is dragged. It rides in dnd-kit's DragOverlay, a fixed box outside the sliding pages, so
 * it stays under the finger while a held edge turns the page beneath it. It also lends the list its re-measure,
 * which the home screen calls whenever the pages come to rest.
 */
function IconDragLayer({ entries, folderTiles, iconSize, merging, switchStateOf, overlayRef, remeasureRef }: {
  entries: Entry[];
  // Held over an icon long enough to make a folder: the lifted icon eases down a little, ready to go in.
  merging: boolean;
  // The open folder's apps, which are dragged in the same context until they leave it.
  folderTiles: StudioHomeTile[];
  iconSize: number;
  switchStateOf: (tile: StudioHomeTile) => SwitchState | undefined;
  overlayRef: (node: HTMLElement | null) => void;
  remeasureRef: MutableRefObject<(() => void) | null>;
}) {
  const { active, measureDroppableContainers } = useDndContext();
  useEffect(() => {
    remeasureRef.current = () => measureDroppableContainers([]);
    return () => { remeasureRef.current = null; };
  }, [measureDroppableContainers, remeasureRef]);
  const inFolder = active ? folderTiles.find(tile => tile.id === active.id) : undefined;
  const entry: Entry | undefined = active ? entries.find(item => item.id === active.id) ?? (inFolder && { kind: 'tile', id: inFolder.id, tile: inFolder }) : undefined;
  // No dnd-kit drop animation: on drop the real icon glides from here into its slot (useHomeSortableList).
  return <DragOverlay dropAnimation={null} className="home-drag-overlay">
    {entry && <div ref={overlayRef} className={`home-tile-slot is-lifted ${merging ? 'is-merging' : ''}`} aria-hidden="true">
      <span className="home-tile">{entry.kind === 'tile'
        ? <TileFace tile={entry.tile} editing={false} iconSize={iconSize} switchState={switchStateOf(entry.tile)} />
        : <FolderFace name={entry.folder.name} tiles={entry.tiles} iconSize={iconSize} />}</span>
    </div>}
  </DragOverlay>;
}

/**
 * Used by StudioPage as the launcher: one large icon per project or app, plus + to create a project, on pages that
 * slide sideways under a fixed header like the iPadOS home screen (UIScrollView physics in useHomePager, an iOS
 * page control at the bottom). The first page holds the widgets and as many icons as fit without scrolling; the
 * rest flow onto later pages. A long press on any icon or widget enters edit mode (jiggling, drag to rearrange,
 * hide); an icon held at the screen's side turns the page, so it can move between pages, and the move buttons give
 * VoiceOver and Switch Control the same rearranging. An icon held over another makes a folder (StudioHomeFolder),
 * and in edit mode a tap on a name renames it in place (names sync across devices, homeLayout.ts). Icons an AI is
 * building dim under a progress ring (StudioBuildProgress); in edit mode they offer stop, and failed ones continue.
 * The AJ 出口 tile switches this device to the Tailscale exit node through two Shortcuts (useAjExit).
 */
export function StudioHomeScreen({ tiles, loading, covered, snr, onOpen, onOpenWidget, onOpenSettings, onCreate, onRefresh, onSignOut, refreshing, onBuildAction }: {
  tiles: StudioHomeTile[]; loading: boolean;
  // True while an app fully covers the home screen; widget polling pauses to save battery.
  covered: boolean;
  snr: StudioSnr | null;
  onOpen: (tile: StudioHomeTile, icon: DOMRect | null) => void;
  // A tapped widget opens its app (Claude and Codex open a new session in the workbench).
  onOpenWidget: (type: WidgetType, card: DOMRect) => void;
  // The gear in the corner opens Studio's settings, zooming out of the button.
  onOpenSettings: (origin: DOMRect) => void;
  onCreate: () => void; onRefresh: () => void; onSignOut: () => void; refreshing: boolean;
  // Stops a running AI build or continues a failed one (edit-mode buttons on tiles that carry `progress`).
  onBuildAction?: (tile: StudioHomeTile, action: 'stop' | 'resume') => void;
}) {
  const { isDarkMode, setThemeMode } = useTheme();
  // Layout choices are per device so an iPad and a MacBook can arrange tiles differently; Settings → 主屏幕 shares them.
  const [layout, updateLayout] = useHomeLayout();
  // Names typed under icons, the same on every device.
  const names = useHomeNames();
  // Edit mode jiggles tiles and widgets, lets them be dragged and exposes hide controls, as on the iPadOS home screen.
  const [editing, setEditing] = useState(false);
  // Edit mode winding down after 完成 or a tap beside the icons: the badges (icons' and widgets', with the widgets'
  // resize corners) and the edit bar shrink away and the page
  // dots glide home before those controls unmount (STUDIO_MOTION_OUT_MS); never under reduced motion.
  const [leavingEdit, setLeavingEdit] = useState(false);
  // The icon or folder whose name is being typed in place.
  const [renaming, setRenaming] = useState<string | null>(null);
  // The open folder and the rectangle of its icon, which it grows out of.
  const [openFolder, setOpenFolder] = useState<{ id: string; origin: DOMRect | null } | null>(null);
  // A folder shrinking back into its icon after it closed: what it showed, and where it goes.
  const [closingFolder, setClosingFolder] = useState<{ folder: HomeFolder; tiles: StudioHomeTile[]; origin: DOMRect | null } | null>(null);
  // An icon (or folder) of the home grid is being dragged: an empty page waits after the last one, to start a new page.
  const [iconDrag, setIconDrag] = useState(false);
  // The icon a dragged icon is held over, and whether it has been held long enough to make a folder on drop.
  const [merge, setMerge] = useState<{ id: string; ready: boolean } | null>(null);
  // The item whose slot the dragged icon has taken (the grid made room there). Kept as state, not only in the intent
  // ref, so a change re-renders the drag context and dnd-kit picks up the new drop target from the collision check.
  const [, setSortOver] = useState<string | null>(null);
  // A folder just made by a drop: it settles from the merge target's enlarged size.
  const [formedFolder, setFormedFolder] = useState<string | null>(null);
  // The app library sheet lists hidden apps and planned integrations.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // The widget gallery, opened from the edit-mode toolbar (a toolbar button never shifts the grid mid-drag).
  const [widgetGalleryOpen, setWidgetGalleryOpen] = useState(false);
  // How many icons each page holds, measured from the screen; it changes with the window, the widgets and the
  // icon size, none of which can be derived without layout. Null (one page) until measured.
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  // Counts size changes of the pages and the widgets, so the capacity is measured again (the sizes themselves are read
  // from the DOM, not kept).
  const [resizeCount, countResize] = useReducer((count: number) => count + 1, 0);
  // Where the widgets' drag overlay is portaled: outside the sliding pages (a callback ref, so widgets get the node).
  const [dragHost, setDragHost] = useState<HTMLDivElement | null>(null);
  // A new home screen fills again (its icons render after this, so they see it); see setHomeFilling.
  useState(() => { setHomeFilling(true); });
  const ajExit = useAjExit();
  // The library sheet plays its way out before it unmounts.
  const library = useSheetClose(() => setLibraryOpen(false));

  const homeRef = useRef<HTMLDivElement | null>(null);
  const widgetsRef = useRef<HTMLDivElement | null>(null);
  // Set while an icon or widget is dragged: the page split must not change under it.
  const dragging = useRef(false);
  // Re-measures where the icons are once the pages settle (dnd-kit's own measuring cannot see the track move).
  const remeasure = useRef<(() => void) | null>(null);
  // An icon held at the screen's side: which way, and the timer that turns the page.
  const edgeHold = useRef<{ direction: -1 | 1; timer: number } | null>(null);
  // A move button that was pressed; its icon may have moved to another page (a new node) and focus must follow.
  const pendingMoveFocus = useRef<{ id: string; step: -1 | 1 } | null>(null);
  // The merge state for drag handlers.
  const mergeRef = useRef<{ id: string; ready: boolean } | null>(null);
  // The home drag's intent (homeDragIntent.ts): which icon it is, where the pointer last was, what it means to do,
  // where the icons' slots were last measured (dnd-kit's droppable rects), where the icon card sits in a slot, and the
  // timer that re-evaluates when a dwell runs out with the pointer held still.
  const intentActive = useRef<string | null>(null);
  const intentPoint = useRef<{ x: number; y: number } | null>(null);
  const intentRef = useRef<HomeDragIntent | null>(null);
  const slotRects = useRef<ReadonlyMap<unknown, DragRect> | null>(null);
  const iconBox = useRef<(rect: DragRect) => DragRect>(measureIconBox(null));
  const intentTimer = useRef<number | undefined>(undefined);
  // The latest evaluateIntent, for handlers and timers made before it.
  const evaluateIntentRef = useRef<() => void>(() => {});
  const formedTimer = useRef<number | undefined>(undefined);
  // Which list the dragged icon belongs to now: the open folder's, or the home grid's (after it left the folder).
  const dragSource = useRef<'home' | 'folder' | null>(null);
  // The open folder's panel, and the timer that takes an icon held beyond it out of the folder.
  const folderPanelRef = useRef<HTMLDivElement | null>(null);
  const folderExitTimer = useRef<number | undefined>(undefined);
  const folderCloseTimer = useRef<number | undefined>(undefined);

  useEffect(() => { if (!loading) setHomeFilling(false); }, [loading]);
  const leaveEditTimer = useRef<number | undefined>(undefined);
  const endEditing = useCallback(() => {
    setEditing(false);
    setRenaming(null);
    window.clearTimeout(leaveEditTimer.current);
    if (prefersReducedMotion()) return;
    settleJiggle(homeRef.current);
    setLeavingEdit(true);
    leaveEditTimer.current = window.setTimeout(() => setLeavingEdit(false), STUDIO_MOTION_OUT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(leaveEditTimer.current), []);

  const switchStateOf = useCallback((tile: StudioHomeTile): SwitchState | undefined => tile.id === STUDIO_AJ_EXIT_TILE_ID ? (ajExit.on ? 'on' : 'off') : undefined, [ajExit.on]);
  // Typed names replace the default ones; AJ 出口 shows what this device last asked for under its name.
  const shownTiles = useMemo(() => tiles.map(tile => {
    const named = names[tile.id] ? { ...tile, name: names[tile.id] } : tile;
    return tile.id === STUDIO_AJ_EXIT_TILE_ID ? { ...named, status: ajExit.on ? '已开启' : '未开启' } : named;
  }), [tiles, names, ajExit.on]);
  const defaultNameOf = useCallback((id: string) => tiles.find(tile => tile.id === id)?.name ?? id, [tiles]);
  const hiddenIds = useMemo(() => new Set(layout.hidden), [layout.hidden]);

  // The grid: apps outside folders and folders with something to show, in this device's order.
  const entries = useMemo<Entry[]>(() => {
    const byId = new Map(shownTiles.map(tile => [tile.id, tile]));
    const inFolders = new Set(layout.folders.flatMap(folder => folder.items));
    const folders = layout.folders.map(folder => ({
      kind: 'folder' as const, id: folderEntryId(folder), folder,
      tiles: folder.items.map(id => byId.get(id)).filter((tile): tile is StudioHomeTile => Boolean(tile) && !hiddenIds.has(tile!.id)),
    // While projects load, a folder of projects is kept in place rather than vanishing and coming back.
    })).filter(entry => entry.tiles.length > 0 || loading);
    const apps = shownTiles.filter(tile => !hiddenIds.has(tile.id) && !inFolders.has(tile.id)).map(tile => ({ kind: 'tile' as const, id: tile.id, tile }));
    return orderById<Entry>([...apps, ...folders], layout.order);
  }, [shownTiles, layout.folders, layout.order, hiddenIds, loading]);
  const hidden = shownTiles.filter(tile => hiddenIds.has(tile.id));

  // Apps that no longer exist (a deleted project) leave their folders once the projects have loaded; an empty folder goes.
  useEffect(() => {
    if (loading) return;
    const known = new Set(tiles.map(tile => tile.id));
    if (layout.folders.every(folder => folder.items.length && folder.items.every(id => known.has(id)))) return;
    updateLayout(previous => {
      const folders = previous.folders.map(folder => ({ ...folder, items: folder.items.filter(id => known.has(id)) })).filter(folder => folder.items.length);
      const kept = new Set(folders.map(folderEntryId));
      return { ...previous, folders, ...(previous.order ? { order: previous.order.filter(id => !isFolderId(id) || kept.has(id)) } : {}) };
    });
  }, [layout.folders, loading, tiles, updateLayout]);

  // Icons, then the 新建 tile, split into pages.
  // Icons, then the 新建 tile, split into pages (an icon dropped on a new page begins it).
  const breakIndexes = useMemo(() => {
    const breaks = new Set(layout.pageBreaks ?? []);
    return entries.flatMap((entry, index) => breaks.has(entry.id) ? [index] : []);
  }, [entries, layout.pageBreaks]);
  const ranges = useMemo(() => pageRanges(entries.length + 1, capacity?.first ?? null, capacity?.page ?? 1, breakIndexes), [entries.length, capacity, breakIndexes]);
  // While an icon is dragged, an empty page waits after the last: held at the screen's side, the icon goes there.
  const newPageIndex = iconDrag ? ranges.length : null;
  const pageCount = ranges.length + (iconDrag ? 1 : 0);
  // An open folder (one that still exists) has the screen; the arrow keys leave the pages alone meanwhile.
  const folderShown = Boolean(openFolder && entries.some(entry => entry.id === openFolder.id));
  // Once the pages come to rest the icons are measured again, and a held drag looks again at what is under it now.
  const onPagesSettle = () => {
    remeasure.current?.();
    requestAnimationFrame(() => { if (intentActive.current) evaluateIntentRef.current(); });
  };
  const pager = useHomePager({ pageCount, keyboard: !covered && !folderShown, onSettle: onPagesSettle });
  const { goTo, setGestureBlocked, turn, viewportRef } = pager;

  const setMergeState = useCallback((next: { id: string; ready: boolean } | null) => {
    mergeRef.current = next;
    setMerge(next);
  }, []);
  const clearMerge = useCallback(() => {
    if (mergeRef.current) setMergeState(null);
  }, [setMergeState]);
  useEffect(() => () => {
    window.clearTimeout(intentTimer.current);
    window.clearTimeout(formedTimer.current);
  }, []);

  const stopEdgeHold = useCallback(() => {
    if (edgeHold.current) window.clearTimeout(edgeHold.current.timer);
    edgeHold.current = null;
  }, []);
  const setDragActive = useCallback((active: boolean) => {
    dragging.current = active;
    setGestureBlocked(active);
    if (!active) {
      stopEdgeHold();
      // The page split held still during the drag; anything that resized meanwhile is measured now.
      countResize();
    }
  }, [setGestureBlocked, stopEdgeHold]);
  // Holding a dragged icon at a side of the screen turns the page that way, and keeps turning while it stays.
  const holdAtEdge = useCallback((direction: -1 | 0 | 1) => {
    if (edgeHold.current?.direction === direction) return;
    stopEdgeHold();
    if (!direction) return;
    const schedule = (delay: number) => {
      edgeHold.current = { direction, timer: window.setTimeout(() => { if (turn(direction)) schedule(EDGE_REPEAT_MS); }, delay) };
    };
    schedule(EDGE_HOLD_MS);
  }, [stopEdgeHold, turn]);
  const onDragMove = useCallback((event: DragMoveEvent) => {
    const viewport = viewportRef.current;
    const point = pointerOf(event);
    // Keyboard drags stay on the visible page (see useHomeSortableList's visibleArea); the move buttons cross pages.
    if (!viewport || !point) return;
    const box = viewport.getBoundingClientRect();
    if (box.width > 0) holdAtEdge(point.x < box.left + EDGE_ZONE_PX ? -1 : point.x > box.right - EDGE_ZONE_PX ? 1 : 0);
    intentPoint.current = point;
    evaluateIntentRef.current();
  }, [holdAtEdge, viewportRef]);
  useEffect(() => stopEdgeHold, [stopEdgeHold]);
  const visibleArea = useCallback(() => viewportRef.current?.getBoundingClientRect() ?? null, [viewportRef]);

  const entryIds = useMemo(() => entries.map(entry => entry.id), [entries]);

  // ---- The drag's intent: merge into the icon under it, or make room (homeDragIntent.ts) ----
  // What the intent functions look at for `point` now: the grid's slots as dnd-kit last measured them, on the page in
  // view. Null until there is something measured.
  const intentInput = (activeId: string, point: { x: number; y: number }): HomeDragInput | null => {
    const rects = slotRects.current;
    if (!rects) return null;
    const slots = new Map<string, DragRect>();
    for (const id of entryIds) {
      const rect = rects.get(id);
      if (rect && rect.width > 0) slots.set(id, rect);
    }
    const bounds = visibleArea();
    return {
      now: Date.now(), point, activeId, ids: entryIds, slots, iconOf: iconBox.current,
      inView: bounds && bounds.width > 0 ? slot => slot.left + slot.width / 2 >= bounds.left && slot.left + slot.width / 2 <= bounds.right : undefined,
      // Apps go into apps and folders; folders themselves never go into anything.
      canMerge: () => !isFolderId(activeId),
    };
  };
  const startIntent = (activeId: string, slot: Element | null) => {
    window.clearTimeout(intentTimer.current);
    intentActive.current = activeId;
    intentPoint.current = null;
    intentRef.current = initialDragIntent(activeId);
    iconBox.current = measureIconBox(slot);
  };
  const stopIntent = () => {
    window.clearTimeout(intentTimer.current);
    intentActive.current = null;
    intentPoint.current = null;
    intentRef.current = null;
  };
  // Moves the intent on from where the pointer is, shows what it means (the target holding still and growing a
  // folder's backdrop, the grid making room) and comes back when a dwell runs out with the pointer held still.
  const evaluateIntent = () => {
    const activeId = intentActive.current;
    const point = intentPoint.current;
    window.clearTimeout(intentTimer.current);
    if (!activeId || !point) return;
    const previous = intentRef.current ?? initialDragIntent(activeId);
    const input = intentInput(activeId, point);
    if (!input) return;
    const next = nextDragIntent(previous, input);
    intentRef.current = next;
    if (next.overId !== previous.overId) setSortOver(next.overId);
    const shown = next.merge ? { id: next.merge.id, ready: next.merge.ready } : null;
    if (shown?.id !== mergeRef.current?.id || shown?.ready !== mergeRef.current?.ready) setMergeState(shown);
    const wakeAt = dragIntentWakeAt(next);
    if (wakeAt !== null) intentTimer.current = window.setTimeout(() => evaluateIntentRef.current(), Math.max(0, wakeAt - Date.now()) + 1);
  };
  useLayoutEffect(() => { evaluateIntentRef.current = evaluateIntent; });
  const enterEdit = useCallback(() => {
    window.clearTimeout(leaveEditTimer.current);
    setLeavingEdit(false);
    setEditing(true);
  }, []);
  // Names for the drag announcements: the home grid's entries, and the apps inside the open folder.
  const labelOf = useCallback((id: string) => {
    const entry = entries.find(item => item.id === id);
    if (entry) return entry.kind === 'tile' ? entry.tile.name : `文件夹「${entry.folder.name}」`;
    return shownTiles.find(tile => tile.id === id)?.name ?? id;
  }, [entries, shownTiles]);
  const reorder = useCallback((ids: string[]) => updateLayout(previous => {
    // Hidden apps keep their place after the visible ones, so the saved order always covers every item.
    const placed = new Set(ids);
    return { ...previous, order: [...ids, ...topLevelOrder(previous, tiles).filter(id => !placed.has(id))] };
  }), [tiles, updateLayout]);

  // An app dropped on another makes a folder of the two in the other's place; dropped on a folder, it joins it. A
  // page the dragged app began is begun by the app after it; a page its target began is begun by the new folder.
  // The folder it went into settles from the merge target's enlarged size (studio-home.css, .is-folder-formed).
  const mergeInto = (activeId: string, targetId: string) => {
    const folderId = isFolderId(targetId) ? targetId.slice(HOME_FOLDER_PREFIX.length) : newFolderId();
    window.clearTimeout(formedTimer.current);
    setFormedFolder(`${HOME_FOLDER_PREFIX}${folderId}`);
    formedTimer.current = window.setTimeout(() => setFormedFolder(null), FOLDER_FORM_MS);
    updateLayout(previous => {
      const order = topLevelOrder(previous, tiles);
      const breaks = releasePageBreak(previous.pageBreaks, entryIds, activeId);
      if (isFolderId(targetId)) {
        return {
          ...previous, order: order.filter(id => id !== activeId),
          folders: previous.folders.map(folder => folder.id === folderId ? { ...folder, items: [...folder.items.filter(id => id !== activeId), activeId] } : folder),
          pageBreaks: tidyPageBreaks(breaks, entryIds.filter(id => id !== activeId)),
        };
      }
      const folder: HomeFolder = { id: folderId, name: folderNameFor([targetId, activeId]), items: [targetId, activeId] };
      const inPlace = (id: string) => id === targetId ? [folderEntryId(folder)] : id === activeId ? [] : [id];
      return {
        ...previous, folders: [...previous.folders, folder], order: order.flatMap(inPlace),
        pageBreaks: tidyPageBreaks(breaks.flatMap(inPlace), entryIds.flatMap(inPlace)),
      };
    });
  };
  // Dropped on the empty page after the last, an icon goes to the end and begins that page, as on iPadOS.
  const placeOnNewPage = useCallback((activeId: string) => updateLayout(previous => {
    const breaks = releasePageBreak(previous.pageBreaks, entryIds, activeId);
    const order = topLevelOrder(previous, tiles).filter(id => id !== activeId);
    return {
      ...previous, order: [...order, activeId],
      pageBreaks: tidyPageBreaks([...breaks, activeId], [...entryIds.filter(id => id !== activeId), activeId]),
    };
  }), [entryIds, tiles, updateLayout]);
  // A drop from a pointer lands where homeDragIntent says (into a folder, or where the finger is); a keyboard drop
  // goes where dnd-kit moved it. Either way the pages' first icons follow a move.
  const interceptDrop = (event: DragEndEvent) => {
    clearMerge();
    const activeId = String(event.active.id);
    if (newPageIndex !== null && pager.page === newPageIndex) { placeOnNewPage(activeId); return true; }
    const point = pointerOf(event);
    const intent = intentRef.current;
    const input = point && intent ? intentInput(activeId, point) : null;
    const drop = intent && input ? resolveDrop(intent, input) : null;
    if (drop?.kind === 'merge') {
      mergeInto(activeId, drop.id);
      return true;
    }
    const overId = drop ? drop.overId : event.over ? String(event.over.id) : null;
    const from = entryIds.indexOf(activeId);
    const to = overId ? entryIds.indexOf(overId) : -1;
    const moves = overId !== null && from >= 0 && to >= 0 && from !== to;
    if (moves && layout.pageBreaks?.length) {
      updateLayout(previous => ({ ...previous, pageBreaks: tidyPageBreaks(movePageBreaks(previous.pageBreaks, entryIds, activeId, overId), arrayMove(entryIds, from, to)) }));
    }
    if (!drop) return false;
    if (moves) reorder(arrayMove(entryIds, from, to));
    return true;
  };

  const { containerRef, overlayRef, glide, move, moveMessage, dndProps, sortableProps } = useHomeSortableList({
    ids: entryIds, editing, onEnterEdit: enterEdit, onReorder: reorder, labelOf, onDragActiveChange: setDragActive, visibleArea, interceptDrop,
  });
  const moveEntry = (id: string, step: -1 | 1) => { pendingMoveFocus.current = { id, step }; move(id, step); };
  // The track holds every page, so it is both what slides and where the list's drop glide finds the icons.
  const { trackRef } = pager;
  const setTrack = useCallback((node: HTMLDivElement | null) => {
    trackRef.current = node;
    containerRef.current = node;
  }, [containerRef, trackRef]);

  // ---- Folders: open, rename, take apps out, dissolve ----
  const openFolderEntry = entries.find((entry): entry is Extract<Entry, { kind: 'folder' }> => entry.kind === 'folder' && entry.id === openFolder?.id);
  const folderTiles = openFolderEntry?.tiles ?? NO_TILES;
  const folderTileIds = useMemo(() => folderTiles.map(tile => tile.id), [folderTiles]);
  // A closing folder shrinks back into its icon (where it is now, or where it opened from) before it goes.
  const shrinkFolder = useCallback((entry: Extract<Entry, { kind: 'folder' }>, tilesLeft: StudioHomeTile[]) => {
    const icon = viewportRef.current?.querySelector<HTMLElement>(`[data-sort-id="${cssEscape(entry.id)}"] .home-icon`);
    const box = icon?.getBoundingClientRect();
    window.clearTimeout(folderCloseTimer.current);
    setClosingFolder({ folder: entry.folder, tiles: tilesLeft, origin: box && box.width > 0 ? box : openFolder?.origin ?? null });
    folderCloseTimer.current = window.setTimeout(() => setClosingFolder(null), STUDIO_MOTION_OUT_MS);
    setOpenFolder(null);
  }, [openFolder, viewportRef]);
  useEffect(() => () => window.clearTimeout(folderCloseTimer.current), []);
  const closeFolder = useCallback(() => {
    const id = openFolder?.id;
    if (openFolderEntry) shrinkFolder(openFolderEntry, openFolderEntry.tiles);
    else setOpenFolder(null);
    // Focus returns to the folder's icon, as it does when a sheet closes.
    requestAnimationFrame(() => viewportRef.current?.querySelector<HTMLElement>(`[data-sort-id="${cssEscape(id ?? '')}"] .home-tile`)?.focus({ preventScroll: true }));
  }, [openFolder, openFolderEntry, shrinkFolder, viewportRef]);
  const renameFolder = (folderId: string, name: string) => {
    const cleaned = cleanHomeName(name);
    if (!cleaned) return;
    updateLayout(previous => ({ ...previous, folders: previous.folders.map(folder => folderEntryId(folder) === folderId ? { ...folder, name: cleaned } : folder) }));
  };
  // An app taken out of a folder goes back to the home screen right after the folder; an emptied folder goes (and its
  // app begins the page if the folder did).
  const takeOutOfFolder = (folderId: string, tileId: string) => (previous: HomeLayout): HomeLayout => {
    const order = topLevelOrder(previous, tiles);
    const folders = previous.folders.map(folder => folderEntryId(folder) === folderId ? { ...folder, items: folder.items.filter(id => id !== tileId) } : folder);
    const emptied = folders.some(folder => folderEntryId(folder) === folderId && !folder.items.length);
    return {
      ...previous, folders: folders.filter(folder => folder.items.length),
      order: order.flatMap(id => id === folderId ? (emptied ? [tileId] : [id, tileId]) : id === tileId ? [] : [id]),
      ...(emptied && previous.pageBreaks?.includes(folderId) ? { pageBreaks: previous.pageBreaks.map(id => id === folderId ? tileId : id) } : {}),
    };
  };
  const moveOutOfFolder = (folderId: string, tileId: string) => glide(() => updateLayout(takeOutOfFolder(folderId, tileId)));
  // Dissolving a folder puts its apps back in its place, in its order.
  const dissolveFolder = (folderId: string) => glide(() => updateLayout(previous => {
    const folder = previous.folders.find(item => folderEntryId(item) === folderId);
    if (!folder) return previous;
    const order = topLevelOrder(previous, tiles);
    return {
      ...previous, folders: previous.folders.filter(item => item !== folder), order: order.flatMap(id => id === folderId ? folder.items : [id]),
      ...(previous.pageBreaks?.includes(folderId) ? { pageBreaks: previous.pageBreaks.map(id => id === folderId ? folder.items[0] : id) } : {}),
    };
  }));
  const reorderFolder = (folderId: string, ids: string[]) => updateLayout(previous => ({
    ...previous, folders: previous.folders.map(folder => folderEntryId(folder) === folderId ? { ...folder, items: ids } : folder),
  }));

  // ---- One drag context for the home grid and the open folder, so an icon can leave the folder mid-drag ----
  // Dropped beyond the panel before the folder closed (a quick throw), an icon still leaves the folder.
  const folderInterceptDrop = (event: DragEndEvent) => {
    const point = pointerOf(event);
    const box = folderPanelRef.current?.getBoundingClientRect();
    if (!point || !box || !openFolderEntry) return false;
    if (point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom) return false;
    moveOutOfFolder(openFolderEntry.id, String(event.active.id));
    return true;
  };
  const folderList = useHomeSortableList({
    ids: folderTileIds, editing, onEnterEdit: enterEdit, labelOf, onDragActiveChange: setDragActive, interceptDrop: folderInterceptDrop,
    onReorder: ids => { if (openFolderEntry) reorderFolder(openFolderEntry.id, ids); },
  });
  const { containerRef: folderContainerRef, overlayRef: folderOverlayRef } = folderList;
  const folderGridRef = useCallback((node: HTMLDivElement | null) => { folderContainerRef.current = node; }, [folderContainerRef]);
  const folderSortable: FolderSortable = { gridRef: folderGridRef, sortableProps: folderList.sortableProps, move: folderList.move, moveMessage: folderList.moveMessage };
  // One lifted copy serves both lists: whichever owns the icon at the drop glides it down from there.
  const setOverlay = useCallback((node: HTMLElement | null) => {
    overlayRef.current = node;
    folderOverlayRef.current = node;
  }, [folderOverlayRef, overlayRef]);

  const stopFolderExit = useCallback(() => {
    window.clearTimeout(folderExitTimer.current);
    folderExitTimer.current = undefined;
  }, []);
  useEffect(() => stopFolderExit, [stopFolderExit]);
  // An icon held beyond the folder's panel leaves it: the folder shrinks away and the drag carries on over the home
  // screen, the icon placed right after the folder until it is dropped where the finger takes it (another page, a
  // new one at the end, another folder).
  const leaveFolder = (activeId: string) => {
    folderExitTimer.current = undefined;
    const entry = openFolderEntry;
    if (dragSource.current !== 'folder' || !entry) return;
    dragSource.current = 'home';
    setIconDrag(true);
    startIntent(activeId, null);
    shrinkFolder(entry, entry.tiles.filter(tile => tile.id !== activeId));
    updateLayout(takeOutOfFolder(entry.id, activeId));
  };
  const leaveFolderRef = useRef(leaveFolder);
  useLayoutEffect(() => { leaveFolderRef.current = leaveFolder; });
  const watchFolderExit = useCallback((event: DragMoveEvent) => {
    const point = pointerOf(event);
    const box = folderPanelRef.current?.getBoundingClientRect();
    if (!point || !box || box.width <= 0) return;
    const outside = point.x < box.left - FOLDER_EXIT_MARGIN_PX || point.x > box.right + FOLDER_EXIT_MARGIN_PX
      || point.y < box.top - FOLDER_EXIT_MARGIN_PX || point.y > box.bottom + FOLDER_EXIT_MARGIN_PX;
    if (!outside) { stopFolderExit(); return; }
    if (folderExitTimer.current !== undefined) return;
    const id = String(event.active.id);
    folderExitTimer.current = window.setTimeout(() => leaveFolderRef.current(id), FOLDER_EXIT_HOLD_MS);
  }, [stopFolderExit]);

  // Each list finds drop targets among its own icons only (the home grid's lie under an open folder). A pointer drag
  // on the home grid goes where its intent has made room (homeDragIntent.ts), so an icon under the finger never dodges
  // aside before it is meant to; keyboard drags and the open folder use the nearest centre.
  const homeCollision = dndProps.collisionDetection;
  const folderCollision = folderList.dndProps.collisionDetection;
  const collisionDetection = useCallback<CollisionDetection>(args => {
    const inFolder = dragSource.current === 'folder';
    const scope = new Set(inFolder ? folderTileIds : entryIds);
    const droppableContainers = args.droppableContainers.filter(container => scope.has(String(container.id)));
    if (inFolder) return folderCollision({ ...args, droppableContainers });
    // The slots as dnd-kit measured them, for the intent (a ref, not state: this runs while the context renders).
    slotRects.current = args.droppableRects;
    const overId = args.pointerCoordinates ? intentRef.current?.overId : undefined;
    const container = overId === undefined ? undefined : droppableContainers.find(item => String(item.id) === overId);
    if (container) return [{ id: container.id, data: { droppableContainer: container, value: 0 } }];
    return homeCollision({ ...args, droppableContainers });
  }, [entryIds, folderCollision, folderTileIds, homeCollision]);
  const endIconDrag = () => {
    dragSource.current = null;
    stopFolderExit();
    stopIntent();
    setIconDrag(false);
  };
  const listOf = (source: typeof dragSource.current) => source === 'folder' ? folderList.dndProps : dndProps;
  const dndHandlers = {
    sensors: dndProps.sensors, autoScroll: dndProps.autoScroll, accessibility: dndProps.accessibility, collisionDetection,
    onDragStart: (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      const fromFolder = folderTileIds.includes(activeId);
      dragSource.current = fromFolder ? 'folder' : 'home';
      if (!fromFolder) {
        setIconDrag(true);
        startIntent(activeId, viewportRef.current?.querySelector(`[data-sort-id="${cssEscape(activeId)}"]`) ?? null);
      }
      listOf(dragSource.current).onDragStart(event);
    },
    onDragMove: (event: DragMoveEvent) => { if (dragSource.current === 'folder') watchFolderExit(event); else onDragMove(event); },
    // The list's drop (and interceptDrop inside it) still reads the intent, so the drag's state is cleared after it.
    onDragEnd: (event: DragEndEvent) => {
      const source = dragSource.current;
      listOf(source).onDragEnd(event);
      endIconDrag();
    },
    onDragCancel: (event: DragCancelEvent) => {
      const source = dragSource.current;
      endIconDrag();
      clearMerge();
      listOf(source).onDragCancel(event);
    },
  };

  // Fit the icons to the pages whenever something that sizes them changes: the screen or the widgets (counted by the
  // observer below), the icon size and labels, or the icons themselves (a status line adds height). A screen that is
  // hidden or mid-transition (a web app sent to the background while Shortcuts runs) is not measured, and a reading
  // that finds nothing to measure never replaces a good one: either would put every icon on one scrolling page.
  // A screen that only briefly got shorter (Spotlight or a keyboard over the web app, iOS settling after an app
  // switch) moves nothing: fewer icons per page counts only once the size has held for VIEWPORT_SETTLE_MS, so the
  // icons stay mounted where they are and nothing flashes when it comes back. A change that does land (a real resize,
  // larger icons) glides every icon from where it was to its new place, across pages too.
  const measuredStyle = useRef(`${layout.large}|${layout.labels}`);
  const shrinkTimer = useRef<number | undefined>(undefined);
  const fitPages = (confirmed: boolean) => {
    const home = homeRef.current;
    const viewport = viewportRef.current;
    window.clearTimeout(shrinkTimer.current);
    if (!home || !viewport || dragging.current) return;
    if (document.visibilityState === 'hidden' || viewport.clientHeight < MIN_MEASURABLE_HEIGHT_PX) return;
    const next = measureCapacity(home, viewport, widgetsRef.current);
    const current = capacity;
    if ((next === null && current !== null && entries.length > 0) || sameCapacity(current, next)) return;
    const style = `${layout.large}|${layout.labels}`;
    const restyled = style !== measuredStyle.current;
    measuredStyle.current = style;
    const shrinks = current !== null && next !== null && (next.first < current.first || next.page < current.page);
    if (shrinks && !restyled && !confirmed) {
      shrinkTimer.current = window.setTimeout(() => fitPagesRef.current(true), VIEWPORT_SETTLE_MS);
      return;
    }
    if (current === null) setCapacity(next);
    else glide(() => setCapacity(next));
  };
  // The latest fitPages, for the settle timer.
  const fitPagesRef = useRef<(confirmed: boolean) => void>(() => {});
  useLayoutEffect(() => { fitPagesRef.current = fitPages; });
  useLayoutEffect(() => { fitPages(false); }, [layout.large, layout.labels, loading, resizeCount, viewportRef, entries]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearTimeout(shrinkTimer.current), []);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => countResize());
    observer.observe(viewport);
    if (widgetsRef.current) observer.observe(widgetsRef.current);
    return () => observer.disconnect();
  }, [viewportRef]);
  // Coming back to the page (from Shortcuts, another app, a locked screen) re-measures once the viewport has settled.
  useEffect(() => {
    let timer: number | undefined;
    const settle = () => {
      if (document.visibilityState === 'hidden') return;
      requestAnimationFrame(() => requestAnimationFrame(() => countResize()));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => countResize(), SETTLE_REMEASURE_MS);
    };
    document.addEventListener('visibilitychange', settle);
    window.addEventListener('pageshow', settle);
    window.addEventListener('orientationchange', settle);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', settle);
      window.removeEventListener('pageshow', settle);
      window.removeEventListener('orientationchange', settle);
    };
  }, []);

  // A move button whose icon changed page: focus its button on the new page, which brings that page into view.
  useLayoutEffect(() => {
    const pending = pendingMoveFocus.current;
    const viewport = viewportRef.current;
    if (!pending || !viewport) return;
    pendingMoveFocus.current = null;
    const button = Array.from(viewport.querySelectorAll<HTMLElement>('[data-move-id]'))
      .find(node => node.dataset.moveId === pending.id && node.dataset.moveStep === String(pending.step));
    if (button && document.activeElement !== button) button.focus({ preventScroll: true });
  });

  const activateTile = (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => {
    // In edit mode a tap never opens an app (the click that ends a long press is swallowed before it gets here): a tap
    // on the name renames it, and AJ 出口 opens its settings, the way iPadOS configures a widget tapped while jiggling.
    if (editing) {
      event.preventDefault();
      if ((event.target as Element).closest('.home-label')) setRenaming(tile.id);
      else if (tile.id === STUDIO_AJ_EXIT_TILE_ID) ajExit.openSheet();
      return;
    }
    if (tile.id === STUDIO_AJ_EXIT_TILE_ID) { ajExit.tap(); return; }
    if (tile.href) return;
    const icon = event.currentTarget.querySelector('.home-icon');
    if (openFolder) setOpenFolder(null);
    onOpen(tile, icon ? icon.getBoundingClientRect() : null);
  };
  const activateFolder = (entry: Extract<Entry, { kind: 'folder' }>, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (editing && (event.target as Element).closest('.home-label')) { setRenaming(entry.id); return; }
    const icon = event.currentTarget.querySelector('.home-icon');
    setOpenFolder({ id: entry.id, origin: icon ? icon.getBoundingClientRect() : null });
  };
  const leaveEditOnEmptyTap = (event: MouseEvent<HTMLDivElement>) => {
    if (editing && !(event.target as Element).closest(KEEPS_EDITING)) endEditing();
  };
  const renameEntry = (entry: Entry, name: string | null) => {
    setRenaming(null);
    if (name === null) return;
    if (entry.kind === 'tile') writeHomeName(entry.id, name, defaultNameOf(entry.id));
    else renameFolder(entry.id, name);
  };
  const today = new Date();
  // The glyph is half the card, as in the approved design (92 px card, 124 px large).
  const iconSize = layout.large ? 62 : 46;

  // One page control, which moves between the foot of the screen and the edit bar (a shared layout, so it glides).
  const pageControl = pageCount > 1 && <m.div layoutId="home-page-control" layout="position" transition={PAGE_CONTROL_MOVE}
    className={`home-page-control ${pager.lit ? 'is-lit' : ''}`} role="group" aria-label="主屏幕页面">
    {Array.from({ length: pageCount }, (_, index) => <button type="button" key={index} aria-label={`第 ${index + 1} 页`} aria-current={index === pager.page ? 'true' : undefined}
      onClick={() => goTo(index)}><i aria-hidden="true" /></button>)}
  </m.div>;

  const renderEntry = (entry: Entry, position: number) => {
    const merging = merge?.id === entry.id;
    const shared = {
      id: entry.id, index: position, last: position === entries.length - 1, editing, leavingEdit, renaming: renaming === entry.id,
      // An icon another is held over stops still, then grows a folder's backdrop once the hold is long enough; the
      // folder a drop just made (or filled) settles back from that size.
      slotClass: merging ? `is-merge-target ${merge.ready ? 'is-merge-ready' : ''}` : formedFolder === entry.id ? 'is-folder-formed' : '',
      onMove: (step: -1 | 1) => moveEntry(entry.id, step), onRenameStart: () => setRenaming(entry.id), onRename: (name: string | null) => renameEntry(entry, name),
    };
    if (entry.kind === 'folder') {
      const { folder } = entry;
      return <SortableEntry key={entry.id} {...shared} name={folder.name} defaultName={folder.name} label={`文件夹「${folder.name}」，${entry.tiles.length} 个应用`}
        title={layout.labels ? undefined : folder.name}
        face={<FolderFace name={folder.name} tiles={entry.tiles} iconSize={iconSize} merging={merging && merge.ready} />}
        badge={{ kind: 'dissolve', label: `解散文件夹「${folder.name}」`, onClick: () => dissolveFolder(entry.id) }}
        onActivate={event => activateFolder(entry, event)} />;
    }
    const { tile } = entry;
    const progress = tile.progress;
    const status = progress ? buildStatusText(progress) : tile.status;
    // A build in progress can be stopped from edit mode (in place of hiding it); a failed one can be continued.
    const buildRunning = progress?.state === 'queued' || progress?.state === 'building';
    return <SortableEntry key={entry.id} {...shared} name={tile.name} defaultName={defaultNameOf(tile.id)} label={`${tile.name}${status ? `，${status}` : ''}`}
      title={layout.labels ? undefined : tile.name} href={tile.href}
      face={<TileFace tile={tile} editing={editing} iconSize={iconSize} switchState={switchStateOf(tile)} />}
      badge={buildRunning && onBuildAction
        ? { kind: 'stop', label: `停止开发 ${tile.name}`, onClick: () => onBuildAction(tile, 'stop') }
        : { kind: 'hide', label: `从主屏幕隐藏 ${tile.name}`, onClick: () => glide(() => updateLayout(previous => ({
          ...previous, hidden: [...previous.hidden, tile.id],
          pageBreaks: tidyPageBreaks(releasePageBreak(previous.pageBreaks, entryIds, tile.id), entryIds.filter(id => id !== tile.id)),
        }))) }}
      onResume={progress?.state === 'failed' && onBuildAction ? () => onBuildAction(tile, 'resume') : undefined}
      onActivate={event => activateTile(tile, event)} />;
  };

  const renderPage = (range: { start: number; end: number }, index: number) => {
    const entriesHere = entries.slice(range.start, Math.min(range.end, entries.length));
    const holdsAdd = range.start <= entries.length && entries.length < range.end;
    return <section key={index} className="home-page" data-home-page={index} aria-label={pageCount > 1 ? `第 ${index + 1} 页，共 ${pageCount} 页` : undefined}>
      {index === 0 && <div className="home-widgets-slot" ref={widgetsRef}>
        <StudioWidgets editing={editing} leavingEdit={leavingEdit} snr={snr} paused={covered} onEnterEdit={enterEdit} onOpen={onOpenWidget}
          galleryOpen={widgetGalleryOpen} onGalleryClose={() => setWidgetGalleryOpen(false)} overlayContainer={dragHost} onDragActiveChange={setDragActive} />
      </div>}
      <nav className="home-grid" aria-label={index === 0 ? '应用' : `应用（第 ${index + 1} 页）`} aria-busy={index === 0 ? loading : undefined}>
        {entriesHere.map((entry, offset) => renderEntry(entry, range.start + offset))}
        {index === 0 && loading && !entries.length && [0, 1, 2].map(placeholder => <div className="home-tile-slot" key={`placeholder-${placeholder}`} aria-hidden="true"><span className="home-tile placeholder"><span className="home-icon tone-ghost" /></span></div>)}
        {holdsAdd && <div className="home-tile-slot">
          <AddTile index={entries.length} large={layout.large} labels={layout.labels} onCreate={onCreate} />
        </div>}
      </nav>
    </section>;
  };
  // The empty page an icon can be dropped on to begin a new page; it is there only during a drag.
  const newPage = newPageIndex !== null && <section key="new-page" className="home-page is-new-page" data-home-page={newPageIndex} aria-label={`新的一页（第 ${newPageIndex + 1} 页）`}>
    <div className="home-grid" />
  </section>;

  return <div ref={homeRef} className={`home-screen ${layout.large ? 'large-icons' : ''} ${layout.labels ? '' : 'no-labels'} ${editing ? 'editing' : ''} ${leavingEdit ? 'edit-leaving' : ''}`} onClick={leaveEditOnEmptyTap}>
    <StudioFluidBackground dark={isDarkMode} paused={covered} />
    <header className="home-top">
      <div className="home-date">
        <span className="home-weekday">{new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Europe/London' }).format(today)}</span>
        <h1>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Europe/London' }).format(today)}</h1>
      </div>
      <div className="home-actions">
        {editing ? <>
          <button type="button" className="glass-button home-action-compact" aria-label="添加小组件" title="添加小组件" onClick={() => setWidgetGalleryOpen(true)}><IconPlus size={17} aria-hidden="true" /><span className="studio-wide-only">小组件</span></button>
          <button type="button" className="glass-button home-action-compact" aria-label="资源库" title="App 资源库" onClick={() => setLibraryOpen(true)}><IconLayoutGrid size={17} aria-hidden="true" /><span className="studio-wide-only">资源库</span></button>
          <button type="button" className="glass-button strong" onClick={endEditing}><IconCheck size={17} aria-hidden="true" />完成</button>
        </> : <>
          <button type="button" className="glass-icon theme-toggle" aria-label={isDarkMode ? '切换到浅色模式' : '切换到深色模式'} title={isDarkMode ? '浅色模式' : '深色模式'}
            onClick={event => revealTheme(() => setThemeMode(isDarkMode ? 'light' : 'dark'), event.currentTarget)}>
            {isDarkMode ? <IconSun size={18} aria-hidden="true" /> : <IconMoon size={18} aria-hidden="true" />}</button>
          <button type="button" className={`glass-icon ${refreshing ? 'refreshing' : ''}`} aria-label="刷新状态" title="刷新状态" disabled={refreshing} onClick={onRefresh}><IconRefresh size={18} className="refresh-icon" aria-hidden="true" /></button>
          <button type="button" className="glass-icon" aria-label="编辑主屏幕" title="编辑主屏幕" onClick={enterEdit}><IconAdjustmentsHorizontal size={18} aria-hidden="true" /></button>
          <button type="button" className="glass-icon" aria-label="退出登录" title="退出登录" onClick={onSignOut}><IconLogout size={18} aria-hidden="true" /></button>
          {/* Settings, at the toolbar's end: the same round glass button as its neighbours. */}
          <button type="button" className="glass-icon" aria-label="设置" title="设置" onClick={event => onOpenSettings(event.currentTarget.getBoundingClientRect())}><IconSettings size={18} aria-hidden="true" /></button>
        </>}
      </div>
    </header>

    <DndContext {...dndHandlers} measuring={ICON_MEASURING}>
      <div ref={viewportRef} className="home-pager" {...pager.viewportProps}>
        <div ref={setTrack} className="home-pager-track">
          <SortableContext {...sortableProps}>{ranges.map(renderPage)}{newPage}</SortableContext>
        </div>
      </div>
      {/* The folder sits in the same drag context, outside the sliding pages, so its icons can be dragged out. */}
      {closingFolder && <StudioHomeFolder key={`closing-${closingFolder.folder.id}`} closing folder={closingFolder.folder} tiles={closingFolder.tiles}
        defaultNameOf={defaultNameOf} editing={false} iconSize={iconSize} labels={layout.labels} origin={closingFolder.origin} switchStateOf={switchStateOf}
        sortable={folderSortable} panelRef={folderPanelRef} onActivate={() => {}} onClose={() => {}} onRenameTile={() => {}} onRenameFolder={() => {}} onMoveOut={() => {}} />}
      {openFolder && openFolderEntry && <StudioHomeFolder key={openFolderEntry.id} folder={openFolderEntry.folder} tiles={openFolderEntry.tiles} defaultNameOf={defaultNameOf}
        editing={editing} iconSize={iconSize} labels={layout.labels} origin={openFolder.origin} switchStateOf={switchStateOf}
        sortable={folderSortable} panelRef={folderPanelRef} onActivate={activateTile} onClose={closeFolder}
        onRenameTile={(id, name) => { if (name !== null) writeHomeName(id, name, defaultNameOf(id)); }}
        onRenameFolder={name => renameFolder(openFolderEntry.id, name)}
        onMoveOut={id => moveOutOfFolder(openFolderEntry.id, id)} />}
      <IconDragLayer entries={entries} folderTiles={folderTiles} iconSize={iconSize} merging={Boolean(merge?.ready)} switchStateOf={switchStateOf} overlayRef={setOverlay} remeasureRef={remeasure} />
      <p className="studio-visually-hidden" aria-live="polite">{moveMessage}</p>
    </DndContext>
    <div ref={setDragHost} className="home-drag-host" />
    {/* In edit mode the page control rides in the floating bar, which sits where it otherwise would. Leaving edit mode,
        the bar shrinks away without it while the dots glide back to the foot of the screen. */}
    {!editing && pageControl}
    {(editing || leavingEdit) && <div className={`home-edit-bar ${editing ? '' : 'is-leaving'}`} role="group" aria-label="主屏幕外观" {...(editing ? {} : LEAVING_INERT)}>
      {editing && pageControl}
      <label className="ios-switch-label">显示名称
        <input type="checkbox" role="switch" className="ios-switch" checked={layout.labels} onChange={event => updateLayout({ labels: event.target.checked })} />
      </label>
      <label className="ios-switch-label">大图标
        <input type="checkbox" role="switch" className="ios-switch" checked={layout.large} onChange={event => updateLayout({ large: event.target.checked })} />
      </label>
    </div>}

    {ajExit.sheetOpen && <StudioAjExitSheet ready={ajExit.ready} on={ajExit.on} supported={ajExit.supported}
      onClose={ajExit.closeSheet} onFinishSetup={ajExit.finishSetup} onResetSetup={ajExit.resetSetup} />}

    {libraryOpen && createPortal(<div className={`studio-layer ${library.closing ? 'closing' : ''}`} onKeyDown={event => { if (event.key === 'Escape') library.close(); }}>
      <div className="sheet-scrim" aria-hidden="true" onClick={library.close} />
      <div className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-library-title">
        <div className="library-grabber" aria-hidden="true" />
        <header><h2 id="studio-library-title">App 资源库</h2><button type="button" className="ios-button tinted" autoFocus onClick={library.close}>完成</button></header>
        <h3>已隐藏</h3>
        <div className="ios-list">
          {hidden.map(tile => <div className="ios-row" key={tile.id}>
            <StudioTileIcon tone={tile.tone} glyph={tile.glyph} product={tile.id} size={17} variant="small" />
            <span className="ios-row-body"><strong>{tile.name}</strong></span>
            <button type="button" className="ios-button tinted" onClick={() => glide(() => updateLayout(previous => ({ ...previous, hidden: previous.hidden.filter(id => id !== tile.id) })))}>添加到主屏幕</button>
          </div>)}
          {!hidden.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>所有应用都在主屏幕上</small></span></div>}
        </div>
        {PLANNED.length > 0 && <>
          <h3>规划中的接入</h3>
          <div className="ios-list">
            {PLANNED.map(item => <div className="ios-row" key={item.name} aria-disabled="true">
              <StudioTileIcon tone={item.tone} glyph={item.glyph} size={17} variant="small" />
              <span className="ios-row-body"><strong>{item.name}</strong><small>{item.caption}</small></span>
              <span className="status-badge">未接入</span>
            </div>)}
          </div>
        </>}
        <p className="ios-section-footer">新项目请用主屏幕上的「新建」。把一个图标拖到另一个上停一下，就能放进同一个文件夹。{PLANNED.length > 0 && '规划中的接入在接好真实 API 之前不会显示任何数据。'}</p>
      </div>
    </div>, document.body)}
  </div>;
}
