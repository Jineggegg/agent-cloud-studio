import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';

import { IconArrowDownRight, IconArrowUpRight, IconFaceId, IconKey, IconPin, IconShieldX } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import { T212_ENV_LABELS, T212_MODE_LABELS } from '@/shared/constants';
import type { T212CapChange, T212Env, T212ModeChange, T212Passkey, T212StepUpRequest, T212StepUpWho, T212TradingConfig } from '@/shared/types';
import { formatT212CapAmount, formatT212CapChange, readableErrorMessage } from '@/shared/utils';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

// One row of the merged log, whichever list of the trading settings it came from.
type LogEntry = {
  // Unique across the lists, which each number their own entries.
  key: string;
  createdAt: string;
  Icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  tone: string;
  title: string;
  // What changed, e.g. "单笔 £250.00 → £200.00 · 每日 £1,000.00".
  detail: string;
  // How it was authorised or what became of it, then when.
  meta: string;
  // Why it was refused (or the server's note on a pin); '' when there is none.
  reason: string;
  // The domain it happened on and the session and client that caused it; '' when none was recorded.
  where: string;
  // Caused by another session than the one reading the log (shown in orange, as a stolen session would be).
  other: boolean;
  badge: string | null;
};

const OUTCOME_LABEL: Record<T212StepUpRequest['outcome'], string> = {
  pending: '等待验证', used: '已提交验证', expired: '已过期，没有使用', replaced: '被同一会话的新请求替换',
  unknown: '升级前的记录，结果未知',
};

