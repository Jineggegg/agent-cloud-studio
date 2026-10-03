import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type {
  Project, ProjectSession, QuickSettingsTab, QuotaDisplayItem, QuotaDisplayMode, QuotaPreferences, SlashCommand, StudioIngressId,
  StudioQuotaCredit, StudioQuotaSnapshot, StudioQuotaWindow,
} from '@/shared/types';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- STUDIO FRONT DOORS (docs/network.md) ------------

// Query parameter that carries a one-time handoff code to the other front door.
const HANDOFF_QUERY_PARAM = 'handoff';
// Per-origin localStorage key of this device's preferred door; the value is the door id.
const INGRESS_PREFERENCE_KEY = 'studio-ingress-v1';

/**
 * Reads this device's preferred front door. Each door is its own origin with its own
 * localStorage, so the value is written on both sides of a switch. Returns null when nothing
 * valid is stored or storage is unavailable (private mode). Used by the studio network settings.
 */
export function readIngressPreference(): StudioIngressId | null {
  try {
    const stored = localStorage.getItem(INGRESS_PREFERENCE_KEY);
    return stored === 'public' || stored === 'tailnet' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Remembers this device's preferred front door on the current origin; never throws. Used by the
 * studio network settings when the user switches, and by the auth module after it redeems a
 * handoff, so the target origin agrees with the choice made on the source origin.
 */
export function writeIngressPreference(id: StudioIngressId): void {
  try {
    localStorage.setItem(INGRESS_PREFERENCE_KEY, id);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the preference is a convenience.
  }
}

/**
 * Builds the address on the target door that carries a one-time handoff code, keeping the
 * current path and query so the user lands on the same screen. Used by the studio network settings.
 */
export function buildHandoffUrl(targetOrigin: string, code: string, current: { pathname: string; search: string } = window.location): string {
  const url = new URL(`${current.pathname}${current.search}`, targetOrigin);
  url.searchParams.set(HANDOFF_QUERY_PARAM, code);
  return url.toString();
}

/**
 * Takes a handoff code out of the address bar: returns it and removes the parameter with
 * history.replaceState, so a reload or a shared link never replays it. Returns null when there
 * is none. Used once per page load by the auth module before it looks for a stored session.
 */
export function takeHandoffCodeFromUrl(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get(HANDOFF_QUERY_PARAM);
  if (code === null) {
    return null;
  }
  url.searchParams.delete(HANDOFF_QUERY_PARAM);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return code || null;
}

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'Agent Cloud Studio';

/**
 * Resolves the human-readable label for a session: the persisted `summary` (the custom
 * name the sessions API returns for every provider, Cursor included), else the `name` a
 * Cursor session object may carry locally, else the provider's placeholder. Reads the
 * same fields in the same order as the sidebar row, so the header, document title and
 * sidebar never disagree about a session's name.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  const title = (session.summary as string) || (session.name as string);
  if (session.__provider === 'cursor') {
    return title || 'Untitled Session';
  }

  return title || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

// ---------------------------

//----------------- SLASH COMMANDS ------------

/**
 * Whether a slash command is a provider skill (as opposed to a built-in or a
 * custom `.md` command). Skills are mapped with `type: 'skill'`; the metadata
 * check catches entries that only carry the skill marker there. Used wherever
 * commands are grouped or executed differently by kind.
 */
export const isSkillCommand = (command: SlashCommand): boolean =>
  command.type === 'skill' || command.metadata?.type === 'skill';

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** DOM id of a quick settings tab button; pairs with `getQuickSettingsTabPanelId` for aria-controls / aria-labelledby. */
export const getQuickSettingsTabId = (tab: QuickSettingsTab): string => `quick-settings-tab-${tab}`;

/** DOM id of the tabpanel a quick settings tab controls; pairs with `getQuickSettingsTabId`. */
export const getQuickSettingsTabPanelId = (tab: QuickSettingsTab): string => `quick-settings-tabpanel-${tab}`;

// ---------------------------

//----------------- DECIMAL INPUT ------------

// Digits with an optional decimal point (after normalising a comma); no sign, exponent or grouping.
const DECIMAL_INPUT = /^(\d+(\.\d*)?|\.\d+)$/;

/**
 * Parses typed decimal text such as "12.5", "12," or ".5" (a comma counts as the decimal point) into a positive,
 * finite number with at most `places` decimals, or null when it is not one. Used by the Trading 212 order sheet
 * (quantities and limit prices) and the cap editor in Settings, which keep the field as text while it is typed.
 */
export function parseDecimalInput(value: string, places: number): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!DECIMAL_INPUT.test(normalized)) return null;
  const parsed = Number(normalized);
  const fraction = normalized.split('.')[1] ?? '';
  return Number.isFinite(parsed) && parsed > 0 && fraction.length <= places ? parsed : null;
}

