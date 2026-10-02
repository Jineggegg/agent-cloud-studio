import { useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Used by StudioPage for the home screen's +: one sheet that starts a new app with AI (让 AI 开发, the default) or sets
 * a project up by hand (手动创建). Both forms stay mounted while the owner switches, so neither draft is lost.
 */
export function StudioCreateSheet({ build, manual, onClose }: { build: ReactNode; manual: ReactNode; onClose: () => void }) {
  // Which way the new project starts; AI first, because describing an app is the main reason to tap +.
  const [mode, setMode] = useState<'build' | 'manual'>('build');
  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />
    <div className="library-sheet project-sheet create-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-new-project-title">
      <div className="library-grabber" aria-hidden="true" />
      <header>
        <h2 id="studio-new-project-title">新建项目</h2>
        <div className="segmented" role="radiogroup" aria-label="创建方式">
          <button type="button" role="radio" aria-checked={mode === 'build'} onClick={() => setMode('build')}>让 AI 开发</button>
          <button type="button" role="radio" aria-checked={mode === 'manual'} onClick={() => setMode('manual')}>手动创建</button>
        </div>
      </header>
      <div className="create-sheet-body" hidden={mode !== 'build'}>{build}</div>
      <div className="create-sheet-body" hidden={mode !== 'manual'}>{manual}</div>
    </div>
  </div>, document.body);
}