function when(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function method(value: 'passkey' | 'session') {
  return value === 'passkey' ? '面容 ID / 触控 ID' : '登录会话';
}
// "studio.ajarche.com · 本会话 · Tailscale 100.64.*.*"; entries recorded before sessions were may have neither.
function whereText(origin: string | null, { session, currentSession, client }: T212StepUpWho) {
  let host = '';
  if (origin) { try { host = new URL(origin).host; } catch { host = origin; } }
  const who = !session && !client ? '' : currentSession ? '本会话' : `其他会话${session ? ` ${session}` : ''}`;
  return [host, who, client ?? ''].filter(Boolean).join(' · ');
}
function otherSession({ session, currentSession, client }: T212StepUpWho) {
  return !currentSession && Boolean(session || client);
}

function capEntry(item: T212CapChange, currency: string | undefined): LogEntry {
  const refused = item.status === 'refused';
  const account = item.env ? T212_ENV_LABELS[item.env] : '未知账户';
  const action = item.direction === 'raise' ? '提高' : '降低';
  return {
    key: `cap-${item.id}`, createdAt: item.createdAt,
    Icon: refused ? IconShieldX : item.direction === 'raise' ? IconArrowUpRight : IconArrowDownRight,
    tone: refused ? 'tone-rose' : item.direction === 'raise' ? 'tone-clay' : 'tone-sage',
    title: `${action}${account}上限${refused ? '被拒绝' : ''}`,
    detail: item.from && item.to
      ? `单笔 ${formatT212CapChange(item.from.maxOrderValue, item.to.maxOrderValue, currency)} · 每日 ${formatT212CapChange(item.from.dailyLimit, item.to.dailyLimit, currency)}`
      : '请求无效，没有可识别的数值',
    meta: `${method(item.method)} · ${when(item.createdAt)}`, reason: item.reason ?? '',
    where: whereText(item.origin, item), other: otherSession(item), badge: refused ? '已拒绝' : null,
  };
}

function modeEntry(item: T212ModeChange): LogEntry {
  const refused = item.status === 'refused';
  return {
    key: `mode-${item.id}`, createdAt: item.createdAt,
    Icon: refused ? IconShieldX : item.direction === 'widen' ? IconArrowUpRight : item.direction === 'pin' ? IconPin : IconArrowDownRight,
    tone: refused ? 'tone-rose' : item.direction === 'widen' ? 'tone-clay' : item.direction === 'pin' ? 'tone-slate' : 'tone-sage',
    title: refused ? '开启下单被拒绝' : item.direction === 'widen' ? '开启下单' : item.direction === 'pin' ? '固定下单账户'
      : item.to === 'off' ? '关闭下单' : '减少下单账户',
    // A pin made on the first read has no "from": it stored the mode that was already in force.
    detail: item.direction === 'pin' && !item.from && item.to ? T212_MODE_LABELS[item.to]
      : item.from && item.to ? `${T212_MODE_LABELS[item.from]} → ${T212_MODE_LABELS[item.to]}` : '请求无效，没有可识别的交易模式',
    meta: `${method(item.method)} · ${when(item.createdAt)}`, reason: item.reason ?? '',
    where: whereText(item.origin, item), other: otherSession(item), badge: refused ? '已拒绝' : null,
  };
}

// A Face ID challenge handed out; requesting one changes nothing, but a stolen session would show up here.
function requestEntry(item: T212StepUpRequest, currencyOf: (env: T212Env | null) => string | undefined): LogEntry {
  const detail = item.kind === 'caps'
    ? `提高${item.env ? T212_ENV_LABELS[item.env] : ''}上限${item.to
      ? ` · 单笔 ${formatT212CapAmount(item.to.maxOrderValue, currencyOf(item.env))} · 每日 ${formatT212CapAmount(item.to.dailyLimit, currencyOf(item.env))}` : ''}`
    : `开启下单${item.to ? ` · 改为「${T212_MODE_LABELS[item.to]}」` : ''}`;
  return {
    key: `request-${item.id}`, createdAt: item.createdAt, Icon: IconKey, tone: item.currentSession ? 'tone-slate' : 'tone-clay',
    title: '面容 ID 验证请求', detail, meta: `${OUTCOME_LABEL[item.outcome]} · ${when(item.createdAt)}`, reason: '',
    where: whereText(item.origin, item), other: otherSession(item),
    badge: !item.currentSession && item.session ? '其他会话' : null,
  };
}

// Only passkeys that still exist are known: the server keeps no record of removed ones.
function passkeyEntry(item: T212Passkey): LogEntry {
  return {
    key: `passkey-${item.id}`, createdAt: item.createdAt, Icon: IconFaceId, tone: 'tone-slate',
    title: '启用面容 ID / 触控 ID', detail: `${item.rpId} · ${item.label ?? '设备'}`,
    meta: `${when(item.createdAt)}${item.lastUsedAt ? ` · 最近使用 ${when(item.lastUsedAt)}` : ''}`, reason: '',
    where: '', other: false, badge: null,
  };
}

// Every record newest first; entries of the same moment keep the order their list gave them.
function mergeLog(config: T212TradingConfig): LogEntry[] {
  const currencyOf = (env: T212Env | null) => (env ? config.caps.envs[env].currency : undefined) ?? config.currency;
  const entries = [
    ...[...config.capChanges, ...config.capRefusals].map(item => capEntry(item, currencyOf(item.env))),
    ...[...config.modeChanges, ...config.modeRefusals].map(modeEntry),
    ...config.stepUpRequests.map(item => requestEntry(item, currencyOf)),
    ...config.passkeys.map(passkeyEntry),
  ];
  const time = (iso: string) => Date.parse(iso) || 0;
  return entries.sort((a, b) => time(b.createdAt) - time(a.createdAt));
}

/**
 * Used by Settings → Trading 212 → 变更日志: every Trading 212 safety record in one list, newest first — cap changes
 * and refused raises, trading-mode changes and refused widenings, Face ID requests and enabled passkeys — each with
 * what changed, when, and the domain, session and client that caused it. Read only when this page opens, so the
 * Trading 212 page itself keeps to its controls.
 */
export function StudioSettingsTradingLog() {
  // The merged records once the trading settings are read; null while loading.
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  // Load failure (for example an older server without trading routes), shown in place of the list.
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    void api.studio.t212Trading.config().then(readApiJson<T212TradingConfig>)
      .then(config => { if (active) setEntries(mergeLog(config)); })
      .catch((reason: unknown) => { if (active) setLoadError(readableErrorMessage(reason, '变更日志读取失败')); });
    return () => { active = false; };
  }, []);

  return <section className="ios-section first" aria-label="变更日志">
    {!entries ? <div className="ios-list">
      {loadError
        ? <div className="ios-row no-icon"><span className="ios-row-body"><small>{loadError}</small></span></div>
        : <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
    </div> : entries.length === 0 ? <div className="ios-list">
      <div className="ios-row no-icon"><span className="ios-row-body"><small>还没有记录</small></span></div>
    </div> : <div className="ios-list t212-history t212-log" role="list" aria-label="变更日志">
      {entries.map(entry => <div className="ios-row" role="listitem" key={entry.key}>
        <span className={`home-icon small ${entry.tone}`} aria-hidden="true"><entry.Icon size={18} strokeWidth={1.8} /></span>
        <span className="ios-row-body">
          <strong>{entry.title}</strong>
          <small>{entry.detail}</small>
          <small>{entry.meta}</small>
          {entry.reason && <small>{entry.reason}</small>}
          {entry.where && <small className={entry.other ? 't212-history-other' : ''}>{entry.where}</small>}
        </span>
        {entry.badge && <span className="status-badge warn">{entry.badge}</span>}
      </div>)}
    </div>}
  </section>;
}
