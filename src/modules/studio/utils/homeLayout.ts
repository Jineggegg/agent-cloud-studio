import { useCallback, useSyncExternalStore } from 'react';

import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';

// Per-device layout (hidden tiles, labels, icon size, icon order, folders): an iPad and a MacBook arrange differently.
export const HOME_LAYOUT_STORAGE_KEY = 'studio-home-layout-v1';
// Folder entries share the icons' order list under this prefix; tile ids never start with it.
export const HOME_FOLDER_PREFIX = 'folder:';
// A name typed under an icon or on a folder is cut to this many characters (the label truncates long before).
export const HOME_NAME_MAX = 24;

export type HomeFolder = { id: string; name: string; items: string[] };
// `order` is absent until the icons are first rearranged on this device; layouts saved before folders still load.
// `pageBreaks` lists the icons and folders that begin a page of their own (one dropped on a new page, as on iPadOS).
export type HomeLayout = { hidden: string[]; labels: boolean; large: boolean; order?: string[]; folders: HomeFolder[]; pageBreaks?: string[] };
export const DEFAULT_HOME_LAYOUT: HomeLayout = { hidden: [], labels: true, large: false, folders: [] };

const FOLDER_ID = /^[a-z0-9-]{1,40}$/;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Trims a typed name to one line of at most HOME_NAME_MAX characters (by code point, so emoji stay whole). */
export function cleanHomeName(value: string) {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, HOME_NAME_MAX).join('');
}

// Every tile sits in at most one folder (the first that lists it); folders without a usable id are dropped.
function readFolders(value: unknown): HomeFolder[] {
  if (!Array.isArray(value)) return [];
  const placed = new Set<string>();
  const folders: HomeFolder[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, items } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !FOLDER_ID.test(id) || folders.some(folder => folder.id === id)) continue;
    const kept = strings(items).filter(item => !item.startsWith(HOME_FOLDER_PREFIX) && !placed.has(item));
    kept.forEach(item => placed.add(item));
    folders.push({ id, name: typeof name === 'string' ? cleanHomeName(name) || '文件夹' : '文件夹', items: kept });
  }
  return folders;
}

function parseLayout(raw: string | null): HomeLayout {
  if (!raw) return DEFAULT_HOME_LAYOUT;
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof HomeLayout, unknown>> | null;
    if (!saved || typeof saved !== 'object') return DEFAULT_HOME_LAYOUT;
    return {
      hidden: strings(saved.hidden),
      labels: saved.labels !== false,
      large: saved.large === true,
      ...(Array.isArray(saved.order) ? { order: strings(saved.order) } : {}),
      folders: readFolders(saved.folders),
      ...(Array.isArray(saved.pageBreaks) && saved.pageBreaks.length ? { pageBreaks: strings(saved.pageBreaks) } : {}),
    };
  } catch { return DEFAULT_HOME_LAYOUT; }
}

// Kept when localStorage refuses (private mode), so the layout lasts the visit.
let memoryRaw: string | null = null;
let lastRaw: string | null | undefined;
let lastLayout = DEFAULT_HOME_LAYOUT;
const listeners = new Set<() => void>();

function readRaw() {
  try { return localStorage.getItem(HOME_LAYOUT_STORAGE_KEY); } catch { return memoryRaw; }
}

/** The saved layout; the same object until it changes (read again whenever the stored text differs). */
export function getHomeLayout(): HomeLayout {
  const raw = readRaw();
  if (raw !== lastRaw) { lastRaw = raw; lastLayout = parseLayout(raw); }
  return lastLayout;
}

