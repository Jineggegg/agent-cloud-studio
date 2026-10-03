import { useEffect } from 'react';
import { toast } from 'sonner';

import { api } from '@/shared/api';

// While the page is visible, how often the served build is compared with the one it booted with.
const CHECK_INTERVAL_MS = 5 * 60_000;
// Visibility flips, reconnects and ticks closer together than this share one check.
const MIN_CHECK_GAP_MS = 10_000;
// A check that has not answered by then is abandoned (and simply tried again next time).
const CHECK_TIMEOUT_MS = 10_000;
// After a failed check right after the page came back, one more try this much later.
const RESUME_RETRY_MS = 2_000;
// A reload is only automatic this soon after the page came back from the background, before the owner is using it.
const RESUME_RELOAD_WINDOW_MS = 10_000;
// index.html is a few kilobytes; a far larger answer is not it.
const MAX_INDEX_HTML_CHARS = 512 * 1024;
// sessionStorage: the build this tab last reloaded itself to. A reload that still booted the old build (an
// intermediary serving a stale page) is then not repeated in a loop; the toast offers it instead.
const RELOAD_MARKER_KEY = 'acs-frontend-update-reload';
const RELOAD_MARKER_TTL_MS = 10 * 60_000;
const UPDATE_TOAST_ID = 'studio-frontend-update';
// Set by the build (vite.config.js, nonBlockingEntryStylesheet) on the entry stylesheet link, and only there:
// stylesheets Vite adds at runtime for lazy chunks do not carry it.
const ENTRY_STYLE_SELECTOR = 'link[data-acs-entry-style][href]';
// Anything a reload would close under the owner: sheets, dialogs, covers and alert dialogs.
const OPEN_LAYER_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
// <input> types whose value is something typed.
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

type FrontendUpdateWatcherOptions = {
  // Loads the new build (window.location.reload in the app).
  reload: () => void;
  // Offers the update when reloading on its own would interrupt the owner; `reload` loads it.
  notify: (reload: () => void) => void;
};

// The hashed module script (and entry stylesheet) a built index.html names. Both change whenever the build's
// code or styles do, and a development page (/src/main.tsx) has none, so null means "cannot tell".
function readFrontendBuildSignature(root: ParentNode): string | null {
  const scripts = Array.from(root.querySelectorAll('script[type="module"][src]'), node => node.getAttribute('src') ?? '')
    .filter(src => src.includes('/assets/'));
  if (!scripts.length) return null;
  const styles = Array.from(root.querySelectorAll(ENTRY_STYLE_SELECTOR), node => node.getAttribute('href') ?? '');
  return [...new Set([...scripts, ...styles])].sort().join(' ');
}

// The deployment prefix in front of /assets/ ('' at the domain root), or null for a cross-origin entry.
function readEntryBasePath(): string | null {
  const src = document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  if (!src) return null;
  try {
    const url = new URL(src, window.location.href);
    if (url.origin !== window.location.origin) return null;
    return url.pathname.slice(0, url.pathname.indexOf('/assets/'));
  } catch {
    return null;
  }
}

// The build signature of the index.html the server serves now, or null when the answer is not a built page.
async function fetchServedSignature(basePath: string, signal: AbortSignal): Promise<string | null> {
  const response = await api.webClient.indexHtml(basePath, signal);
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return null;
  const html = await response.text();
  if (html.length > MAX_INDEX_HTML_CHARS) return null;
  return readFrontendBuildSignature(new DOMParser().parseFromString(html, 'text/html'));
}

function hasFocusedTextWithContent(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLTextAreaElement) return focused.value.trim().length > 0;
  if (focused instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(focused.type) && focused.value.trim().length > 0;
  return focused instanceof HTMLElement && focused.isContentEditable && (focused.textContent ?? '').trim().length > 0;
}

function recentlyReloadedTo(signature: string, now: number): boolean {
  try {
    const marker = JSON.parse(sessionStorage.getItem(RELOAD_MARKER_KEY) ?? 'null') as { to?: unknown; at?: unknown } | null;
    return marker?.to === signature && typeof marker.at === 'number' && now - marker.at < RELOAD_MARKER_TTL_MS;
  } catch {
    return false;
  }
}

function rememberReload(signature: string, now: number) {
  try {
    sessionStorage.setItem(RELOAD_MARKER_KEY, JSON.stringify({ to: signature, at: now }));
  } catch {
    // Storage blocked: the loop guard is lost, the reload itself still happens.
  }
}

/**
 * Used by useFrontendUpdateWatcher below (and exported for its tests) to keep a long-lived page, such as the
 * iPad home-screen app, from running an old bundle against a redeployed server, where API shapes may have moved.
 *
 * Compares the entry bundles named by the served index.html (fetched with `cache: 'no-store'`; it says nothing
 * the public page does not) with the ones this page booted with, when the page comes back from the background,
 * when the network returns and every five minutes while visible. On a difference the page reloads by itself if
 * the owner cannot lose anything: it came back from the background within the last ten seconds, has not been
 * touched since, no sheet or dialog is open and no focused field holds text; otherwise `notify` offers a refresh.
 * Unrecognisable answers (offline, a login or error page, a timeout) are ignored. A development page, which has
 * no hashed entry bundle, starts no checks. Returns the function that stops watching.
 */
