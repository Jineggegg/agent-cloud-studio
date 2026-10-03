import { useEffect, useId, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { m } from 'motion/react';
import { ChevronDown, Settings2 } from 'lucide-react';

import type { QuotaDisplayItem, QuotaDisplayMode, QuotaPreferences, StudioQuotaSnapshot } from '@/shared/types';
import { useQuotaPreferences } from '@/shared/hooks/useQuotaPreferences';
import { isQuotaItemShown, listQuotaItems, quotaAmountText, quotaEndText, quotaShownPercent } from '@/shared/utils';

// A window this full turns the bar to the warning colour, like the home-screen rings, whichever way it reads.
const HIGH_USED_PERCENT = 90;
// Whether the panel is folded to its header; per device, like the sidebar itself.
const COLLAPSED_STORAGE_KEY = 'workbench-quota-collapsed';
const PROVIDERS = [['claude', 'Claude'], ['codex', 'Codex'], ['deepseek', 'DeepSeek']] as const;
const MODES: { mode: QuotaDisplayMode; label: string }[] = [{ mode: 'remaining', label: '剩余' }, { mode: 'used', label: '已用' }];

type PanelLine = { kind: 'item'; item: QuotaDisplayItem } | { kind: 'note'; key: string; label: string; text: string };

// Re-renders every 30 s so the reset countdowns stay current without a timer per bar.
function useNow() {
  // The clock the countdowns read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function readCollapsed() {
  try { return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'; } catch { return false; }
}

// True when the owner switched off what this provider shows by default, so its "未接入" line would be noise.
function providerSwitchedOff(provider: StudioQuotaSnapshot['provider'], items: QuotaPreferences['items']) {
  if (provider === 'claude') return items['claude:window:five_hour'] === false && items['claude:window:seven_day'] === false;
  if (provider === 'deepseek') return items['deepseek:balance'] === false;
  const codexChoices = Object.entries(items).filter(([key]) => key.startsWith('codex:'));
  return codexChoices.length > 0 && codexChoices.every(([, shown]) => !shown);
}

// The shown items in display order; a provider that reported nothing gets one line saying why.
function linesOf(snapshots: StudioQuotaSnapshot[], preferences: QuotaPreferences): PanelLine[] {
  const items = listQuotaItems(snapshots);
  const lines: PanelLine[] = [];
  for (const [provider, name] of PROVIDERS) {
    const own = items.filter(item => item.provider === provider);
    if (own.length) {
      for (const item of own) if (isQuotaItemShown(item, preferences)) lines.push({ kind: 'item', item });
      continue;
    }
    if (providerSwitchedOff(provider, preferences.items)) continue;
    const snapshot = snapshots.find(item => item.provider === provider);
    const missing = !snapshot || snapshot.source === 'unavailable';
    const text = provider === 'deepseek' ? (missing ? '未配置' : '暂无余额') : (missing ? '未接入' : '暂无数据');
    lines.push({ kind: 'note', key: provider, label: name, text });
  }
  return lines;
}

function QuotaLine({ item, mode, now }: { item: QuotaDisplayItem; mode: QuotaDisplayMode; now: number }) {
  const label = `${item.providerName} ${item.label}`;
  const endText = quotaEndText(item.endsAt, now, item.endKind);
  const amount = quotaAmountText(item, mode);
  const staleNote = item.stale ? '（可能过期）' : '';
  if (item.usedPercent === null) {
    return <li className={`wb-quota-line is-balance is-${item.provider}`} data-stale={item.stale || undefined} title={`${label} ${amount ?? ''}${staleNote}`}>
      <span className="wb-quota-label">{label}</span>
      <span className="wb-quota-meta">{endText && <span className="wb-quota-reset">{endText}</span>}<strong>{amount ?? '—'}</strong></span>
    </li>;
  }
  const used = Math.min(100, Math.max(0, item.usedPercent));
  const shown = quotaShownPercent(used, mode);
  // A credit's amounts say more than its expiry in the row; both stay in the tooltip.
  const detail = item.kind === 'credit' && amount ? amount : endText;
  const word = mode === 'used' ? '已用' : '剩余';
  return <li className={`wb-quota-line is-${item.provider}`} data-high={used >= HIGH_USED_PERCENT || undefined} data-stale={item.stale || undefined}
    title={`${label} ${word} ${shown}%${[amount, endText].filter(Boolean).map(text => `，${text}`).join('')}${staleNote}`}>
    <span className="wb-quota-label">{label}</span>
    <span className="wb-quota-meta">
      {detail && <span className="wb-quota-reset">{detail}</span>}
      <strong><NumberFlow value={shown} suffix="%" /></strong>
    </span>
    <span className="wb-quota-track" aria-hidden="true">
      <m.span className="wb-quota-fill" initial={{ scaleX: 0 }} animate={{ scaleX: shown / 100 }} transition={{ type: 'spring', stiffness: 70, damping: 18 }} />
    </span>
  </li>;
}

/**
 * Used by the workbench sidebar (bottom-left) for model usage at a glance, like the Claude app's usage panel: one
 * row per item the owner shows (Settings → 额度显示) with its label, a thin bar, when it resets and its percentage,
 * reading 剩余 or 已用 as chosen (the switch in the header changes it everywhere). Balances show their amount.
 * The panel folds to its header (remembered per device); stale readings are dimmed and flagged. The gear opens
 * Studio Settings.
 */
export function WorkbenchQuotaBars({ snapshots, onOpenSettings }: { snapshots: StudioQuotaSnapshot[] | null; onOpenSettings: () => void }) {
  const now = useNow();
  const bodyId = useId();
  const { preferences, setMode } = useQuotaPreferences();
  // Whether only the header shows, so the history above gets the room; kept per device.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const lines = snapshots ? linesOf(snapshots, preferences) : null;
  const shownItems = (lines ?? []).flatMap(line => line.kind === 'item' ? [line.item] : []);
  const stale = shownItems.some(item => item.stale);
  // Folded, the header still tells the first figure ("5 小时 91%").
  const first = shownItems.find(item => item.usedPercent !== null);
  const summary = first && first.usedPercent !== null ? `${first.label} ${quotaShownPercent(first.usedPercent, preferences.mode)}%` : null;

  const toggleCollapsed = () => setCollapsed(previous => {
    try { localStorage.setItem(COLLAPSED_STORAGE_KEY, previous ? '0' : '1'); } catch { /* Private mode: folded for this visit only. */ }
    return !previous;
  });

  return <section className="wb-quota" aria-label="模型用量" data-collapsed={collapsed || undefined}>
    <div className="wb-quota-head">
      <button type="button" className="wb-quota-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={toggleCollapsed}>
        <span>用量</span><ChevronDown size={14} className="wb-quota-chevron" aria-hidden="true" />
        {collapsed && summary && <span className="wb-quota-summary">{summary}</span>}
      </button>
      {stale && <span className="wb-quota-stale" title="最近没有新数据">可能过期</span>}
      <div className="segmented small wb-quota-mode" role="radiogroup" aria-label="额度显示方式">
        {MODES.map(entry => <button type="button" role="radio" key={entry.mode} aria-checked={preferences.mode === entry.mode}
          onClick={() => setMode(entry.mode)}>{entry.label}</button>)}
      </div>
      <button type="button" className="icon-button plain wb-quota-settings" aria-label="额度显示设置" title="额度显示设置" onClick={onOpenSettings}>
        <Settings2 size={15} aria-hidden="true" />
      </button>
    </div>
    {!collapsed && (!lines
      ? <span id={bodyId} className="wb-quota-loading" role="status" aria-label="正在读取额度"><i /><i /><i /></span>
      : <ul id={bodyId} className="wb-quota-body">
        {lines.map(line => line.kind === 'note'
          ? <li key={line.key} className="wb-quota-line is-note">
            <span className="wb-quota-label">{line.label}</span><span className="wb-quota-meta">{line.text}</span>
          </li>
          : <QuotaLine key={line.item.key} item={line.item} mode={preferences.mode} now={now} />)}
        {!lines.length && <li className="wb-quota-line is-note"><span className="wb-quota-label">没有要显示的额度</span></li>}
      </ul>)}
  </section>;
}
