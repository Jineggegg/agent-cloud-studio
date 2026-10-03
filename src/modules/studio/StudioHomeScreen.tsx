import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MouseEvent, MutableRefObject, RefObject } from 'react';
import { Link } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, LayoutGrid, LogOut, Minus, Moon, Plus, RefreshCw, RotateCcw, Settings, SlidersHorizontal, Sun, X } from 'lucide-react';
import { DndContext, DragOverlay, MeasuringStrategy, useDndContext } from '@dnd-kit/core';
import type { DragMoveEvent } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { getEventCoordinates } from '@dnd-kit/utilities';

import { useTheme } from '@/shared/context/ThemeContext';
import { STUDIO_AJ_EXIT_TILE_ID } from '@/shared/constants';
import type { StudioHomeTile, StudioSnr, StudioTileProgress } from '@/shared/types';
import { StudioAjExitSheet } from '@/modules/studio/StudioAjExitSheet';
import { StudioBuildBadge, StudioBuildProgress, StudioBuildStatus } from '@/modules/studio/StudioBuildProgress';
import { StudioFluidBackground } from '@/modules/studio/StudioFluidBackground';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import { StudioWidgets } from '@/modules/studio/StudioWidgets';
import type { WidgetType } from '@/modules/studio/StudioWidgets';
import { useAjExit } from '@/modules/studio/hooks/useAjExit';
import { useHomePager } from '@/modules/studio/hooks/useHomePager';
import { useHomeSortableItem, useHomeSortableList } from '@/modules/studio/hooks/useHomeSortable';
import { gridCapacity, pageRanges } from '@/modules/studio/utils/homePaging';
import '@/modules/studio/studio-home.css';

// Per-device layout preferences (hidden tiles, labels, icon size, icon order).
const LAYOUT_STORAGE_KEY = 'studio-home-layout-v1';
// Integrations that are planned but not built; listed honestly as not connected.
const PLANNED: { name: string; caption: string; tone: string; glyph: string }[] = [
  // Outlook mail is built now (Settings → 邮箱账户); nothing else is planned at the moment.
];
// Taps on these keep edit mode; a tap anywhere else (the wallpaper, gaps between icons) ends it, as on iPadOS.
// `.studio-layer` covers the sheets, whose clicks bubble here through their React portals.
const KEEPS_EDITING = '.home-tile-slot, .widget-slot, button, a, input, label, .home-edit-bar, .studio-layer';
// Dragging an icon to within this distance of the screen's side and holding it there turns the page, as on iPadOS.
const EDGE_ZONE_PX = 48;
const EDGE_HOLD_MS = 500;
// Held at the edge longer, the pages keep turning, one more each time the last turn has settled.
const EDGE_REPEAT_MS = 900;
// Pages move under a dragged icon, so dnd-kit measures where the icons are throughout, not just once per drag.
const ICON_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };

// `order` is absent until the icons are first rearranged on this device; layouts saved before it existed still load.
type Layout = { hidden: string[]; labels: boolean; large: boolean; order?: string[] };
const DEFAULT_LAYOUT: Layout = { hidden: [], labels: true, large: false };
// How many icons fit on the first page (beside the widgets) and on each later one.
type Capacity = { first: number; page: number };

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

function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? 'null') as Partial<Layout> | null;
    if (!saved) return DEFAULT_LAYOUT;
    return {
      hidden: Array.isArray(saved.hidden) ? saved.hidden.filter(id => typeof id === 'string') : [],
      labels: saved.labels !== false,
      large: saved.large === true,
      ...(Array.isArray(saved.order) ? { order: saved.order.filter(id => typeof id === 'string') } : {}),
    };
  } catch { return DEFAULT_LAYOUT; }
}

