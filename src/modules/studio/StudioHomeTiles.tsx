import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { m, useReducedMotion } from 'motion/react';

import { IconChevronLeft, IconChevronRight, IconCursorText, IconMinus, IconPlus, IconRotate, IconX } from '@/modules/studio/icons/tabler';
import type { StudioHomeTile } from '@/shared/types';
import { StudioBuildBadge, StudioBuildProgress, StudioBuildStatus } from '@/modules/studio/StudioBuildProgress';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';
import { useHomeSortableItem } from '@/modules/studio/hooks/useHomeSortable';
import { HOME_NAME_MAX } from '@/modules/studio/utils/homeLayout';
import { isHomeFilling } from '@/modules/studio/utils/homeTiles';

const preventContextMenu = (event: MouseEvent) => event.preventDefault();

// How many copies of each icon are mounted right now, by id. An icon that mounts while its id is still counted is
// moving to another page (its old copy unmounts in the same commit), so it appears in place instead of rising in
// with the entrance animation again.
const mountedIcons = new Map<string, number>();

// The entrance, the first time the home screen fills: icons rise 20 px and fade in one after another, 80 ms apart, on
// a soft spring. `m`, not `motion`: StudioPage loads motion's features lazily (LazyMotion strict).
const MotionLink = m.create(Link);
const ENTRANCE_HIDDEN = { opacity: 0, y: 20 } as const;
const ENTRANCE_SHOWN = { opacity: 1, y: 0 } as const;
const ENTRANCE_STAGGER_S = 0.08;
const entranceTransition = (index: number) => ({
  y: { type: 'spring', stiffness: 100, damping: 12, delay: index * ENTRANCE_STAGGER_S },
  opacity: { duration: 0.4, ease: 'easeOut', delay: index * ENTRANCE_STAGGER_S },
} as const);
// The motion props of a tile: the entrance when it rises in, otherwise none (it simply appears, and later renders,
// page moves and edit mode never replay anything). Its y offset lives on the tile, never on the sortable slot that
// dnd-kit moves.
const entranceProps = (rises: boolean, index: number) => rises
  ? { initial: ENTRANCE_HIDDEN, animate: ENTRANCE_SHOWN, transition: entranceTransition(index) }
  : { initial: false as const };

// Whether an icon rises in: fixed at mount, only while the home screen first fills, never under reduced motion, and
// not when it merely moved to another page.
function useRises(id: string) {
  const reducedMotion = useReducedMotion();
  const [rises] = useState(() => isHomeFilling() && !reducedMotion && !mountedIcons.get(id));
  useLayoutEffect(() => {
    mountedIcons.set(id, (mountedIcons.get(id) ?? 0) + 1);
    return () => {
      const remaining = (mountedIcons.get(id) ?? 1) - 1;
      if (remaining > 0) mountedIcons.set(id, remaining); else mountedIcons.delete(id);
    };
  }, [id]);
  return rises;
}


// A tile that is a switch (AJ 出口) shows its state under the label; `on` also rings the icon in green.
export type SwitchState = 'on' | 'off';

/** What an icon shows: the icon (with any build ring), its name and its status line. */
export function TileFace({ tile, editing, iconSize, switchState }: { tile: StudioHomeTile; editing: boolean; iconSize: number; switchState?: SwitchState }) {
  const progress = tile.progress;
  return <>
    <span className="home-icon-wrap" data-build={progress?.state} data-on={switchState === 'on' ? 'true' : undefined}>
      <StudioTileIcon tone={tile.tone} glyph={tile.glyph} product={tile.id} size={iconSize}>{progress && <StudioBuildProgress progress={progress} />}</StudioTileIcon>
      {progress?.state === 'failed' && !editing && <StudioBuildBadge />}
    </span>
    <span className="home-label">{tile.name}</span>
    {progress ? <StudioBuildStatus progress={progress} />
      : tile.status && <span className={`home-status ${switchState ? 'is-switch' : ''} ${switchState === 'on' ? 'is-on' : ''}`}>{tile.status}</span>}
  </>;
}

/** A folder as the home screen shows it: a card holding up to nine of its icons in miniature, and its name. */
export function FolderFace({ name, tiles, iconSize, merging = false }: { name: string; tiles: StudioHomeTile[]; iconSize: number; merging?: boolean }) {
  // The miniatures are a third of the card, like the icons in an iPadOS folder.
  const mini = Math.max(10, Math.round(iconSize * 0.36));
  return <>
    <span className="home-icon-wrap" data-merge={merging ? 'true' : undefined}>
      <span className="home-icon home-folder-icon" aria-hidden="true">
        <span className="home-folder-grid">
          {tiles.slice(0, 9).map(tile => <StudioTileIcon key={tile.id} tone={tile.tone} glyph={tile.glyph} product={tile.id} size={mini} variant="mini" />)}
        </span>
      </span>
    </span>
    <span className="home-label">{name}</span>
  </>;
}

/**
 * The name under an icon, typed in place in edit mode: Return or leaving the field keeps it, Esc puts the old one
 * back, and an empty name (or the original) goes back to the default.
 */
export function HomeNameField({ value, defaultName, label, onDone }: {
  value: string; defaultName: string; label: string;
  // The new name, or null to keep the old one.
  onDone: (name: string | null) => void;
}) {
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); finish(event.currentTarget.value); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
  };
  return <input className="home-label-input" aria-label={label} defaultValue={value} placeholder={defaultName} maxLength={HOME_NAME_MAX * 2}
    autoFocus enterKeyHint="done" autoComplete="off" autoCorrect="off" spellCheck={false}
    onFocus={event => event.currentTarget.select()} onKeyDown={onKeyDown} onBlur={event => finish(event.currentTarget.value)}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} />;
}

