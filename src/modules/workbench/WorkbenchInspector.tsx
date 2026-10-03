import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, PointerEvent as ReactPointerEvent } from 'react';
import { m } from 'motion/react';
import { FileCode2, GitBranch, Globe, SquareTerminal, X } from 'lucide-react';
import type { LucideProps } from 'lucide-react';

import { WORKBENCH_DOCK_TWEEN, WORKBENCH_PANEL_SPRING } from '@/shared/constants';
import type { CodeEditorFile, DirectoryRevealRequest, FileOpenHandler, Project, WorkbenchInspectorTab, WorkbenchViewport } from '@/shared/types';
import { GitPanel } from '@/modules/git-panel';
import { StandaloneShell } from '@/modules/standalone-shell';
import { WorkbenchFilesPanel } from '@/modules/workbench/WorkbenchFilesPanel';
import { WorkbenchPreviewPanel } from '@/modules/workbench/WorkbenchPreviewPanel';
import { clampInspectorWidth } from '@/modules/workbench/hooks/useWorkbenchLayout';

const TABS: { id: WorkbenchInspectorTab; label: string; icon: ComponentType<LucideProps> }[] = [
  { id: 'files', label: '文件', icon: FileCode2 },
  { id: 'terminal', label: '终端', icon: SquareTerminal },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'preview', label: '预览', icon: Globe },
];
// The chat keeps at least this much room beside a docked inspector.
const MIN_CHAT_WIDTH = 360;
// Detected addresses kept for the preview chips.
const MAX_DETECTED = 8;
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

// Remembered per project on this device, so a reload (which does not replay the terminal) keeps the chips.
const detectedKey = (projectId: string) => `acs-workbench-preview:${projectId}`;
// Characters a shell prompt brings along when the server joins the line after a URL to it (user@host:~/dir$).
const PROMPT_RESIDUE = /[@$:~]/;

/**
 * The address worth previewing in a URL the terminal printed, or null. Dev servers announce local or tailnet
 * addresses, usually with a port; links to public sites are not previews. The server glues a following line that
 * looks like URL text (a shell prompt) onto the address, so a path carrying prompt characters falls back to the origin.
 */
function previewAddressOf(address: string): string | null {
  try {
    const url = new URL(address);
    const local = PRIVATE_HOST.test(url.hostname) || url.hostname.endsWith('.local') || url.hostname.endsWith('.ts.net') || Boolean(url.port);
    if (!local) return null;
    return PROMPT_RESIDUE.test(decodeURIComponent(url.pathname)) ? `${url.origin}/` : url.toString();
  } catch {
    return null;
  }
}

function readDetected(projectId: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(detectedKey(projectId)) ?? '[]') as unknown;
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string').slice(0, MAX_DETECTED) : [];
  } catch {
    return [];
  }
}

function useWindowWidth() {
  // Tracks the window so the inspector never squeezes the chat below its minimum.
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return width;
}

type WorkbenchInspectorProps = {
  project: Project;
  viewport: WorkbenchViewport;
  open: boolean;
  tab: WorkbenchInspectorTab;
  width: number;
  // Width already taken on the left (the docked sidebar), so the chat keeps its room.
  reservedWidth: number;
  editingFile: CodeEditorFile | null;
  revealDirectory: DirectoryRevealRequest | null;
  onTabChange: (tab: WorkbenchInspectorTab) => void;
  onClose: () => void;
  onWidthCommit: (width: number) => void;
  onOpenFile: FileOpenHandler;
  onCloseEditor: () => void;
  onUnsavedChangesChange: (hasUnsavedChanges: boolean) => void;
  onProjectSelect: (project: Project) => void;
  onProjectsRefresh: () => void;
};

/**
 * Used by the workbench shell as its right column: a slide-out, resizable inspector with 文件 / 终端 / Git / 预览.
 * Docked beside the chat on desktops, floating over it on tablets and full screen on phones. Panels mount on first
 * use and stay mounted while hidden, so the terminal keeps its shell and the tree its folders.
 */