/**
 * Why typed decimal text is not a valid amount for `parseDecimalInput`, prefixed with the field `label` (Chinese UI
 * copy); empty while the field is empty or valid. Used next to `parseDecimalInput` by the same two forms.
 */
export function decimalInputProblem(value: string, places: number, label: string): string {
  const normalized = value.trim().replace(',', '.');
  if (!normalized || parseDecimalInput(value, places) !== null) return '';
  if (DECIMAL_INPUT.test(normalized) && (normalized.split('.')[1] ?? '').length > places) return `${label}最多 ${places} 位小数`;
  return `${label}必须是大于 0 的数字`;
}

// ---------------------------

//----------------- ERROR MESSAGES ------------

/**
 * The message of a thrown Error (readApiJson throws the server's user-facing text), or `fallback` when the
 * reason is not an Error or has no message. Used by the studio mail inbox, reader and settings to show request
 * failures; pass a short Chinese fallback that names the action that failed.
 */
export const readableErrorMessage = (reason: unknown, fallback: string): string =>
  reason instanceof Error && reason.message ? reason.message : fallback;

// ---------------------------

//----------------- MODEL QUOTA DISPLAY ------------

// The owner's clock: a weekly reset reads "周一 7:00" in London wherever the page is opened.
const QUOTA_TIME_ZONE = 'Europe/London';
const QUOTA_PROVIDER_NAMES: Record<StudioQuotaSnapshot['provider'], string> = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };
// The plan-wide Claude windows, listed in Settings even before the account reports them.
const CLAUDE_BASE_WINDOWS: { id: string; label: string; title: string }[] = [
  { id: 'five_hour', label: '5 小时', title: 'Claude 5 小时' },
  { id: 'seven_day', label: '每周', title: 'Claude 每周（全部模型）' },
];
const DEEPSEEK_BALANCE_KEY = 'deepseek:balance';
const quotaClocks = new Map<string, Intl.DateTimeFormat>();

// Formatters for the owner's time zone, made on first use; a browser without that zone falls back to its own clock.
function quotaClock(kind: 'weekday' | 'date') {
  let clock = quotaClocks.get(kind);
  if (!clock) {
    const fields: Intl.DateTimeFormatOptions = kind === 'weekday' ? { weekday: 'short' } : { month: 'numeric', day: 'numeric' };
    const options: Intl.DateTimeFormatOptions = { ...fields, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' };
    try { clock = new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: QUOTA_TIME_ZONE }); } catch { clock = new Intl.DateTimeFormat('zh-CN', options); }
    quotaClocks.set(kind, clock);
  }
  return clock;
}

function quotaWindowItem(snapshot: StudioQuotaSnapshot, window: StudioQuotaWindow, shownByDefault: boolean): QuotaDisplayItem {
  const providerName = QUOTA_PROVIDER_NAMES[snapshot.provider];
  const base = snapshot.provider === 'claude' ? CLAUDE_BASE_WINDOWS.find(item => item.id === window.id) : undefined;
  return {
    key: `${snapshot.provider}:window:${window.id}`, provider: snapshot.provider, providerName, kind: 'window',
    label: window.label, title: base?.title ?? `${providerName} ${window.label}`,
    usedPercent: window.usedPercent, endsAt: window.resetsAt, endKind: 'resets', amount: null,
    stale: snapshot.stale, shownByDefault, present: true,
  };
}

