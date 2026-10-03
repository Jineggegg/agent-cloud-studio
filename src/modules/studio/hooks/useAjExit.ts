import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { STUDIO_AJ_EXIT_SHORTCUTS } from '@/shared/constants';

// Per device, like the home-screen layout: whether the owner has made the two Shortcuts here, and what Studio last
// asked Tailscale for. Nothing reads the real VPN state; a web page cannot.
const STORAGE_KEY = 'studio-aj-exit-v1';

type AjExitState = { ready: boolean; on: boolean };
const NOT_SET_UP: AjExitState = { ready: false, on: false };

function readState(): AjExitState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AjExitState> | null;
    const ready = saved?.ready === true;
    return { ready, on: ready && saved?.on === true };
  } catch { return NOT_SET_UP; }
}

function writeState(state: AjExitState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Private mode: remembered for this visit only. */ }
}

// Opened from the home screen (an installed web app) rather than in Safari.
function isStandalone() {
  const appleStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return appleStandalone || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
}

// iPad (which reports itself as a Mac), iPhone or Mac: the devices with the Shortcuts app and its URL scheme.
function hasShortcutsApp() {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(navigator.userAgent);
}

/**
 * The Shortcuts URL that runs one of the two shortcuts. When it finishes, Shortcuts returns to Studio through
 * x-success, except from the installed web app (iOS would open that address in Safari instead of going back) and
 * when turning off from a tailnet (*.ts.net) address, which stops loading once Tailscale is disconnected.
 */
function shortcutUrl(turnOn: boolean) {
  const name = turnOn ? STUDIO_AJ_EXIT_SHORTCUTS.on : STUDIO_AJ_EXIT_SHORTCUTS.off;
  const tailnet = /\.ts\.net$/i.test(window.location.hostname);
  const returnTo = !isStandalone() && (turnOn || !tailnet) ? `&x-success=${encodeURIComponent(window.location.href)}` : '';
  return `shortcuts://x-callback-url/run-shortcut?name=${encodeURIComponent(name)}${returnTo}`;
}

/**
 * Used by StudioHomeScreen for the AJ 出口 tile: it switches this device's traffic to the Tailscale exit node on AJ's
 * server by running the owner's two Shortcuts. The first tap opens the setup sheet; once set up, a tap runs the
 * opposite of what Studio last asked for and remembers it on this device.
 */
export function useAjExit() {
  // Whether the Shortcuts exist on this device and whether the last request was 开; persisted per device.
  const [state, setState] = useState<AjExitState>(readState);
  // The setup and settings sheet.
  const [sheetOpen, setSheetOpen] = useState(false);
  const supported = hasShortcutsApp();

  const remember = useCallback((next: AjExitState) => {
    writeState(next);
    setState(next);
  }, []);

  const run = useCallback((turnOn: boolean) => {
    remember({ ready: true, on: turnOn });
    toast(turnOn ? '正在开启 AJ 出口' : '正在关闭 AJ 出口', {
      description: `「快捷指令」会运行「${turnOn ? STUDIO_AJ_EXIT_SHORTCUTS.on : STUDIO_AJ_EXIT_SHORTCUTS.off}」。`,
      action: { label: '设置', onClick: () => setSheetOpen(true) },
    });
    // Synchronously inside the tap, so Safari treats the switch to Shortcuts as the owner's own action.
    window.location.assign(shortcutUrl(turnOn));
  }, [remember]);

  /** A tap on the tile: the sheet until it is set up (or where Shortcuts is missing), otherwise the toggle. */
  const tap = useCallback(() => {
    if (!state.ready || !supported) { setSheetOpen(true); return; }
    run(!state.on);
  }, [run, state, supported]);

  return {
    on: state.on,
    ready: state.ready,
    supported,
    sheetOpen,
    tap,
    openSheet: useCallback(() => setSheetOpen(true), []),
    closeSheet: useCallback(() => setSheetOpen(false), []),
    /** 已经建好: the Shortcuts exist; turn the exit node on straight away. */
    finishSetup: useCallback(() => { setSheetOpen(false); run(true); }, [run]),
    /** Forget the setup (the next tap shows the steps again) and the last request. */
    resetSetup: useCallback(() => remember(NOT_SET_UP), [remember]),
  };
}
