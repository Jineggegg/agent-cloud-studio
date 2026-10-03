import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { DndContext, DragOverlay, useDndContext } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { getEventCoordinates } from '@dnd-kit/utilities';

import type { StudioHomeTile } from '@/shared/types';
import { SortableEntry, TileFace } from '@/modules/studio/StudioHomeTiles';
import type { SwitchState } from '@/modules/studio/StudioHomeTiles';
import { useHomeSortableList } from '@/modules/studio/hooks/useHomeSortable';
import { HOME_NAME_MAX } from '@/modules/studio/utils/homeLayout';
import type { HomeFolder } from '@/modules/studio/utils/homeLayout';
import { buildStatusText } from '@/modules/studio/utils/homeTiles';

// The lifted copy of an icon dragged inside the open folder; dropped outside the panel, it leaves the folder.
function FolderDragLayer({ tiles, iconSize, switchStateOf, overlayRef }: {
  tiles: StudioHomeTile[]; iconSize: number;
  switchStateOf: (tile: StudioHomeTile) => SwitchState | undefined;
  overlayRef: RefObject<HTMLElement>;
}) {
  const { active } = useDndContext();
  const tile = active ? tiles.find(item => item.id === active.id) : undefined;
  return <DragOverlay dropAnimation={null} className="home-drag-overlay">
    {tile && <div ref={overlayRef as RefObject<HTMLDivElement>} className="home-tile-slot is-lifted" aria-hidden="true">
      <span className="home-tile"><TileFace tile={tile} editing={false} iconSize={iconSize} switchState={switchStateOf(tile)} /></span>
    </div>}
  </DragOverlay>;
}

/** The folder's name: a heading, or in edit mode a field typed in place (Return or leaving it keeps the name). */
function FolderTitle({ name, editing, onRename }: { name: string; editing: boolean; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  if (!editing) return <h2 id="home-folder-title" className="home-folder-title">{name}</h2>;
  const commit = () => { if (draft.trim() && draft !== name) onRename(draft); else setDraft(name); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.stopPropagation(); setDraft(name); requestAnimationFrame(() => (event.target as HTMLInputElement).blur()); }
  };
  return <input id="home-folder-title" className="home-folder-title is-field" aria-label="文件夹名称" value={draft} maxLength={HOME_NAME_MAX * 2}
    enterKeyHint="done" autoComplete="off" spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={onKeyDown} />;
}

/**
 * Used by StudioHomeScreen for an open folder: its name above a frosted panel of its icons, grown out of the folder's
 * icon, as on iPadOS. A tap opens an app; in edit mode the icons jiggle, drag to reorder, leave the folder when
 * dropped outside the panel (or through their − badge), are renamed by tapping their name, and the folder's own name
 * becomes a field. A tap on the dimmed wallpaper (or Esc) closes it.
 */
