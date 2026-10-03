import { useCallback, useSyncExternalStore } from 'react';

import type { QuotaDisplayMode, QuotaPreferences } from '@/shared/types';

// Per device, like the home-screen layout (studio-home-layout-v1, studio-widgets-v1).
const STORAGE_KEY = 'studio-quota-display-v1';
// Bounds on what a stored value may hold, so a corrupted entry cannot grow without limit.
const MAX_ITEM_CHOICES = 200;
const MAX_ITEM_KEY_LENGTH = 200;
const DEFAULT_PREFERENCES: QuotaPreferences = { mode: 'remaining', items: {} };

// Components showing quota figures on this page; each re-reads the preferences when told.
const listeners = new Set<() => void>();
// The value a refused write (private mode, full storage) left behind; it wins until a write succeeds.
let unsavedRaw: string | null = null;
// The last parsed value with the text it came from, so unchanged storage returns the same object to React.
let lastRead: { raw: string | null; preferences: QuotaPreferences } | null = null;

function readRaw(): string | null {
  if (unsavedRaw !== null) return unsavedRaw;
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

// Anything unreadable falls back to the defaults; only boolean choices with sane keys survive.
function parse(raw: string | null): QuotaPreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const saved = JSON.parse(raw) as { mode?: unknown; items?: unknown } | null;
    const mode: QuotaDisplayMode = saved?.mode === 'used' ? 'used' : 'remaining';
    const items: Record<string, boolean> = {};
    if (saved?.items && typeof saved.items === 'object' && !Array.isArray(saved.items)) {
      for (const [key, shown] of Object.entries(saved.items).slice(0, MAX_ITEM_CHOICES)) {
        if (typeof shown === 'boolean' && key.length <= MAX_ITEM_KEY_LENGTH) items[key] = shown;
      }
    }
    return { mode, items };
  } catch { return DEFAULT_PREFERENCES; }
}

function readPreferences(): QuotaPreferences {
  const raw = readRaw();
  if (!lastRead || lastRead.raw !== raw) lastRead = { raw, preferences: parse(raw) };
  return lastRead.preferences;
}

function writePreferences(next: QuotaPreferences) {
  const raw = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, raw);
    unsavedRaw = null;
  } catch {
    // Kept for this visit only.
    unsavedRaw = raw;
  }
  for (const listener of listeners) listener();
}

// Another tab of this device changing the choice updates this one too.
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) listener(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Used by the studio module (home quota widgets and the quota section of Settings) and the workbench module (its
 * usage panel), so both show the same items the same way: whether figures read as 剩余 (left, the default) or
 * 已用 (used), and which items the owner switched on or off. Saved in localStorage per device, as the home-screen
 * layout is; when storage refuses the write the choice still holds for this visit. Every mounted consumer
 * updates at once, including those in other tabs.
 */
export function useQuotaPreferences() {
  const preferences = useSyncExternalStore(subscribe, readPreferences, readPreferences);
  const setMode = useCallback((mode: QuotaDisplayMode) => writePreferences({ ...readPreferences(), mode }), []);
  const setItemShown = useCallback((key: string, shown: boolean) => {
    const current = readPreferences();
    writePreferences({ ...current, items: { ...current.items, [key]: shown } });
  }, []);
  return { preferences, setMode, setItemShown };
}
