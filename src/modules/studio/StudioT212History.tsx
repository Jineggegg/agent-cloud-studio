import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';

import { IconArrowDownRight, IconArrowUpRight, IconKey, IconPin, IconShieldX } from '@/modules/studio/icons/tabler';
import { T212_ENV_LABELS, T212_MODE_LABELS } from '@/shared/constants';
import type { T212StepUpRequest, T212StepUpWho } from '@/shared/types';
import '@/modules/studio/studio-orders.css';

// Audit entries shown per list before "显示全部".
const HISTORY_PREVIEW = 4;
const OUTCOME_LABEL: Record<T212StepUpRequest['outcome'], string> = {
  pending: '等待验证', used: '已提交验证', expired: '已过期，没有使用', replaced: '被同一会话的新请求替换',
  unknown: '升级前的记录，结果未知',
};

function when(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// "本会话 · Tailscale 100.64.*.*" or "其他会话 1a2b3c4d · 公网 203.0.*.*"; '' for entries recorded before sessions were.
function whoText({ session, currentSession, client }: T212StepUpWho) {
  if (!session && !client) return '';
  const label = currentSession ? '本会话' : `其他会话${session ? ` ${session}` : ''}`;
  return client ? `${label} · ${client}` : label;
}
function amount(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/**
 * Used by StudioT212CapsEditor, StudioT212TradingModeHistory and StudioSettingsTrading (Settings → 交易安全) for their
 * audit lists: applied changes, refused attempts and Face ID requests, each newest first. Shows the latest few with
 * a "显示全部" toggle and nothing at all while the list is empty.
 */
export function StudioT212HistoryList<Item extends { id: number | string }>({ title, items, renderItem }: {
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
 * Used by StudioT212CapsEditor and StudioT212TradingModeHistory for one audited entry: an up, down or pin mark (or a
 * shield for a refusal, never color alone), what changed, how it was authorised and when, why it was refused, and
 * which session and client caused it.
 */
export function StudioT212HistoryRow({ heading, values, mark, refused, method, createdAt, reason, who }: {
  heading: string; values: string; mark: 'up' | 'down' | 'pin'; refused: boolean; method: 'passkey' | 'session'; createdAt: string;
  reason: string | null; who: T212StepUpWho;
}) {
  const Icon = refused ? IconShieldX : mark === 'up' ? IconArrowUpRight : mark === 'pin' ? IconPin : IconArrowDownRight;
  const tone = refused ? 'tone-rose' : mark === 'up' ? 'tone-clay' : mark === 'pin' ? 'tone-slate' : 'tone-sage';
  const origin = whoText(who);
  return <div className="ios-row" role="listitem">
    <span className={`home-icon small ${tone}`} aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
    <span className="ios-row-body">
      <strong>{heading}</strong>
      <small>{values}</small>
      <small title={reason ?? undefined}>{method === 'passkey' ? '面容 ID / 触控 ID' : '登录会话'} · {when(createdAt)}{reason ? ` · ${reason}` : ''}</small>
      {origin && <small className={who.currentSession ? '' : 't212-history-other'}>{origin}</small>}
    </span>
    {refused && <span className="status-badge warn">已拒绝</span>}
  </div>;
}

/**
 * Used by StudioSettingsTrading (Settings → 交易安全) to list the Face ID / Touch ID challenges handed out for raising
 * caps or adding accounts, so the owner can see which session and client is asking for them (a stolen session shows
 * up here as "其他会话") and what became of each.
 */
export function StudioT212StepUpRequestList({ requests }: { requests: T212StepUpRequest[] }) {
  return <StudioT212HistoryList title="面容 ID 验证请求" items={requests} renderItem={request => {
    const target = request.kind === 'caps'
      ? `提高${request.env ? T212_ENV_LABELS[request.env] : ''}上限${request.to ? ` · 单笔 ${amount(request.to.maxOrderValue)} · 每日 ${amount(request.to.dailyLimit)}` : ''}`
      : `开启下单${request.to ? ` · 改为「${T212_MODE_LABELS[request.to]}」` : ''}`;
    const origin = whoText(request);
    return <div className="ios-row" role="listitem">
      <span className={`home-icon small ${request.currentSession ? 'tone-slate' : 'tone-clay'}`} aria-hidden="true"><IconKey size={18} strokeWidth={1.8} /></span>
      <span className="ios-row-body">
        <strong>{target}</strong>
        <small>{OUTCOME_LABEL[request.outcome]} · {when(request.createdAt)}</small>
        {origin && <small className={request.currentSession ? '' : 't212-history-other'}>{origin}</small>}
      </span>
      {!request.currentSession && request.session && <span className="status-badge warn">其他会话</span>}
    </div>;
  }} />;
}
