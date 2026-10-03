import { useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { QuotaDisplayItem, QuotaDisplayMode, StudioQuotaSnapshot } from '@/shared/types';
import { useQuotaPreferences } from '@/shared/hooks/useQuotaPreferences';
import { isQuotaItemShown, listQuotaItems, quotaAmountText, quotaEndText, quotaShownPercent } from '@/shared/utils';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

const MODES: { mode: QuotaDisplayMode; label: string; caption: string }[] = [
  { mode: 'remaining', label: '剩余', caption: '百分比和进度条显示还剩多少' },
  { mode: 'used', label: '已用', caption: '百分比和进度条显示已经用了多少' },
];

// The row's second line: the item's current figure and when it resets, or why there is none.
function itemCaption(item: QuotaDisplayItem, mode: QuotaDisplayMode, now: number) {
  if (!item.present) return '暂无数据';
  const figure = item.usedPercent !== null ? `${mode === 'used' ? '已用' : '剩余'} ${quotaShownPercent(item.usedPercent, mode)}%` : null;
  const parts = [figure, quotaAmountText(item, mode), quotaEndText(item.endsAt, now, item.endKind)].filter(Boolean);
  return `${parts.join(' · ')}${item.stale ? '（可能过期）' : ''}`;
}

/**
 * Used by StudioConnections (设置) for 额度显示: whether quota figures read as 剩余 (left, the default) or 已用, and
 * an iOS switch per item — Claude 5 小时, 每周, each model's weekly window and each credit, every Codex window and
 * the DeepSeek balance — choosing what the home quota widgets and the workbench usage panel show. The rows come
 * from the current quota reading, so per-model windows and credits appear once the account reports them; the
 * Claude plan windows and the DeepSeek balance are always listed. Choices are per device (useQuotaPreferences).
 */
export function StudioSettingsQuota() {
  const { preferences, setMode, setItemShown } = useQuotaPreferences();
  // The current quota reading, which decides the rows, and when it arrived (the clock its reset times are read
  // against); null while it loads. A failed read lists the fixed rows only.
  const [reading, setReading] = useState<{ snapshots: StudioQuotaSnapshot[]; at: number } | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api.studio.quota()).then(readApiJson<StudioQuotaSnapshot[]>).catch(() => [])
      .then(next => { if (active) setReading({ snapshots: Array.isArray(next) ? next : [], at: Date.now() }); });
    return () => { active = false; };
  }, []);

  const items = useMemo(() => listQuotaItems(reading?.snapshots ?? [], { placeholders: true }), [reading]);
  const modeCaption = MODES.find(item => item.mode === preferences.mode)?.caption;

  return <section className="ios-section" aria-labelledby="studio-quota-heading">
    <div className="ios-section-header"><h2 id="studio-quota-heading">额度显示</h2><span className="caption">首页小组件与工作台</span></div>
    <div className="ios-list">
      <div className="ios-row no-icon">
        <span className="ios-row-body"><strong>显示方式</strong><small>{modeCaption}</small></span>
        <div className="segmented small" role="radiogroup" aria-label="额度显示方式">
          {MODES.map(item => <button type="button" role="radio" key={item.mode} aria-checked={preferences.mode === item.mode}
            onClick={() => setMode(item.mode)}>{item.label}</button>)}
        </div>
      </div>
    </div>

    <div className="ios-section-header"><h3>显示的额度</h3></div>
    <div className="ios-list" role="group" aria-label="显示的额度">
      {reading === null
        ? <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>
        : items.map(item => <label className="ios-row no-icon switch-row" key={item.key}>
          <span className="ios-row-body"><strong>{item.title}</strong><small>{itemCaption(item, preferences.mode, reading.at)}</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label={item.title} checked={isQuotaItemShown(item, preferences)}
            onChange={event => setItemShown(item.key, event.target.checked)} />
        </label>)}
    </div>
    <p className="ios-section-footer">关闭的额度不会出现在首页的额度小组件和工作台左下角的用量面板里。各模型的每周额度和 Claude 云端额度在账号返回后才会列出；选择只保存在这台设备上。</p>
  </section>;
}