export function StudioHomeFolder({ folder, tiles, defaultNameOf, editing, iconSize, labels, origin, switchStateOf, onEnterEdit, onActivate, onRenameTile, onRenameFolder, onMoveOut, onReorder, onClose }: {
  folder: HomeFolder;
  // The folder's apps, in its order, with their shown names.
  tiles: StudioHomeTile[];
  defaultNameOf: (id: string) => string;
  editing: boolean; iconSize: number; labels: boolean;
  // The folder icon's rectangle, which the panel grows out of; null opens it from the centre.
  origin: DOMRect | null;
  switchStateOf: (tile: StudioHomeTile) => SwitchState | undefined;
  onEnterEdit: () => void;
  onActivate: (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => void;
  onRenameTile: (id: string, name: string | null) => void;
  onRenameFolder: (name: string) => void;
  onMoveOut: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [renamingId, setRenaming] = useState<string | null>(null);
  // Leaving edit mode ends any rename.
  const renaming = editing ? renamingId : null;
  const ids = useMemo(() => tiles.map(tile => tile.id), [tiles]);
  const labelOf = useCallback((id: string) => tiles.find(tile => tile.id === id)?.name ?? id, [tiles]);
  // Dropped outside the panel, an icon leaves the folder for the home screen.
  const interceptDrop = useCallback(({ active, activatorEvent, delta }: DragEndEvent) => {
    const start = activatorEvent && !(activatorEvent instanceof KeyboardEvent) ? getEventCoordinates(activatorEvent) : null;
    const box = panelRef.current?.getBoundingClientRect();
    if (!start || !box) return false;
    const x = start.x + delta.x;
    const y = start.y + delta.y;
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return false;
    onMoveOut(String(active.id));
    return true;
  }, [onMoveOut]);
  const { containerRef, overlayRef, move, moveMessage, dndProps, sortableProps } = useHomeSortableList({
    ids, editing, onEnterEdit, onReorder, labelOf, interceptDrop,
  });
  const setGrid = useCallback((node: HTMLDivElement | null) => { containerRef.current = node; }, [containerRef]);

  // Esc closes the folder (a field being typed in handles its own Esc first).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  // Focus moves into the folder and back to the folder icon when it closes (StudioHomeScreen restores it).
  useEffect(() => { panelRef.current?.querySelector<HTMLElement>('.home-tile')?.focus({ preventScroll: true }); }, []);

  const style = (origin ? {
    '--folder-from-x': `${origin.left + origin.width / 2 - window.innerWidth / 2}px`,
    '--folder-from-y': `${origin.top + origin.height / 2 - window.innerHeight / 2}px`,
  } : {}) as CSSProperties;

  const activate = (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => {
    if (editing) {
      event.preventDefault();
      if ((event.target as Element).closest('.home-label')) setRenaming(tile.id);
      return;
    }
    onActivate(tile, event);
  };

  return <div className="home-folder-layer" style={style}>
    <div className="home-folder-scrim" aria-hidden="true" onClick={onClose} />
    <div className="home-folder" role="dialog" aria-modal="true" aria-labelledby="home-folder-title">
      {/* Keyed by the name, so a name changed elsewhere (another tab) starts a fresh draft. */}
      <FolderTitle key={folder.name} name={folder.name} editing={editing} onRename={onRenameFolder} />
      <DndContext {...dndProps}>
        <div ref={panelRef} className="home-folder-panel">
          <div ref={setGrid} className="home-grid home-folder-grid-open">
            <SortableContext {...sortableProps}>
              {tiles.map((tile, index) => {
                const progress = tile.progress;
                const status = progress ? buildStatusText(progress) : tile.status;
                return <SortableEntry key={tile.id} id={tile.id} name={tile.name} defaultName={defaultNameOf(tile.id)}
                  label={`${tile.name}${status ? `，${status}` : ''}`} title={labels ? undefined : tile.name} href={tile.href}
                  face={<TileFace tile={tile} editing={editing} iconSize={iconSize} switchState={switchStateOf(tile)} />}
                  index={index} last={index === tiles.length - 1} editing={editing} renaming={renaming === tile.id}
                  badge={{ kind: 'out', label: `把 ${tile.name} 移出文件夹`, onClick: () => onMoveOut(tile.id) }}
                  onActivate={event => activate(tile, event)} onMove={step => move(tile.id, step)}
                  onRenameStart={() => setRenaming(tile.id)}
                  onRename={name => { setRenaming(null); if (name !== null) onRenameTile(tile.id, name); }} />;
              })}
            </SortableContext>
          </div>
        </div>
        <FolderDragLayer tiles={tiles} iconSize={iconSize} switchStateOf={switchStateOf} overlayRef={overlayRef} />
        <p className="studio-visually-hidden" aria-live="polite">{moveMessage}</p>
      </DndContext>
      {editing && <p className="home-folder-hint">拖到面板外面，图标就会移回主屏幕</p>}
    </div>
  </div>;
}