// Tiles this device has placed come first, in its order; new ones (a project created since) follow in their natural order.
function orderTiles(tiles: StudioHomeTile[], order: string[] | undefined) {
  if (!order?.length) return tiles;
  const rank = new Map(order.map((id, index) => [id, index]));
  return tiles.map((tile, index) => ({ tile, rank: rank.get(tile.id) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.tile);
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
    first: gridCapacity({ available: height - (widgets?.offsetHeight ?? 0) - firstGap, rowHeight, rowGap, columns }),
    // A later page always takes at least a row, so even a tiny window makes progress through the icons.
    page: Math.max(columns, gridCapacity({ available: height - laterGap, rowHeight, rowGap, columns })),
  };
}

const sameCapacity = (a: Capacity | null, b: Capacity | null) => a === b || (a !== null && b !== null && a.first === b.first && a.page === b.page);

const preventContextMenu = (event: MouseEvent) => event.preventDefault();

// How many copies of each icon are mounted right now, by tile id. An icon that mounts while its id is still counted
// is moving to another page (its old copy unmounts in the same commit), so it appears in place instead of rising in
// with the entrance animation again; a new project, or an icon brought back from the library, still rises in.
const mountedIcons = new Map<string, number>();

// The status an AI build gives its tile, in words, for the accessible name.
const buildStatusText = (progress: StudioTileProgress) => progress.label ?? `开发中 ${Math.round(progress.value * 100)}%`;

// A tile that is a switch (AJ 出口) shows its state under the label; `on` also rings the icon in green.
type SwitchState = 'on' | 'off';

/** What an icon shows: the icon (with any build ring), its name and its status line. */
function TileFace({ tile, editing, iconSize, switchState }: { tile: StudioHomeTile; editing: boolean; iconSize: number; switchState?: SwitchState }) {
  const progress = tile.progress;
  return <>
    <span className="home-icon-wrap" data-build={progress?.state} data-on={switchState === 'on' ? 'true' : undefined}>
      <StudioTileIcon tone={tile.tone} glyph={tile.glyph} size={iconSize}>{progress && <StudioBuildProgress progress={progress} />}</StudioTileIcon>
      {progress?.state === 'failed' && !editing && <StudioBuildBadge />}
    </span>
    <span className="home-label">{tile.name}</span>
    {progress ? <StudioBuildStatus progress={progress} />
      : tile.status && <span className={`home-status ${switchState ? 'is-switch' : ''} ${switchState === 'on' ? 'is-on' : ''}`}>{tile.status}</span>}
  </>;
}

/** One sortable app icon; the slot moves (with its hide badge), the tile itself is what is pressed and dragged. */
function SortableTile({ tile, index, last, editing, labels, iconSize, switchState, onActivate, onHide, onMove, onBuildAction }: {
  tile: StudioHomeTile; index: number; editing: boolean; labels: boolean; iconSize: number;
  // Whether the icon is the last visible one, where its 后移 button has nowhere to go.
  last: boolean;
  switchState?: SwitchState;
  onActivate: (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => void;
  onHide: () => void;
  onMove: (step: -1 | 1) => void;
  onBuildAction?: (action: 'stop' | 'resume') => void;
}) {
  const { attributes, isDragging, itemAttributes, listeners, setActivatorNodeRef, setNodeRef, style } = useHomeSortableItem(tile.id);
  // Fixed at mount: an icon that moved to another page appears in place instead of rising in again.
  const [arrived] = useState(() => (mountedIcons.get(tile.id) ?? 0) > 0);
  useLayoutEffect(() => {
    mountedIcons.set(tile.id, (mountedIcons.get(tile.id) ?? 0) + 1);
    return () => {
      const remaining = (mountedIcons.get(tile.id) ?? 1) - 1;
      if (remaining > 0) mountedIcons.set(tile.id, remaining); else mountedIcons.delete(tile.id);
    };
  }, [tile.id]);
  const progress = tile.progress;
  const status = progress ? buildStatusText(progress) : tile.status;
  const label = `${tile.name}${status ? `，${status}` : ''}`;
  // A build in progress can be stopped from edit mode (in place of hiding it); a failed one can be continued.
  const buildRunning = progress?.state === 'queued' || progress?.state === 'building';
  const body = <TileFace tile={tile} editing={editing} iconSize={iconSize} switchState={switchState} />;
  // Links and buttons are focusable already; edit mode only adds the sortable description for screen readers.
  const shared = {
    ref: setActivatorNodeRef,
    className: `home-tile ${arrived ? 'has-arrived' : ''}`, style: { animationDelay: `${index * 45}ms` }, title: labels ? undefined : tile.name, 'aria-label': label,
    ...(editing ? { 'aria-roledescription': attributes['aria-roledescription'], 'aria-describedby': attributes['aria-describedby'] } : {}),
    ...listeners,
    onContextMenu: preventContextMenu,
  };
  // While dragged, the icon rides in the drag overlay and its slot stays behind as the gap where it will land.
  return <div ref={setNodeRef} {...itemAttributes} style={style} className={`home-tile-slot ${isDragging ? 'is-placeholder' : ''}`}>
    {tile.href
      // A mouse swipe that starts on a link must not turn into the browser's own link drag.
      ? <Link to={tile.href} draggable={false} {...shared} onClick={event => onActivate(tile, event)}>{body}</Link>
      : <button type="button" {...shared} onClick={event => onActivate(tile, event)}>{body}</button>}
    {editing && (buildRunning && onBuildAction
      ? <button type="button" className="home-remove build-stop" aria-label={`停止开发 ${tile.name}`} onClick={() => onBuildAction('stop')}><X size={14} strokeWidth={3} aria-hidden="true" /></button>
      : <button type="button" className="home-remove" aria-label={`从主屏幕隐藏 ${tile.name}`} onClick={onHide}><Minus size={14} strokeWidth={3} aria-hidden="true" /></button>)}
    {editing && progress?.state === 'failed' && onBuildAction && <button type="button" className="home-resume" aria-label={`继续开发 ${tile.name}`}
      onClick={() => onBuildAction('resume')}><RotateCcw size={14} strokeWidth={2.6} aria-hidden="true" /></button>}
    {/* VoiceOver and Switch Control cannot drag, so edit mode also offers move buttons. They stay out of sight
        (the grid keeps its clean iPadOS look) until focused, when they appear under the icon. aria-disabled,
        not disabled, keeps a button focused when its icon reaches an end. They move across pages too. */}
    {editing && <span className="home-move" role="group" aria-label={`调整 ${tile.name} 的位置`}>
      <button type="button" aria-label={`前移 ${tile.name}`} aria-disabled={index === 0} data-move-id={tile.id} data-move-step="-1"
        onClick={() => { if (index > 0) onMove(-1); }}><ChevronLeft size={16} aria-hidden="true" /></button>
      <button type="button" aria-label={`后移 ${tile.name}`} aria-disabled={last} data-move-id={tile.id} data-move-step="1"
        onClick={() => { if (!last) onMove(1); }}><ChevronRight size={16} aria-hidden="true" /></button>
    </span>}
  </div>;
}

/**
 * The lifted icon while it is dragged. It rides in dnd-kit's DragOverlay, a fixed box outside the sliding pages, so
 * it stays under the finger while a held edge turns the page beneath it. It also lends the list its re-measure,
 * which the home screen calls whenever the pages come to rest.
 */
function IconDragLayer({ tiles, iconSize, switchStateOf, overlayRef, remeasureRef }: {
  tiles: StudioHomeTile[]; iconSize: number;
  switchStateOf: (tile: StudioHomeTile) => SwitchState | undefined;
  overlayRef: RefObject<HTMLElement>;
  remeasureRef: MutableRefObject<(() => void) | null>;
}) {
  const { active, measureDroppableContainers } = useDndContext();
  useEffect(() => {
    remeasureRef.current = () => measureDroppableContainers([]);
    return () => { remeasureRef.current = null; };
  }, [measureDroppableContainers, remeasureRef]);
  const tile = active ? tiles.find(item => item.id === active.id) : undefined;
  // No dnd-kit drop animation: on drop the real icon glides from here into its slot (useHomeSortableList).
  return <DragOverlay dropAnimation={null} className="home-drag-overlay">
    {tile && <div ref={overlayRef as RefObject<HTMLDivElement>} className="home-tile-slot is-lifted" aria-hidden="true">
      <span className="home-tile"><TileFace tile={tile} editing={false} iconSize={iconSize} switchState={switchStateOf(tile)} /></span>
    </div>}
  </DragOverlay>;
}

/**
 * Used by StudioPage as the launcher: one large icon per project or app, plus + to create a project, on pages that
 * slide sideways under a fixed header like the iPadOS home screen (UIScrollView physics in useHomePager, an iOS
 * page control at the bottom). The first page holds the widgets and as many icons as fit without scrolling; the
 * rest flow onto later pages. A long press on any icon or widget enters edit mode (jiggling, drag to rearrange,
 * hide); an icon held at the screen's side turns the page, so it can move between pages, and the move buttons give
 * VoiceOver and Switch Control the same rearranging. Icons an AI is building dim under a progress ring
 * (StudioBuildProgress); in edit mode they offer stop, and failed ones continue. The AJ 出口 tile switches this
 * device to the Tailscale exit node through two Shortcuts (useAjExit).
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
  // Layout choices are per device so an iPad and a MacBook can arrange tiles differently.
  const [layout, setLayout] = useState<Layout>(readLayout);
  // Edit mode jiggles tiles and widgets, lets them be dragged and exposes hide controls, as on the iPadOS home screen.
  const [editing, setEditing] = useState(false);
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
  const ajExit = useAjExit();

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

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); } catch { /* Private mode keeps the layout for this visit only. */ }
  }, [layout]);

  const switchStateOf = useCallback((tile: StudioHomeTile): SwitchState | undefined => tile.id === STUDIO_AJ_EXIT_TILE_ID ? (ajExit.on ? 'on' : 'off') : undefined, [ajExit.on]);
  // AJ 出口 shows what this device last asked for under its name.
  const tilesWithState = useMemo(() => tiles.map(tile => tile.id === STUDIO_AJ_EXIT_TILE_ID ? { ...tile, status: ajExit.on ? '已开启' : '未开启' } : tile), [tiles, ajExit.on]);
  const ordered = useMemo(() => orderTiles(tilesWithState, layout.order), [tilesWithState, layout.order]);
  const visible = useMemo(() => ordered.filter(tile => !layout.hidden.includes(tile.id)), [ordered, layout.hidden]);
  const hidden = tiles.filter(tile => layout.hidden.includes(tile.id));
  const update = (patch: Partial<Layout>) => setLayout(previous => ({ ...previous, ...patch }));

  // Icons, then the 新建 tile, split into pages.
  const ranges = useMemo(() => pageRanges(visible.length + 1, capacity?.first ?? null, capacity?.page ?? 1), [visible.length, capacity]);
  const pager = useHomePager({ pageCount: ranges.length, keyboard: !covered, onSettle: () => remeasure.current?.() });
  const { goTo, setGestureBlocked, turn, viewportRef } = pager;

  const stopEdgeHold = useCallback(() => {
    if (edgeHold.current) window.clearTimeout(edgeHold.current.timer);
    edgeHold.current = null;
  }, []);
  const setDragActive = useCallback((active: boolean) => {
    dragging.current = active;
    setGestureBlocked(active);
    if (!active) stopEdgeHold();
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
  const followDragToEdge = useCallback(({ activatorEvent, delta }: DragMoveEvent) => {
    const viewport = viewportRef.current;
    // Keyboard drags stay on the visible page (see useHomeSortableList's visibleArea); the move buttons cross pages.
    const start = activatorEvent && !(activatorEvent instanceof KeyboardEvent) ? getEventCoordinates(activatorEvent) : null;
    if (!viewport || !start) return;
    const box = viewport.getBoundingClientRect();
    if (box.width <= 0) return;
    const x = start.x + delta.x;
    holdAtEdge(x < box.left + EDGE_ZONE_PX ? -1 : x > box.right - EDGE_ZONE_PX ? 1 : 0);
  }, [holdAtEdge, viewportRef]);
  useEffect(() => stopEdgeHold, [stopEdgeHold]);
  const visibleArea = useCallback(() => viewportRef.current?.getBoundingClientRect() ?? null, [viewportRef]);

  const visibleIds = useMemo(() => visible.map(tile => tile.id), [visible]);
  const enterEdit = useCallback(() => setEditing(true), []);
  const labelOf = useCallback((id: string) => tiles.find(tile => tile.id === id)?.name ?? id, [tiles]);
  const reorder = useCallback((ids: string[]) => setLayout(previous => {
    // Hidden tiles keep their place after the visible ones, so the saved order always covers every tile.
    const placed = new Set(ids);
    return { ...previous, order: [...ids, ...orderTiles(tiles, previous.order).map(tile => tile.id).filter(id => !placed.has(id))] };
  }), [tiles]);
  const { containerRef, overlayRef, glide, move, moveMessage, dndProps, sortableProps } = useHomeSortableList({
    ids: visibleIds, editing, onEnterEdit: enterEdit, onReorder: reorder, labelOf, onDragActiveChange: setDragActive, visibleArea,
  });
  const moveTile = (id: string, step: -1 | 1) => { pendingMoveFocus.current = { id, step }; move(id, step); };
  // The track holds every page, so it is both what slides and where the list's drop glide finds the icons.
  const { trackRef } = pager;
  const setTrack = useCallback((node: HTMLDivElement | null) => {
    trackRef.current = node;
    containerRef.current = node;
  }, [containerRef, trackRef]);

  // Fit the icons to the pages whenever something that sizes them changes: the screen or the widgets (counted by the
  // observer below), the icon size and labels, or the icons themselves (a status line adds height).
  useLayoutEffect(() => {
    const home = homeRef.current;
    const viewport = viewportRef.current;
    if (!home || !viewport || dragging.current) return;
    const next = measureCapacity(home, viewport, widgetsRef.current);
    setCapacity(previous => sameCapacity(previous, next) ? previous : next);
  }, [layout.large, layout.labels, loading, resizeCount, viewportRef, visible]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => countResize());
    observer.observe(viewport);
    if (widgetsRef.current) observer.observe(widgetsRef.current);
    return () => observer.disconnect();
  }, [viewportRef]);

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

  const activate = (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => {
    // In edit mode a tap never opens an app (the click that ends a long press is swallowed before it gets here);
    // AJ 出口 opens its settings instead, the way iPadOS configures a widget tapped while jiggling.
    if (editing) {
      event.preventDefault();
      if (tile.id === STUDIO_AJ_EXIT_TILE_ID) ajExit.openSheet();
      return;
    }
    if (tile.id === STUDIO_AJ_EXIT_TILE_ID) { ajExit.tap(); return; }
    if (tile.href) return;
    const icon = event.currentTarget.querySelector('.home-icon');
    onOpen(tile, icon ? icon.getBoundingClientRect() : null);
  };
  const leaveEditOnEmptyTap = (event: MouseEvent<HTMLDivElement>) => {
    if (editing && !(event.target as Element).closest(KEEPS_EDITING)) setEditing(false);
  };
  const today = new Date();
  const iconSize = layout.large ? 52 : 40;
  const pageCount = ranges.length;

  const pageControl = pageCount > 1 && <div className={`home-page-control ${pager.lit ? 'is-lit' : ''}`} role="group" aria-label="主屏幕页面">
    {ranges.map((_, index) => <button type="button" key={index} aria-label={`第 ${index + 1} 页`} aria-current={index === pager.page ? 'true' : undefined}
      onClick={() => goTo(index)}><i aria-hidden="true" /></button>)}
  </div>;

  const renderPage = (range: { start: number; end: number }, index: number) => {
    const tilesHere = visible.slice(range.start, Math.min(range.end, visible.length));
    const holdsAdd = range.start <= visible.length && visible.length < range.end;
    return <section key={index} className="home-page" data-home-page={index} aria-label={pageCount > 1 ? `第 ${index + 1} 页，共 ${pageCount} 页` : undefined}>
      {index === 0 && <div className="home-widgets-slot" ref={widgetsRef}>
        <StudioWidgets editing={editing} snr={snr} paused={covered} onEnterEdit={enterEdit} onOpen={onOpenWidget}
          galleryOpen={widgetGalleryOpen} onGalleryClose={() => setWidgetGalleryOpen(false)} overlayContainer={dragHost} onDragActiveChange={setDragActive} />
      </div>}
      <nav className="home-grid" aria-label={index === 0 ? '应用' : `应用（第 ${index + 1} 页）`} aria-busy={index === 0 ? loading : undefined}>
        {tilesHere.map((tile, offset) => {
          const position = range.start + offset;
          return <SortableTile key={tile.id} tile={tile} index={position} last={position === visible.length - 1} editing={editing}
            labels={layout.labels} iconSize={iconSize} switchState={switchStateOf(tile)} onActivate={activate}
            onHide={() => glide(() => update({ hidden: [...layout.hidden, tile.id] }))}
            onMove={step => moveTile(tile.id, step)} onBuildAction={onBuildAction && (action => onBuildAction(tile, action))} />;
        })}
        {index === 0 && loading && !visible.length && [0, 1, 2].map(placeholder => <div className="home-tile-slot" key={`placeholder-${placeholder}`} aria-hidden="true"><span className="home-tile placeholder"><span className="home-icon tone-ghost" /></span></div>)}
        {holdsAdd && <div className="home-tile-slot">
          <button type="button" className="home-tile add" style={{ animationDelay: `${visible.length * 45}ms` }} aria-label="新建项目" title={layout.labels ? undefined : '新建项目'} onClick={onCreate}>
            <span className="home-icon tone-ghost" aria-hidden="true"><Plus size={layout.large ? 44 : 34} strokeWidth={1.4} /></span>
            <span className="home-label">新建</span>
          </button>
        </div>}
      </nav>
    </section>;
  };

  return <div ref={homeRef} className={`home-screen ${layout.large ? 'large-icons' : ''} ${layout.labels ? '' : 'no-labels'} ${editing ? 'editing' : ''}`} onClick={leaveEditOnEmptyTap}>
    <StudioFluidBackground />
    <header className="home-top">
      <div className="home-date">
        <span className="home-weekday">{new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Europe/London' }).format(today)}</span>
        <h1>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Europe/London' }).format(today)}</h1>
      </div>
      <div className="home-actions">
        {editing ? <>
          <button type="button" className="glass-button home-action-compact" aria-label="添加小组件" title="添加小组件" onClick={() => setWidgetGalleryOpen(true)}><Plus size={17} aria-hidden="true" /><span className="studio-wide-only">小组件</span></button>
          <button type="button" className="glass-button home-action-compact" aria-label="资源库" title="App 资源库" onClick={() => setLibraryOpen(true)}><LayoutGrid size={17} aria-hidden="true" /><span className="studio-wide-only">资源库</span></button>
          <button type="button" className="glass-button strong" onClick={() => setEditing(false)}><Check size={17} aria-hidden="true" />完成</button>
        </> : <>
          <button type="button" className="glass-icon theme-toggle" aria-label={isDarkMode ? '切换到浅色模式' : '切换到深色模式'} title={isDarkMode ? '浅色模式' : '深色模式'}
            onClick={event => revealTheme(() => setThemeMode(isDarkMode ? 'light' : 'dark'), event.currentTarget)}>
            {isDarkMode ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}</button>
          <button type="button" className={`glass-icon ${refreshing ? 'refreshing' : ''}`} aria-label="刷新状态" title="刷新状态" disabled={refreshing} onClick={onRefresh}><RefreshCw size={18} className="refresh-icon" aria-hidden="true" /></button>
          <button type="button" className="glass-icon" aria-label="编辑主屏幕" title="编辑主屏幕" onClick={() => setEditing(true)}><SlidersHorizontal size={18} aria-hidden="true" /></button>
          <button type="button" className="glass-icon" aria-label="退出登录" title="退出登录" onClick={onSignOut}><LogOut size={18} aria-hidden="true" /></button>
          {/* Settings, one size smaller, in the corner. */}
          <button type="button" className="glass-icon home-gear" aria-label="设置" title="设置" onClick={event => onOpenSettings(event.currentTarget.getBoundingClientRect())}><Settings size={17} aria-hidden="true" /></button>
        </>}
      </div>
    </header>

    <DndContext {...dndProps} measuring={ICON_MEASURING} onDragMove={followDragToEdge}>
      <div ref={viewportRef} className="home-pager" {...pager.viewportProps}>
        <div ref={setTrack} className="home-pager-track">
          <SortableContext {...sortableProps}>{ranges.map(renderPage)}</SortableContext>
        </div>
      </div>
      <IconDragLayer tiles={visible} iconSize={iconSize} switchStateOf={switchStateOf} overlayRef={overlayRef} remeasureRef={remeasure} />
      <p className="studio-visually-hidden" aria-live="polite">{moveMessage}</p>
    </DndContext>
    <div ref={setDragHost} className="home-drag-host" />

    {/* In edit mode the page control rides in the floating bar, which sits where it otherwise would. */}
    {editing ? <div className="home-edit-bar" role="group" aria-label="主屏幕外观">
      {pageControl}
      <label className="ios-switch-label">显示名称
        <input type="checkbox" role="switch" className="ios-switch" checked={layout.labels} onChange={event => update({ labels: event.target.checked })} />
      </label>
      <label className="ios-switch-label">大图标
        <input type="checkbox" role="switch" className="ios-switch" checked={layout.large} onChange={event => update({ large: event.target.checked })} />
      </label>
    </div> : pageControl}

    {ajExit.sheetOpen && <StudioAjExitSheet ready={ajExit.ready} on={ajExit.on} supported={ajExit.supported}
      onClose={ajExit.closeSheet} onFinishSetup={ajExit.finishSetup} onResetSetup={ajExit.resetSetup} />}

    {libraryOpen && createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') setLibraryOpen(false); }}>
      <div className="sheet-scrim" aria-hidden="true" onClick={() => setLibraryOpen(false)} />
      <div className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-library-title">
        <div className="library-grabber" aria-hidden="true" />
        <header><h2 id="studio-library-title">App 资源库</h2><button type="button" className="ios-button tinted" autoFocus onClick={() => setLibraryOpen(false)}>完成</button></header>
        <h3>已隐藏</h3>
        <div className="ios-list">
          {hidden.map(tile => <div className="ios-row" key={tile.id}>
            <StudioTileIcon tone={tile.tone} glyph={tile.glyph} size={17} variant="small" />
            <span className="ios-row-body"><strong>{tile.name}</strong></span>
            <button type="button" className="ios-button tinted" onClick={() => update({ hidden: layout.hidden.filter(id => id !== tile.id) })}>添加到主屏幕</button>
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
        <p className="ios-section-footer">新项目请用主屏幕上的「新建」。{PLANNED.length > 0 && '规划中的接入在接好真实 API 之前不会显示任何数据。'}</p>
      </div>
    </div>, document.body)}
  </div>;
}
