import { useEffect, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { m } from 'motion/react';
import { ChevronRight, RotateCcw } from 'lucide-react';

import type { StudioQuotaSnapshot, StudioQuotaWindow } from '@/shared/types';

// A window this full turns the bar to the warning colour, like the home-screen rings.
const HIGH_PERCENT = 90;

type QuotaLine =
  | { key: string; kind: 'window'; provider: 'claude' | 'codex'; label: string; window: StudioQuotaWindow; stale: boolean }
  | { key: string; kind: 'balance'; label: string; text: string; stale: boolean }
  | { key: string; kind: 'note'; label: string; text: string };

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

// Short enough for the 280px column: "2小时13分", "3天5小时", "42分钟". Null when unknown.
function compactCountdown(resetsAt: string | null, now: number) {
  if (!resetsAt) return null;
  const minutes = Math.max(0, Math.ceil((Date.parse(resetsAt) - now) / 60_000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes <= 0) return '已重置';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}天${hours ? `${hours}小时` : ''}`;
  if (hours) return `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ''}`;
  return `${minutes}分钟`;
}

function linesOf(snapshots: StudioQuotaSnapshot[]): QuotaLine[] {
  const lines: QuotaLine[] = [];
  const claude = snapshots.find(item => item.provider === 'claude');
  const codex = snapshots.find(item => item.provider === 'codex');
  const deepseek = snapshots.find(item => item.provider === 'deepseek');
  for (const [provider, name, snapshot, limit] of [['claude', 'Claude', claude, 2], ['codex', 'Codex', codex, 1]] as const) {
    const windows = snapshot?.available ? snapshot.windows.slice(0, limit) : [];
    if (!windows.length) {
      lines.push({ key: provider, kind: 'note', label: name, text: !snapshot || snapshot.source === 'unavailable' ? '未接入' : '暂无数据' });
      continue;
    }
    for (const quotaWindow of windows) lines.push({ key: `${provider}:${quotaWindow.id}`, kind: 'window', provider, label: `${name} ${quotaWindow.label}`, window: quotaWindow, stale: Boolean(snapshot?.stale) });
  }
  const balance = deepseek?.available ? deepseek.balances[0] : undefined;
  lines.push(balance
    ? { key: 'deepseek', kind: 'balance', label: 'DeepSeek 余额', stale: Boolean(deepseek?.stale),
      text: new Intl.NumberFormat('zh-CN', { style: 'currency', currency: balance.currency, maximumFractionDigits: 2 }).format(balance.total) }
    : { key: 'deepseek', kind: 'note', label: 'DeepSeek', text: !deepseek || deepseek.source === 'unavailable' ? '未配置' : '暂无余额' });
  return lines;
}

/**
 * Used by the workbench sidebar (bottom-left) for the model quotas at a glance: Claude 5-hour and weekly windows
 * with their reset countdown, Codex's window and the DeepSeek balance. The whole block opens Studio Settings.
 */
export function WorkbenchQuotaBars({ snapshots, onOpenSettings }: { snapshots: StudioQuotaSnapshot[] | null; onOpenSettings: () => void }) {
  const now = useNow();
  const lines = snapshots ? linesOf(snapshots) : null;

  return <button type="button" className="wb-quota" onClick={onOpenSettings} aria-label="模型额度，打开设置">
    <span className="wb-quota-head"><span>额度</span><ChevronRight size={14} aria-hidden="true" /></span>
    {!lines ? <span className="wb-quota-loading" role="status" aria-label="正在读取额度"><i /><i /><i /></span>
      : lines.map(line => {
        if (line.kind === 'note') {
          return <span key={line.key} className="wb-quota-line is-note">
            <span className="wb-quota-label">{line.label}</span><span className="wb-quota-meta">{line.text}</span>
          </span>;
        }
        if (line.kind === 'balance') {
          return <span key={line.key} className="wb-quota-line is-balance" data-stale={line.stale || undefined}>
            <span className="wb-quota-label">{line.label}</span><span className="wb-quota-meta"><strong>{line.text}</strong></span>
          </span>;
        }
        const used = Math.min(100, Math.max(0, line.window.usedPercent));
        const countdown = compactCountdown(line.window.resetsAt, now);
        return <span key={line.key} className={`wb-quota-line is-${line.provider}`} data-high={used >= HIGH_PERCENT || undefined} data-stale={line.stale || undefined}
          title={`${line.label} 已用 ${Math.round(used)}%${countdown && countdown !== '已重置' ? `，${countdown}后重置` : ''}${line.stale ? '（可能过期）' : ''}`}>
          <span className="wb-quota-label">{line.label}</span>
          <span className="wb-quota-meta">
            <strong><NumberFlow value={Math.round(used)} suffix="%" /></strong>
            {countdown && <span className="wb-quota-reset"><RotateCcw size={10} strokeWidth={2.2} aria-hidden="true" />{countdown}</span>}
          </span>
          <span className="wb-quota-track" aria-hidden="true">
            <m.span className="wb-quota-fill" initial={{ scaleX: 0 }} animate={{ scaleX: used / 100 }} transition={{ type: 'spring', stiffness: 70, damping: 18 }} />
          </span>
        </span>;
      })}
  </button>;
}
