import { useCallback, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { STUDIO_AJ_EXIT_SHORTCUTS } from '@/shared/constants';

// Per device, like the home-screen layout: whether the owner has made the two Shortcuts here, and what Studio last
// asked Tailscale for. Nothing reads the real VPN state; a web page cannot.
const STORAGE_KEY = 'studio-aj-exit-v1';

export type AjExitState = { ready: boolean; on: boolean };
const NOT_SET_UP: AjExitState = { ready: false, on: false };

// Kept when localStorage refuses (private mode), so the state lasts the visit.
let memoryRaw: string | null = null;
let lastRaw: string | null | undefined;
let lastState = NOT_SET_UP;
const listeners = new Set<() => void>();

function readRaw() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return memoryRaw; }
}

function readState(): AjExitState {
  const raw = readRaw();
  if (raw === lastRaw) return lastState;
  lastRaw = raw;
  try {
    const saved = JSON.parse(raw ?? 'null') as Partial<AjExitState> | null;
    const ready = saved?.ready === true;
    lastState = { ready, on: ready && saved?.on === true };
  } catch { lastState = NOT_SET_UP; }
  return lastState;
}

function writeState(state: AjExitState) {
  const raw = JSON.stringify(state);
  memoryRaw = raw;
  try { localStorage.setItem(STORAGE_KEY, raw); } catch { /* Private mode: remembered for this visit only. */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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
 * Runs 开 or 关 and remembers it on this device. Must be called synchronously inside the owner's tap, so Safari
 * treats the switch to Shortcuts as their own action. `onSettings` adds a 设置 button to the toast.
 */
export function runAjExit(turnOn: boolean, onSettings?: () => void) {
  writeState({ ready: true, on: turnOn });
  toast(turnOn ? '正在开启 AJ 出口' : '正在关闭 AJ 出口', {
    description: `「快捷指令」会运行「${turnOn ? STUDIO_AJ_EXIT_SHORTCUTS.on : STUDIO_AJ_EXIT_SHORTCUTS.off}」，完成后轻点左上角返回 Studio。`,
    ...(onSettings ? { action: { label: '设置', onClick: onSettings } } : {}),
  });
  window.location.assign(shortcutUrl(turnOn));
}

/** Forgets the setup (the next tap shows the steps again) and the last request. */
export function resetAjExit() {
  writeState(NOT_SET_UP);
}

/** The device's AJ 出口 state, shared live by the home screen tile and Settings → AJ 出口. */
export function useAjExitState() {
  const state = useSyncExternalStore(subscribe, readState, readState);
  return { ...state, supported: hasShortcutsApp() };
}

/**
 * Used by StudioHomeScreen for the AJ 出口 tile: it switches this device's traffic to the Tailscale exit node on AJ's
 * server by running the owner's two Shortcuts. The first tap opens the setup sheet; once set up, a tap runs the
 * opposite of what Studio last asked for and remembers it on this device.
 */
export function useAjExit() {
  const { ready, on, supported } = useAjExitState();
  // The setup and settings sheet.
  const [sheetOpen, setSheetOpen] = useState(false);
  const openSheet = useCallback(() => setSheetOpen(true), []);

  /** A tap on the tile: the sheet until it is set up (or where Shortcuts is missing), otherwise the toggle. */
  const tap = useCallback(() => {
    if (!ready || !supported) { setSheetOpen(true); return; }
    runAjExit(!on, openSheet);
  }, [on, openSheet, ready, supported]);

  return {
    on,
    ready,
    supported,
    sheetOpen,
    tap,
    openSheet,
    closeSheet: useCallback(() => setSheetOpen(false), []),
    /** 已经建好: the Shortcuts exist; turn the exit node on straight away. */
    finishSetup: useCallback(() => { setSheetOpen(false); runAjExit(true, openSheet); }, [openSheet]),
    resetSetup: resetAjExit,
  };
}
