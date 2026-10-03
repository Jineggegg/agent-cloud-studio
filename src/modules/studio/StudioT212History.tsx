import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, ShieldX } from 'lucide-react';

import '@/modules/studio/studio-orders.css';

// Audit entries shown per list before "显示全部".
const HISTORY_PREVIEW = 4;

function when(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Used by StudioT212CapsEditor and StudioT212TradingModeSelector (Settings → 交易安全) for their audit lists:
 * applied changes, and apart from them refused attempts, newest first. Shows the latest few with a "显示全部"
 * toggle and nothing at all while the list is empty.
 */
export function StudioT212HistoryList<Item extends { id: number }>({ title, items, renderItem }: {
  title: string; items: Item[]; renderItem: (item: Item) => ReactNode;
}) {
  // Whether every returned entry is shown instead of the latest few.
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  return <>
    <div className="t212-subheading"><h3>{title}</h3></div>
    <div className="ios-list t212-history" role="list" aria-label={title}>
      {(expanded ? items : items.slice(0, HISTORY_PREVIEW)).map(item => <Fragment key={item.id}>{renderItem(item)}</Fragment>)}
    </div>
    {items.length > HISTORY_PREVIEW && <button type="button" className="t212-history-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起' : `显示全部 ${items.length} 条`}
    </button>}
  </>;
}

/**
 * Used by StudioT212CapsEditor and StudioT212TradingModeSelector for one audited entry: an up or down mark (or a
 * shield for a refusal, never color alone), what changed, how it was authorised and when, and why it was refused.
 */
export function StudioT212HistoryRow({ heading, values, up, refused, method, createdAt, reason }: {
  heading: string; values: string; up: boolean; refused: boolean; method: 'passkey' | 'session'; createdAt: string; reason: string | null;
}) {
  const Icon = refused ? ShieldX : up ? ArrowUpRight : ArrowDownRight;
  const tone = refused ? 'tone-rose' : up ? 'tone-clay' : 'tone-sage';
  return <div className="ios-row" role="listitem">
    <span className={`home-icon small ${tone}`} aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
    <span className="ios-row-body">
      <strong>{heading}</strong>
      <small>{values}</small>
      <small title={reason ?? undefined}>{method === 'passkey' ? '面容 ID / 触控 ID' : '登录会话'} · {when(createdAt)}{reason ? ` · ${reason}` : ''}</small>
    </span>
    {refused && <span className="status-badge warn">已拒绝</span>}
  </div>;
}
