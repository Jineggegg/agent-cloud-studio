import { useCallback, useEffect, useState } from 'react';

import type { WorkbenchInspectorTab, WorkbenchLayout } from '@/shared/types';

// Per device, like iPadOS split views: a phone and an iPad keep their own arrangement.
const STORAGE_KEY = 'acs-workbench-layout-v1';
const TABS: WorkbenchInspectorTab[] = ['files', 'terminal', 'git', 'preview'];
const DEFAULT_LAYOUT: WorkbenchLayout = { sidebarCollapsed: false, inspectorOpen: false, inspectorTab: 'files', inspectorWidth: 440 };
const MIN_INSPECTOR_WIDTH = 320;
const MAX_INSPECTOR_WIDTH = 1100;

/** Keeps a dragged inspector width inside the range the layout supports. */
export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_LAYOUT.inspectorWidth;
  return Math.round(Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, width)));
}

function readLayout(): WorkbenchLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<WorkbenchLayout> | null;
    if (!saved || typeof saved !== 'object') return DEFAULT_LAYOUT;
    return {
      sidebarCollapsed: saved.sidebarCollapsed === true,
      inspectorOpen: saved.inspectorOpen === true,
      inspectorTab: TABS.includes(saved.inspectorTab as WorkbenchInspectorTab) ? saved.inspectorTab as WorkbenchInspectorTab : DEFAULT_LAYOUT.inspectorTab,
      inspectorWidth: typeof saved.inspectorWidth === 'number' ? clampInspectorWidth(saved.inspectorWidth) : DEFAULT_LAYOUT.inspectorWidth,
    };
  } catch {
    // Private mode, blocked storage or a damaged value: start from the default arrangement.
    return DEFAULT_LAYOUT;
  }
}

/** Used by the workbench shell: the sidebar and inspector arrangement this device remembers between visits. */
export function useWorkbenchLayout() {
  // The remembered arrangement; every change is written back so the next visit opens the same way.
  const [layout, setLayout] = useState<WorkbenchLayout>(readLayout);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* storage unavailable: keep it for this visit */ }
  }, [layout]);

  const toggleSidebar = useCallback(() => setLayout(previous => ({ ...previous, sidebarCollapsed: !previous.sidebarCollapsed })), []);
  const setSidebarCollapsed = useCallback((sidebarCollapsed: boolean) => setLayout(previous => ({ ...previous, sidebarCollapsed })), []);
  const toggleInspector = useCallback(() => setLayout(previous => ({ ...previous, inspectorOpen: !previous.inspectorOpen })), []);
  const closeInspector = useCallback(() => setLayout(previous => ({ ...previous, inspectorOpen: false })), []);
  // Opening on a tab that is already showing closes the inspector, like tapping the active toolbar button.
  const showInspectorTab = useCallback((tab: WorkbenchInspectorTab, options: { toggle?: boolean } = {}) => setLayout(previous => (
    options.toggle && previous.inspectorOpen && previous.inspectorTab === tab
      ? { ...previous, inspectorOpen: false }
      : { ...previous, inspectorOpen: true, inspectorTab: tab }
  )), []);
  const setInspectorWidth = useCallback((width: number) => setLayout(previous => ({ ...previous, inspectorWidth: clampInspectorWidth(width) })), []);

  return { layout, toggleSidebar, setSidebarCollapsed, toggleInspector, closeInspector, showInspectorTab, setInspectorWidth };
}