type Badge = { kind: 'hide' | 'stop' | 'dissolve' | 'out'; label: string; onClick: () => void };

/**
 * One sortable item on the home screen or in an open folder: an app or a folder. The slot moves (with its badges),
 * the tile itself is what is pressed and dragged. In edit mode a tap on the name renames it in place.
 */
export function SortableEntry({ id, name, defaultName, label, title, href, face, index, last, editing, renaming, badge, slotClass = '', onResume, onActivate, onMove, onRenameStart, onRename }: {
  id: string;
  // The name shown (and edited), the one it goes back to, and the accessible name of the tile (with its status).
  name: string; defaultName: string; label: string;
  // The tooltip while labels are hidden.
  title?: string;
  href?: string;
  face: ReactNode;
  index: number;
  // Whether this is the last item, where its 后移 button has nowhere to go.
  last: boolean;
  editing: boolean;
  renaming: boolean;
  badge?: Badge;
  // Extra classes on the slot (an icon another one is held over, about to become a folder).
  slotClass?: string;
  onResume?: () => void;
  onActivate: (event: MouseEvent<HTMLElement>) => void;
  onMove: (step: -1 | 1) => void;
  onRenameStart: () => void;
  onRename: (name: string | null) => void;
}) {
  const { attributes, isDragging, itemAttributes, listeners, setActivatorNodeRef, setNodeRef, style } = useHomeSortableItem(id);
  const rises = useRises(id);
  // Links and buttons are focusable already; edit mode only adds the sortable description for screen readers.
  const shared = {
    ref: setActivatorNodeRef,
    className: 'home-tile', title, 'aria-label': label,
    ...entranceProps(rises, index),
    ...(editing ? { 'aria-roledescription': attributes['aria-roledescription'], 'aria-describedby': attributes['aria-describedby'] } : {}),
    ...(renaming ? {} : listeners),
    onContextMenu: preventContextMenu,
  };
  const BadgeIcon = badge?.kind === 'stop' ? IconX : IconMinus;
  // While dragged, the icon rides in the drag overlay and its slot stays behind as the gap where it will land.
  return <div ref={setNodeRef} {...itemAttributes} style={style} className={`home-tile-slot ${isDragging ? 'is-placeholder' : ''} ${renaming ? 'is-renaming' : ''} ${slotClass}`}>
    {href
      // A mouse swipe that starts on a link must not turn into the browser's own link drag.
      ? <MotionLink to={href} draggable={false} {...shared} onClick={onActivate}>{face}</MotionLink>
      : <m.button type="button" {...shared} onClick={onActivate}>{face}</m.button>}
    {renaming && <HomeNameField value={name} defaultName={defaultName} label={`${defaultName} 的名称`} onDone={onRename} />}
    {editing && badge && <button type="button" className={`home-remove ${badge.kind === 'stop' ? 'build-stop' : ''}`} aria-label={badge.label} onClick={badge.onClick}>
      <BadgeIcon size={14} strokeWidth={3} aria-hidden="true" /></button>}
    {editing && onResume && <button type="button" className="home-resume" aria-label={`继续开发 ${name}`}
      onClick={onResume}><IconRotate size={14} strokeWidth={2.6} aria-hidden="true" /></button>}
    {/* VoiceOver and Switch Control cannot drag or tap a name, so edit mode also offers move and rename buttons. They
        stay out of sight (the grid keeps its clean iPadOS look) until focused, when they appear under the icon.
        aria-disabled, not disabled, keeps a button focused when its icon reaches an end. They move across pages too. */}
    {editing && !renaming && <span className="home-move" role="group" aria-label={`调整 ${name}`}>
      <button type="button" aria-label={`前移 ${name}`} aria-disabled={index === 0} data-move-id={id} data-move-step="-1"
        onClick={() => { if (index > 0) onMove(-1); }}><IconChevronLeft size={16} aria-hidden="true" /></button>
      <button type="button" aria-label={`重命名 ${name}`} onClick={onRenameStart}><IconCursorText size={16} aria-hidden="true" /></button>
      <button type="button" aria-label={`后移 ${name}`} aria-disabled={last} data-move-id={id} data-move-step="1"
        onClick={() => { if (!last) onMove(1); }}><IconChevronRight size={16} aria-hidden="true" /></button>
    </span>}
  </div>;
}

/** The 新建 tile after the icons: a dashed card that creates a project, rising in with them the first time. */
export function AddTile({ index, large, labels, onCreate }: { index: number; large: boolean; labels: boolean; onCreate: () => void }) {
  const reducedMotion = useReducedMotion();
  // Fixed at mount, like the icons' (it moves to another page when icons are added or hidden, and then just appears).
  const [rises] = useState(() => isHomeFilling() && !reducedMotion);
  return <m.button type="button" className="home-tile add" aria-label="新建项目" title={labels ? undefined : '新建项目'} onClick={onCreate} {...entranceProps(rises, index)}>
    <span className="home-icon tone-ghost" aria-hidden="true"><IconPlus size={large ? 44 : 34} strokeWidth={1.4} /></span>
    <span className="home-label">新建</span>
  </m.button>;
}
