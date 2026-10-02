import { useEffect, useRef } from 'react';

type WorkbenchShortcutHandlers = {
  onSearch: () => void;
  onNewChat: () => void;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
};

/**
 * Used by the workbench shell for its keyboard shortcuts: ⌘/Ctrl+K search sessions, ⌘/Ctrl+N (or ⌘⇧O, which
 * browsers never reserve) new chat, ⌘/Ctrl+\ sidebar and ⌘/Ctrl+J inspector. Inside the terminal a Ctrl chord
 * belongs to the shell (Ctrl+K, Ctrl+J and Ctrl+N edit the command line), so only ⌘ works there.
 */
export function useWorkbenchShortcuts(handlers: WorkbenchShortcutHandlers) {
  // The latest handlers, so the window listener is attached once.
  const latest = useRef(handlers);
  useEffect(() => { latest.current = handlers; }, [handlers]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.ctrlKey && !event.metaKey && target?.closest('.xterm')) return;
      const key = event.key.toLowerCase();
      let action: (() => void) | null = null;
      if (key === 'k' && !event.shiftKey) action = latest.current.onSearch;
      else if ((key === 'n' && !event.shiftKey) || (key === 'o' && event.shiftKey)) action = latest.current.onNewChat;
      else if (key === '\\' || event.code === 'Backslash') action = latest.current.onToggleSidebar;
      else if (key === 'j' && !event.shiftKey) action = latest.current.onToggleInspector;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