function quotaCreditItem(snapshot: StudioQuotaSnapshot, credit: StudioQuotaCredit): QuotaDisplayItem {
  return {
    key: `claude:credit:${credit.id}`, provider: 'claude', providerName: 'Claude', kind: 'credit',
    label: credit.label, title: `Claude ${credit.label}`,
    usedPercent: credit.usedPercent, endsAt: credit.endsAt, endKind: credit.endKind,
    amount: credit.currency ? { currency: credit.currency, remaining: credit.remaining, used: credit.used, limit: credit.limit } : null,
    stale: snapshot.stale, shownByDefault: false, present: true,
  };
}

// A Settings row for an item the account has not reported (yet): it can be switched on or off ahead of time.
function quotaPlaceholderItem(item: Pick<QuotaDisplayItem, 'key' | 'provider' | 'kind' | 'label' | 'title'>): QuotaDisplayItem {
  return {
    ...item, providerName: QUOTA_PROVIDER_NAMES[item.provider], usedPercent: null, endsAt: null, endKind: 'resets',
    amount: null, stale: false, shownByDefault: true, present: false,
  };
}

/**
 * Every quota figure the snapshots hold, in display order: Claude's windows (plan-wide first, then each model's),
 * Claude's credits, Codex's windows and the DeepSeek balance. Unavailable snapshots add nothing. Defaults follow
 * the owner's choice: Claude 5 小时 and 每周, Codex 每周 (or its first plan-wide window when it has no weekly one)
 * and the DeepSeek balance are shown; per-model windows and credits are not. With `placeholders`, Settings also
 * gets the Claude 5 小时 / 每周 and DeepSeek 余额 rows when those are missing (`present: false`).
 * Used by the home quota widgets, the workbench usage panel and the quota Settings section.
 */
export function listQuotaItems(snapshots: StudioQuotaSnapshot[], options: { placeholders?: boolean } = {}): QuotaDisplayItem[] {
  const available = (provider: StudioQuotaSnapshot['provider']) => snapshots.find(item => item.provider === provider && item.available);
  const claude = available('claude');
  let claudeItems = claude ? [
    ...claude.windows.map(window => quotaWindowItem(claude, window, !window.model)),
    ...(claude.credits ?? []).map(credit => quotaCreditItem(claude, credit)),
  ] : [];
  if (options.placeholders) {
    const base = CLAUDE_BASE_WINDOWS.map(window => claudeItems.find(item => item.key === `claude:window:${window.id}`)
      ?? quotaPlaceholderItem({ key: `claude:window:${window.id}`, provider: 'claude', kind: 'window', label: window.label, title: window.title }));
    claudeItems = [...base, ...claudeItems.filter(item => !base.includes(item))];
  }

  const codex = available('codex');
  const codexWindows = codex?.windows ?? [];
  const codexDefault = codexWindows.find(window => !window.model && window.windowMinutes === 10080) ?? codexWindows.find(window => !window.model);
  const codexItems = codex ? codexWindows.map(window => quotaWindowItem(codex, window, window === codexDefault)) : [];

  const deepseek = available('deepseek');
  const balance = deepseek?.balances[0];
  const deepseekItems: QuotaDisplayItem[] = deepseek && balance ? [{
    key: DEEPSEEK_BALANCE_KEY, provider: 'deepseek', providerName: 'DeepSeek', kind: 'balance', label: '余额', title: 'DeepSeek 余额',
    usedPercent: null, endsAt: null, endKind: 'resets', amount: { currency: balance.currency, remaining: balance.total, used: null, limit: null },
    stale: deepseek.stale, shownByDefault: true, present: true,
  }] : options.placeholders
    ? [quotaPlaceholderItem({ key: DEEPSEEK_BALANCE_KEY, provider: 'deepseek', kind: 'balance', label: '余额', title: 'DeepSeek 余额' })]
    : [];
  return [...claudeItems, ...codexItems, ...deepseekItems];
}