export function startFrontendUpdateWatcher(options: FrontendUpdateWatcherOptions): () => void {
  const bootSignature = readFrontendBuildSignature(document);
  const basePath = bootSignature === null ? null : readEntryBasePath();
  if (bootSignature === null || basePath === null) return () => {};

  let stopped = false;
  let hiddenSince: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
  let resumedAt: number | null = null;
  let lastInteractionAt = 0;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let inFlight: AbortController | null = null;
  let offeredSignature: string | null = null;
  let retryTimer: number | null = null;
  // The return (resumedAt) a retry was already spent on: one retry per return, however the retry ends.
  let retriedResumeAt: number | null = null;

  const reloadTo = (signature: string) => {
    rememberReload(signature, Date.now());
    options.reload();
  };

  const canReloadUnnoticed = (now: number) => document.visibilityState === 'visible'
    && resumedAt !== null && now - resumedAt <= RESUME_RELOAD_WINDOW_MS && lastInteractionAt < resumedAt
    && !document.querySelector(OPEN_LAYER_SELECTOR) && !hasFocusedTextWithContent();

  const check = async () => {
    const startedAt = Date.now();
    if (stopped || inFlight || document.visibilityState !== 'visible' || startedAt - lastCheckAt < MIN_CHECK_GAP_MS) return;
    lastCheckAt = startedAt;
    const controller = new AbortController();
    inFlight = controller;
    const timer = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    let served: string | null = null;
    let failed = false;
    try {
      // The race keeps a fetch that ignores its signal from holding the watcher.
      served = await Promise.race([
        fetchServedSignature(basePath, controller.signal),
        new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
      ]);
      failed = controller.signal.aborted;
    } catch {
      failed = true;
    } finally {
      window.clearTimeout(timer);
      inFlight = null;
    }
    if (stopped) return;
    if (failed) {
      // No answer is not "no update": the next trigger may check at once, and a page that just came back
      // (iOS often has no network for its first request after waking) tries once more shortly.
      lastCheckAt = Number.NEGATIVE_INFINITY;
      if (resumedAt !== null && retriedResumeAt !== resumedAt && Date.now() - resumedAt < RESUME_RELOAD_WINDOW_MS) {
        retriedResumeAt = resumedAt;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => { retryTimer = null; void check(); }, RESUME_RETRY_MS);
      }
      return;
    }
    if (served === null || served === bootSignature) return;
    const decidedAt = Date.now();
    if (canReloadUnnoticed(decidedAt) && !recentlyReloadedTo(served, decidedAt)) {
      reloadTo(served);
      return;
    }
    // Offered once per new build while in use, and again each time the page comes back to it.
    const justResumed = resumedAt !== null && decidedAt - resumedAt <= RESUME_RELOAD_WINDOW_MS;
    if (offeredSignature !== served || justResumed) {
      offeredSignature = served;
      const target = served;
      options.notify(() => reloadTo(target));
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') {
      hiddenSince ??= Date.now();
      return;
    }
    if (hiddenSince === null) return;
    hiddenSince = null;
    resumedAt = Date.now();
    void check();
  };
  // A page restored from the back/forward cache comes back without having been reloaded.
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    resumedAt = Date.now();
    void check();
  };
  const onOnline = () => { void check(); };
  const onInteraction = () => { lastInteractionAt = Date.now(); };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);
  window.addEventListener('pointerdown', onInteraction, { capture: true, passive: true });
  window.addEventListener('keydown', onInteraction, { capture: true, passive: true });
  const interval = window.setInterval(() => { void check(); }, CHECK_INTERVAL_MS);

  return () => {
    stopped = true;
    inFlight?.abort();
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('pointerdown', onInteraction, { capture: true });
    window.removeEventListener('keydown', onInteraction, { capture: true });
  };
}

/**
 * Used by the Studio home's refresh button (StudioPage): a tap is the owner asking for the latest, so when the
 * server now serves a newer build than this page booted with, it is loaded at once (`reload`, by default
 * window.location.reload) and the promise resolves true; otherwise it resolves false and the caller refreshes
 * its data as usual. No answer within ten seconds, a failed or unrecognisable answer, or a development page
 * (no hashed entry bundle) all resolve false. The background watcher's loop guard does not apply: each tap asks.
 */
export async function reloadIfNewBuild(reload: () => void = () => window.location.reload()): Promise<boolean> {
  const bootSignature = readFrontendBuildSignature(document);
  const basePath = bootSignature === null ? null : readEntryBasePath();
  if (bootSignature === null || basePath === null) return false;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const served = await Promise.race([
      fetchServedSignature(basePath, controller.signal),
      new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
    ]);
    if (served === null || served === bootSignature) return false;
    rememberReload(served, Date.now());
    reload();
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Used by App (src/App.tsx), once for the whole app, so a page left open across a deploy picks up the new build:
 * it reloads by itself when that cannot interrupt anything, and otherwise shows a "Studio 已更新" toast with a
 * 刷新 action (rendered by whichever screen's Toaster is mounted). See startFrontendUpdateWatcher.
 */
export function useFrontendUpdateWatcher() {
  useEffect(() => startFrontendUpdateWatcher({
    reload: () => window.location.reload(),
    notify: reload => {
      toast('Studio 已更新', {
        id: UPDATE_TOAST_ID,
        description: '刷新即可使用新版本。',
        duration: Number.POSITIVE_INFINITY,
        action: { label: '刷新', onClick: reload },
      });
    },
  }), []);
}
