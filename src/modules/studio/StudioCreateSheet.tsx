import { useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, UIEvent } from 'react';
import { createPortal } from 'react-dom';

import { IconX } from '@/modules/studio/icons/tabler';
import '@/modules/studio/studio-create-sheet.css';

type Mode = 'build' | 'manual';
const MODES: { id: Mode; label: string }[] = [{ id: 'build', label: '让 AI 开发' }, { id: 'manual', label: '手动创建' }];

/**
 * Used by StudioPage for the home screen's +: one sheet that starts a new app with AI (让 AI 开发, the default) or sets
 * a project up by hand (手动创建). Both forms stay mounted while the owner switches, so neither draft is lost.
 *
 * Laid out like an iOS sheet: a fixed header (grabber on a phone, a centred title with a close button, the 创建方式
 * switch on its own row), then each form scrolling on its own beneath it. Each form ends in its own action bar, which
 * studio-create-sheet.css pins to the sheet's bottom edge so 开始开发 / 创建项目 stays in reach.
 */
export function StudioCreateSheet({ build, manual, onClose }: { build: ReactNode; manual: ReactNode; onClose: () => void }) {
  // Which way the new project starts; AI first, because describing an app is the main reason to tap +.
  const [mode, setMode] = useState<Mode>('build');
  // Whether each form has scrolled under the header, which then shows a hairline the way a navigation bar does.
  const [scrolled, setScrolled] = useState<Record<Mode, boolean>>({ build: false, manual: false });
  const switchRef = useRef<HTMLDivElement>(null);
  const onScroll = (which: Mode) => (event: UIEvent<HTMLDivElement>) => {
    const next = event.currentTarget.scrollTop > 2;
    setScrolled(current => current[which] === next ? current : { ...current, [which]: next });
  };
  // A radio group moves with the arrow keys and keeps one tab stop, like the system segmented control.
  const onSwitchKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next: Mode = mode === 'build' ? 'manual' : 'build';
    setMode(next);
    switchRef.current?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  };

  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />
    <div className="library-sheet project-sheet create-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-new-project-title"
      data-scrolled={scrolled[mode] ? '' : undefined}>
      <header className="create-sheet-header">
        <div className="library-grabber" aria-hidden="true" />
        <div className="create-sheet-titlebar">
          {/* Balances the close button so the title sits in the true centre. */}
          <span aria-hidden="true" />
          <h2 id="studio-new-project-title" className="create-sheet-title">新建项目</h2>
          <button type="button" className="create-sheet-close" aria-label="关闭" title="关闭" onClick={onClose}>
            <IconX size={17} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
        <div ref={switchRef} className="segmented create-sheet-mode" role="radiogroup" aria-label="创建方式" onKeyDown={onSwitchKeyDown}>
          {MODES.map(item => <button key={item.id} type="button" role="radio" data-mode={item.id} aria-checked={mode === item.id}
            tabIndex={mode === item.id ? 0 : -1} onClick={() => setMode(item.id)}>{item.label}</button>)}
        </div>
      </header>
      <div className="create-sheet-body" hidden={mode !== 'build'} onScroll={onScroll('build')}>{build}</div>
      <div className="create-sheet-body" hidden={mode !== 'manual'} onScroll={onScroll('manual')}>{manual}</div>
    </div>
  </div>, document.body);
}