/**
 * Whether an item is shown: the owner's explicit choice when there is one, otherwise the item's default.
 * Used with listQuotaItems wherever quota figures are drawn.
 */
export function isQuotaItemShown(item: QuotaDisplayItem, preferences: QuotaPreferences): boolean {
  return preferences.items[item.key] ?? item.shownByDefault;
}

/**
 * The whole-number percentage to show for a used share: what was used, rounded, or what is left as
 * 100 minus that rounded figure, so the two views always add up to 100 (used 9.6 → 已用 10 / 剩余 90).
 * Values outside 0..100 are clamped. Used by every quota bar and ring.
 */
export function quotaShownPercent(usedPercent: number, mode: QuotaDisplayMode): number {
  const used = Math.round(Math.min(100, Math.max(0, usedPercent)));
  return mode === 'used' ? used : 100 - used;
}

/**
 * When a quota window resets (or a credit expires, with `endKind` 'expires'), in Chinese on the owner's clock
 * (Europe/London): "36 分钟后重置" and "3 小时 36 分后重置" within a day, "周一 7:00 重置" within a week and
 * "11月5日 7:59 到期" beyond that; "已重置" / "已到期" once passed. Minutes round up, so a window with seconds
 * left never reads as reset. Null when the time is unknown or unreadable. Used by the quota widgets, the
 * workbench usage panel and Settings.
 */
export function quotaEndText(endsAt: string | null, now: number, endKind: 'resets' | 'expires' = 'resets'): string | null {
  const at = endsAt ? Date.parse(endsAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const verb = endKind === 'expires' ? '到期' : '重置';
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return `已${verb}`;
  if (minutes < 60) return `${minutes} 分钟后${verb}`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分后${verb}` : `${hours} 小时后${verb}`;
  }
  const weekly = minutes < 7 * 24 * 60;
  const parts = Object.fromEntries(quotaClock(weekly ? 'weekday' : 'date').formatToParts(new Date(at)).map(part => [part.type, part.value]));
  const clock = `${Number(parts.hour)}:${parts.minute}`;
  return weekly ? `${parts.weekday} ${clock} ${verb}` : `${Number(parts.month)}月${Number(parts.day)}日 ${clock} ${verb}`;
}

/**
 * The money figure of a credit or balance item, or null when it has none. A balance is its amount ("¥253.99");
 * a credit with a cap reads "剩余 $229 / $250" or "已用 $21 / $250" by `mode`, one without a cap "已用 $19.99",
 * and one known only by what is left "剩余 $229". Whole amounts of a credit drop their cents, as the Claude app does.
 * Used by the quota widgets, the workbench usage panel and Settings.
 */
export function quotaAmountText(item: QuotaDisplayItem, mode: QuotaDisplayMode): string | null {
  const amount = item.amount;
  if (!amount) return null;
  const money = (value: number) => {
    const digits = item.kind === 'credit' && Number.isInteger(value) ? 0 : 2;
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency', currency: amount.currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(value);
    } catch { return `${value.toFixed(digits)} ${amount.currency}`; }
  };
  if (item.kind === 'balance') return amount.remaining === null ? null : money(amount.remaining);
  const remaining = amount.remaining ?? (amount.limit !== null && amount.used !== null ? Math.max(0, amount.limit - amount.used) : null);
  if (amount.limit !== null) {
    const figure = mode === 'used' ? amount.used : remaining;
    if (figure !== null) return `${mode === 'used' ? '已用' : '剩余'} ${money(figure)} / ${money(amount.limit)}`;
  }
  if (amount.used !== null && (mode === 'used' || remaining === null)) return `已用 ${money(amount.used)}`;
  return remaining === null ? null : `剩余 ${money(remaining)}`;
}