export function WorkbenchInspector({
  project, viewport, open, tab, width, reservedWidth, editingFile, revealDirectory,
  onTabChange, onClose, onWidthCommit, onOpenFile, onCloseEditor, onUnsavedChangesChange, onProjectSelect, onProjectsRefresh,
}: WorkbenchInspectorProps) {
  const windowWidth = useWindowWidth();
  const panel = useRef<HTMLElement>(null);
  // Panels opened at least once; they stay mounted afterwards.
  const [visited, setVisited] = useState<WorkbenchInspectorTab[]>(() => (open ? [tab] : []));
  if (open && !visited.includes(tab)) setVisited([...visited, tab]);
  // The live width while the edge is being dragged; committed to the remembered layout on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // The editor asked for more room (its expand button): the inspector takes all the width the chat can spare.
  const [expanded, setExpanded] = useState(false);
  // Addresses the terminal printed that look like a dev server, newest first (the shell keys this by project).
  const [detected, setDetected] = useState<string[]>(() => readDetected(project.projectId));
  // A new address arrived while the preview was out of sight; its tab shows a dot.
  const [previewUnseen, setPreviewUnseen] = useState(false);

  const docked = viewport === 'desktop';
  const maxWidth = docked ? Math.max(320, windowWidth - reservedWidth - MIN_CHAT_WIDTH) : Math.max(320, windowWidth - 32);
  const baseWidth = Math.min(dragWidth ?? width, maxWidth);
  const panelWidth = viewport === 'phone' ? windowWidth : expanded && editingFile ? maxWidth : baseWidth;
  const previewVisible = open && tab === 'preview';
  if (previewVisible && previewUnseen) setPreviewUnseen(false);

  // A closed inspector leaves the tab order and the accessibility tree.
  useEffect(() => {
    if (panel.current) panel.current.inert = !open;
  }, [open]);

  const projectId = project.projectId;
  const onUrlDetected = useCallback((printed: string) => {
    const address = previewAddressOf(printed);
    if (!address) return;
    setDetected(previous => {
      const next = [address, ...previous.filter(item => item !== address)].slice(0, MAX_DETECTED);
      try { localStorage.setItem(detectedKey(projectId), JSON.stringify(next)); } catch { /* storage unavailable: chips last this visit */ }
      return next;
    });
    setPreviewUnseen(true);
  }, [projectId]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (viewport === 'phone') return;
    event.preventDefault();
    const right = panel.current?.getBoundingClientRect().right ?? window.innerWidth;
    let latest = baseWidth;
    const move = (moveEvent: PointerEvent) => {
      latest = Math.min(maxWidth, clampInspectorWidth(right - moveEvent.clientX));
      setDragWidth(latest);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('wb-resizing');
      setDragWidth(null);
      setExpanded(false);
      onWidthCommit(latest);
    };
    document.body.classList.add('wb-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const closeEditor = () => { setExpanded(false); onCloseEditor(); };
  const variant = docked ? 'dock' : viewport === 'phone' ? 'sheet' : 'float';
  // Every variant names width, x and visibility, so rotating an iPad (tablet ↔ desktop) never leaves the other
  // variant's slide or width behind; the panels stay mounted through the change. A drag follows the pointer.
  const animate = docked
    ? { width: open ? panelWidth : 0, x: 0, visibility: 'visible' as const }
    : open
      ? { width: panelWidth, x: 0, visibility: 'visible' as const }
      : { width: panelWidth, x: '104%', transitionEnd: { visibility: 'hidden' as const } };
  const settle = docked ? WORKBENCH_DOCK_TWEEN : WORKBENCH_PANEL_SPRING;
  const transition = dragWidth !== null ? { default: settle, width: { duration: 0 } } : settle;

  return <m.aside ref={panel} className={`wb-inspector is-${variant}`} data-open={open || undefined} aria-label="检查器" aria-hidden={!open || undefined}
    initial={false} animate={animate} transition={transition}>
    <div className="wb-inspector-inner" style={{ width: panelWidth }}>
      {viewport !== 'phone' && <div className="wb-resize-handle" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度"
        onPointerDown={startResize} onDoubleClick={() => { setExpanded(false); onWidthCommit(440); }} />}
      <header className="wb-inspector-head">
        <div className="wb-segmented" role="tablist" aria-label="检查器面板">
          {TABS.map(item => {
            const Icon = item.icon;
            const selected = item.id === tab;
            return <button type="button" role="tab" key={item.id} id={`wb-tab-${item.id}`} aria-selected={selected} aria-controls={`wb-panel-${item.id}`}
              className="wb-segment" onClick={() => onTabChange(item.id)}>
              {selected && <m.span layoutId="wb-inspector-tab" className="wb-segment-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} aria-hidden="true" />}
              <Icon size={15} aria-hidden="true" />
              <span>{item.label}</span>
              {item.id === 'preview' && previewUnseen && !selected && <i className="wb-segment-dot" aria-label="有新地址" />}
            </button>;
          })}
        </div>
        <button type="button" className="icon-button plain" onClick={onClose} aria-label="关闭检查器" title="关闭检查器"><X size={19} aria-hidden="true" /></button>
      </header>

      <div className="wb-inspector-body">
        {visited.includes('files') && <section id="wb-panel-files" role="tabpanel" aria-labelledby="wb-tab-files" className="wb-panel" hidden={tab !== 'files'}>
          <WorkbenchFilesPanel project={project} editingFile={editingFile} revealDirectory={revealDirectory} expanded={expanded}
            onOpenFile={onOpenFile} onCloseEditor={closeEditor} onUnsavedChangesChange={onUnsavedChangesChange} onToggleExpand={() => setExpanded(value => !value)} />
        </section>}
        {visited.includes('terminal') && <section id="wb-panel-terminal" role="tabpanel" aria-labelledby="wb-tab-terminal" className="wb-panel is-terminal" hidden={tab !== 'terminal'}>
          <StandaloneShell project={project} command={null} isPlainShell minimal isActive={open && tab === 'terminal'} onUrlDetected={onUrlDetected} />
        </section>}
        {visited.includes('git') && <section id="wb-panel-git" role="tabpanel" aria-labelledby="wb-tab-git" className="wb-panel" hidden={tab !== 'git'}>
          <GitPanel selectedProject={project} isMobile={viewport === 'phone'} onFileOpen={onOpenFile} onProjectSelect={onProjectSelect} onProjectsRefresh={onProjectsRefresh} />
        </section>}
        {visited.includes('preview') && <section id="wb-panel-preview" role="tabpanel" aria-labelledby="wb-tab-preview" className="wb-panel" hidden={tab !== 'preview'}>
          <WorkbenchPreviewPanel detected={detected} onOpenTerminal={() => onTabChange('terminal')} />
        </section>}
      </div>
    </div>
  </m.aside>;
}
