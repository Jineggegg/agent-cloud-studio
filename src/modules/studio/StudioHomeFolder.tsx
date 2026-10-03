import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { SortableContext } from '@dnd-kit/sortable';
import type { SortableContextProps } from '@dnd-kit/sortable';

import type { StudioHomeTile } from '@/shared/types';
import { SortableEntry, TileFace } from '@/modules/studio/StudioHomeTiles';
import type { SwitchState } from '@/modules/studio/StudioHomeTiles';
import { HOME_NAME_MAX } from '@/modules/studio/utils/homeLayout';
import type { HomeFolder } from '@/modules/studio/utils/homeLayout';
import { buildStatusText } from '@/modules/studio/utils/homeTiles';

// React 18 has no `inert` prop; an empty string sets the attribute.
const INERT = { inert: '' } as Record<string, string>;

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

/** What StudioHomeScreen lends the folder's grid: the folder's icons sort inside the home screen's own drag context. */
export type FolderSortable = {
  gridRef: (node: HTMLDivElement | null) => void;
  sortableProps: Pick<SortableContextProps, 'items' | 'strategy'>;
  move: (id: string, step: -1 | 1) => void;
  moveMessage: string;
};

/**
 * Used by StudioHomeScreen for an open folder: its name above a frosted panel of its icons, grown out of the folder's
 * icon, as on iPadOS. A tap opens an app; in edit mode the icons jiggle, drag to reorder, are renamed by tapping
 * their name, and the folder's own name becomes a field. An icon dragged out of the panel closes the folder and stays
 * under the finger on the home screen (the home screen owns the drag, so the icons share one drag context), or
 * leaves through its − badge. A tap on the dimmed wallpaper (or Esc) closes it; `closing` plays the panel back into
 * the folder icon, inert, before the home screen unmounts it.
 */
export function StudioHomeFolder({ folder, tiles, defaultNameOf, editing, iconSize, labels, origin, closing = false, switchStateOf, sortable, panelRef, onActivate, onRenameTile, onRenameFolder, onMoveOut, onClose }: {
  folder: HomeFolder;
  // The folder's apps, in its order, with their shown names.
  tiles: StudioHomeTile[];
  defaultNameOf: (id: string) => string;
  editing: boolean; iconSize: number; labels: boolean;
  // The folder icon's rectangle, which the panel grows out of (and shrinks back into); null uses the centre.
  origin: DOMRect | null;
  closing?: boolean;
  switchStateOf: (tile: StudioHomeTile) => SwitchState | undefined;
  sortable: FolderSortable;
  // The frosted panel: an icon dragged beyond it leaves the folder.
  panelRef: RefObject<HTMLDivElement>;
  onActivate: (tile: StudioHomeTile, event: MouseEvent<HTMLElement>) => void;
  onRenameTile: (id: string, name: string | null) => void;
  onRenameFolder: (name: string) => void;
  onMoveOut: (id: string) => void;
  onClose: () => void;
}) {
  const [renamingId, setRenaming] = useState<string | null>(null);
  // Leaving edit mode ends any rename.
  const renaming = editing ? renamingId : null;
  const { gridRef, sortableProps, move, moveMessage } = sortable;
  const setPanel = useCallback((node: HTMLDivElement | null) => { (panelRef as { current: HTMLDivElement | null }).current = node; }, [panelRef]);

  // Esc closes the folder (a field being typed in handles its own Esc first).
  useEffect(() => {
    if (closing) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closing, onClose]);
  // Focus moves into the folder and back to the folder icon when it closes (StudioHomeScreen restores it).
  useEffect(() => { if (!closing) panelRef.current?.querySelector<HTMLElement>('.home-tile')?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Closing, the panel is a picture of the folder shrinking away: no dialog, no sortable icons, nothing to press.
  if (closing) {
    return <div className="home-folder-layer is-closing" style={style} aria-hidden="true" {...INERT}>
      <div className="home-folder-scrim" />
      <div className="home-folder">
        <h2 className="home-folder-title">{folder.name}</h2>
        <div className="home-folder-panel">
          <div className="home-grid home-folder-grid-open">
            {tiles.map(tile => <div key={tile.id} className="home-tile-slot"><span className="home-tile">
              <TileFace tile={tile} editing={false} iconSize={iconSize} switchState={switchStateOf(tile)} />
            </span></div>)}
          </div>
        </div>
      </div>
    </div>;
  }

  return <div className="home-folder-layer" style={style}>
    <div className="home-folder-scrim" aria-hidden="true" onClick={onClose} />
    <div className="home-folder" role="dialog" aria-modal="true" aria-labelledby="home-folder-title">
      {/* Keyed by the name, so a name changed elsewhere (another tab) starts a fresh draft. */}
      <FolderTitle key={folder.name} name={folder.name} editing={editing} onRename={onRenameFolder} />
      <div ref={setPanel} className="home-folder-panel">
        <div ref={gridRef} className="home-grid home-folder-grid-open">
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
      <p className="studio-visually-hidden" aria-live="polite">{moveMessage}</p>
    </div>
  </div>;
}