/** Replaces the layout with `update(previous)`, saves it on this device and tells every subscriber. */
export function updateHomeLayout(update: (previous: HomeLayout) => HomeLayout) {
  const next = update(getHomeLayout());
  if (next === lastLayout) return;
  const raw = JSON.stringify(next);
  memoryRaw = raw;
  try { localStorage.setItem(HOME_LAYOUT_STORAGE_KEY, raw); } catch { /* Private mode keeps the layout for this visit only. */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab of Studio on this device changed it.
  const onStorage = (event: StorageEvent) => { if (event.key === HOME_LAYOUT_STORAGE_KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

/** Used by the home screen and Settings → 主屏幕: the layout and its updater, shared live between them. */
export function useHomeLayout() {
  const layout = useSyncExternalStore(subscribe, getHomeLayout, getHomeLayout);
  const update = useCallback((patch: Partial<HomeLayout> | ((previous: HomeLayout) => HomeLayout)) => {
    updateHomeLayout(previous => typeof patch === 'function' ? patch(previous) : { ...previous, ...patch });
  }, []);
  return [layout, update] as const;
}

// ---- Page breaks: icons that begin a page of their own. ----

/**
 * The breaks once `id` no longer begins its page (it moved, was hidden or went into a folder): the icon after it in
 * `shown` (the home screen's visible order) begins the page instead, so the rest of that page stays where it was.
 */
export function releasePageBreak(breaks: readonly string[] | undefined, shown: readonly string[], id: string): string[] {
  const kept = (breaks ?? []).filter(item => item !== id);
  if (!breaks?.includes(id)) return kept;
  const follower = shown[shown.indexOf(id) + 1];
  return follower && !kept.includes(follower) ? [...kept, follower] : kept;
}

/**
 * The breaks after `active` is dropped in `over`'s place (shown = the visible order before the drop). Dropped
 * backwards onto an icon that begins a page, it takes that icon's place at the start of the page.
 */
export function movePageBreaks(breaks: readonly string[] | undefined, shown: readonly string[], active: string, over: string): string[] {
  const from = shown.indexOf(active);
  const to = shown.indexOf(over);
  if (from < 0 || to < 0 || from === to) return [...(breaks ?? [])];
  const next = releasePageBreak(breaks, shown, active);
  return from > to && next.includes(over) ? next.map(item => item === over ? active : item) : next;
}

/** Without breaks that name nothing on the home screen, or the order's first icon; undefined when none are left. */
export function tidyPageBreaks(breaks: readonly string[], shown: readonly string[]): string[] | undefined {
  const kept = [...new Set(breaks)].filter(id => shown.indexOf(id) > 0);
  return kept.length ? kept : undefined;
}

// ---- Names typed under icons: synced through the user's preferences, so every device shows the same names. ----

export type HomeNames = Record<string, string>;
const EMPTY_NAMES: HomeNames = {};
let lastNamesKey = '';
let lastNames: HomeNames = EMPTY_NAMES;

function readNames(): HomeNames {
  const stored = readUserPreference<unknown>('homeNames', null);
  const key = JSON.stringify(stored ?? null);
  if (key === lastNamesKey) return lastNames;
  lastNamesKey = key;
  const names: HomeNames = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [id, name] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof name === 'string' && id.length <= 200 && cleanHomeName(name)) names[id] = cleanHomeName(name);
    }
  }
  lastNames = Object.keys(names).length ? names : EMPTY_NAMES;
  return lastNames;
}

/** Sets (or, with an empty or default name, removes) the name shown under one icon. */
export function writeHomeName(id: string, name: string, defaultName: string) {
  const cleaned = cleanHomeName(name);
  const { [id]: _previous, ...rest } = readNames();
  writeUserPreference('homeNames', cleaned && cleaned !== defaultName ? { ...rest, [id]: cleaned } : rest);
}

/** Drops every typed name (Settings → 主屏幕 → 恢复默认名称). */
export function clearHomeNames() {
  writeUserPreference('homeNames', {});
}

/** The typed names by tile id, live across devices once preferences sync. */
export function useHomeNames(): HomeNames {
  return useSyncExternalStore(subscribeToUserPreferences, readNames, readNames);
}
