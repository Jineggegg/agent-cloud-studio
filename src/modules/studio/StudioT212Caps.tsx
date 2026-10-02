import { useId, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { ArrowDownRight, ArrowUpRight, Check, ScanFace, ShieldX } from 'lucide-react';
import { toast } from 'sonner';

import { api, readApiJson } from '@/shared/api';
import type { T212AccountCaps, T212CapChange, T212CapLimits, T212CapsInput, T212Env, T212TradingConfig } from '@/shared/types';
import { decimalInputProblem, parseDecimalInput } from '@/shared/utils';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

/** POST /caps/challenge: a single-use Face ID / Touch ID challenge for exactly the values being raised to. */
type CapsChallenge = { challengeId: string; expiresAt: string; authentication: PublicKeyCredentialRequestOptionsJSON };
type Direction = 'raise' | 'lower';

const ENV_LABEL: Record<T212Env, string> = { live: '实盘', demo: '模拟盘' };
const ENVS: T212Env[] = ['live', 'demo'];
// Caps are amounts of money: the server accepts at most two decimals.
const CAP_PLACES = 2;
// Audit entries shown before "显示全部".
const HISTORY_PREVIEW = 4;

function money(value: number, currency: string | undefined) {
  if (!currency) return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}（账户货币）`;
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${currency}`; }
}
function when(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// Raising either cap is a raise even when the other goes down, exactly as the server decides; null when unchanged.
function capDirection(current: T212CapLimits, next: T212CapLimits): Direction | null {
  if (next.maxOrderValue > current.maxOrderValue || next.dailyLimit > current.dailyLimit) return 'raise';
  if (next.maxOrderValue < current.maxOrderValue || next.dailyLimit < current.dailyLimit) return 'lower';
  return null;
}
function cancelled(reason: unknown) {
  return reason instanceof Error && reason.name === 'NotAllowedError';
}
// WebAuthn errors carry DOMException-style names whose raw messages are English and technical.
function saveError(reason: unknown) {
  if (cancelled(reason)) return '已取消面容 ID / 触控 ID 验证，上限没有改变';
  if (reason instanceof Error && reason.name === 'SecurityError') return '当前网址不能使用通行密钥：需要 HTTPS 域名或 localhost';
  return reason instanceof Error && reason.message ? reason.message : '上限没有保存';
}
// Why this page cannot raise caps, or '' when it can: Face ID / Touch ID of this very domain, on a trusted origin.
function raiseBlocker(config: T212TradingConfig, trusted: boolean) {
  const host = window.location.hostname;
  const domains = [...new Set(config.passkeys.map(item => item.rpId))];
  if (!browserSupportsWebAuthn()) return '这个浏览器不支持面容 ID / 触控 ID，不能提高上限；降低上限不受影响。';
  if (!domains.length) return '提高上限需要面容 ID / 触控 ID：请先在上方启用。降低上限不需要验证。';
  if (!trusted) return '当前网址不在下单白名单，不能提高上限；降低上限不受影响。';
  if (!domains.includes(host)) return `提高上限要用这个网址自己的面容 ID / 触控 ID：请先在上方为 ${host} 启用，或到 ${domains.join('、')} 操作。`;
  return '';
}

/**
 * Used by StudioSettingsTrading (Settings → 交易安全) to show and edit this user's Trading 212 caps per account:
 * the per-order cap and the rolling-24-hour cap with today's usage, the server ceiling, and the audit trail.
 * Lowering is saved with the session alone; raising asks the server for a challenge bound to the exact new values
 * and signs it with Face ID / Touch ID, so it needs a passkey on this domain (the editor explains when there is none).
 */
export function StudioT212CapsEditor({ config, trusted, onSaved }: {
  config: T212TradingConfig; trusted: boolean; onSaved: () => Promise<void> | void;
}) {
  // The account whose caps are shown and edited; starts on the first account that may trade.
  const [env, setEnv] = useState<T212Env>(() => config.allowedEnvs[0] ?? 'live');
  // Whether the audit list shows every returned entry instead of the latest few.
  const [showAllChanges, setShowAllChanges] = useState(false);
  const headingId = useId();
  const caps = config.caps.envs[env];
  const currency = caps.currency ?? config.currency;
  const changes = showAllChanges ? config.capChanges : config.capChanges.slice(0, HISTORY_PREVIEW);

  return <>
    <div className="t212-caps-heading">
      <h3 id={headingId}>下单上限</h3>
      <div className="segmented small" role="radiogroup" aria-label="上限所属账户">
        {ENVS.map(value => <button key={value} type="button" role="radio" aria-checked={env === value} onClick={() => setEnv(value)}>{ENV_LABEL[value]}</button>)}
      </div>
    </div>
    {/* Remounted whenever the saved caps change, so the fields start from what the server now enforces. */}
    <CapsForm key={`${env}:${caps.maxOrderValue}:${caps.dailyLimit}:${caps.updatedAt ?? ''}`} env={env} caps={caps} currency={currency}
      ceiling={config.caps.ceiling} blocker={raiseBlocker(config, trusted)} labelledBy={headingId} onSaved={onSaved} />
    <p className="ios-section-footer t212-settings-note">
      服务器硬上限 {money(config.caps.ceiling, currency)}（<code>STUDIO_T212_CAP_CEILING</code>），任何修改都不能超过。
      降低上限立即生效，不需要验证；提高上限要用这个网址的面容 ID / 触控 ID，验证 60 秒内有效。
      每日上限按过去 24 小时已提交和状态未知的订单计算。
      {!caps.custom && ` 当前是服务器默认值（单笔 ${money(config.caps.defaults.maxOrderValue, currency)}，每日 ${money(config.caps.defaults.dailyLimit, currency)}）。`}
    </p>

    {config.capChanges.length > 0 && <>
      <div className="t212-caps-heading"><h3>上限变更记录</h3></div>
      <div className="ios-list t212-caps-history" role="list" aria-label="上限变更记录">
        {changes.map(change => <CapChangeRow key={change.id} change={change} currency={config.caps.envs[change.env].currency ?? config.currency} />)}
      </div>
      {config.capChanges.length > HISTORY_PREVIEW && <button type="button" className="t212-caps-more" onClick={() => setShowAllChanges(value => !value)}>
        {showAllChanges ? '收起' : `显示全部 ${config.capChanges.length} 条`}
      </button>}
    </>}
  </>;
}

function CapsForm({ env, caps, currency, ceiling, blocker, labelledBy, onSaved }: {
  env: T212Env; caps: T212AccountCaps; currency: string | undefined; ceiling: number; blocker: string; labelledBy: string;
  onSaved: () => Promise<void> | void;
}) {
  // Typed caps, kept as text so partial input such as "1." is not rewritten; the key resets them after a save.
  const [orderText, setOrderText] = useState(() => String(caps.maxOrderValue));
  const [dailyText, setDailyText] = useState(() => String(caps.dailyLimit));
  // Save in flight: 'session' while lowering, 'passkey' while the challenge, Face ID and the save run.
  const [busy, setBusy] = useState<'session' | 'passkey' | null>(null);
  // Failure of the last attempt (server refusal, cancelled Face ID), shown until the next attempt.
  const [error, setError] = useState('');
  const orderId = useId();
  const dailyId = useId();

  const maxOrderValue = parseDecimalInput(orderText, CAP_PLACES);
  const dailyLimit = parseDecimalInput(dailyText, CAP_PLACES);
  const valid = maxOrderValue !== null && dailyLimit !== null;
  const problem = decimalInputProblem(orderText, CAP_PLACES, '单笔上限') || decimalInputProblem(dailyText, CAP_PLACES, '每日上限')
    || (valid && Math.max(maxOrderValue, dailyLimit) > ceiling ? `上限不能超过服务器硬上限 ${money(ceiling, currency)}` : '')
    || (valid && maxOrderValue > dailyLimit ? '单笔上限不能超过每日上限' : '');
  const direction = valid && !problem ? capDirection(caps, { maxOrderValue, dailyLimit }) : null;
  const blocked = direction === 'raise' && Boolean(blocker);
  const ready = busy === null && direction !== null && !blocked;
  const usedRatio = caps.dailyLimit > 0 ? Math.min(1, caps.dailyUsed / caps.dailyLimit) : 0;

  const save = async () => {
    if (!ready || maxOrderValue === null || dailyLimit === null) return;
    const input: T212CapsInput = { env, maxOrderValue, dailyLimit };
    setBusy(direction === 'raise' ? 'passkey' : 'session'); setError('');
    try {
      if (direction === 'raise') {
        const challenge = await readApiJson<CapsChallenge>(await api.studio.t212Trading.capsChallenge(input));
        const assertion = await startAuthentication({ optionsJSON: challenge.authentication });
        await readApiJson(await api.studio.t212Trading.updateCaps(input, { challengeId: challenge.challengeId, assertion }));
      } else {
        await readApiJson(await api.studio.t212Trading.updateCaps(input));
      }
      toast.success(direction === 'raise' ? `已用面容 ID / 触控 ID 提高${ENV_LABEL[env]}上限` : `已降低${ENV_LABEL[env]}上限`, {
        description: `单笔 ${money(maxOrderValue, currency)} · 每日 ${money(dailyLimit, currency)}`,
      });
      await onSaved();
    } catch (reason) {
      const message = saveError(reason);
      setError(message);
      // A cancelled Face ID prompt is the user's own choice; everything else is reported as a failure too.
      if (!cancelled(reason)) toast.error(direction === 'raise' ? '上限没有提高' : '上限没有保存', { description: message });
    } finally { setBusy(null); }
  };

  return <>
    <form className="ios-list t212-caps-form" aria-labelledby={labelledBy} onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="ios-field">
        <label htmlFor={orderId}>单笔上限</label>
        <input id={orderId} inputMode="decimal" autoComplete="off" value={orderText} onChange={event => setOrderText(event.target.value)}
          disabled={busy !== null} aria-invalid={Boolean(decimalInputProblem(orderText, CAP_PLACES, '单笔上限')) || undefined} />
        <span className="t212-order-aside">{currency ?? '账户货币'}</span>
      </div>
      <div className="ios-field">
        <label htmlFor={dailyId}>每日上限</label>
        <input id={dailyId} inputMode="decimal" autoComplete="off" value={dailyText} onChange={event => setDailyText(event.target.value)}
          disabled={busy !== null} aria-invalid={Boolean(decimalInputProblem(dailyText, CAP_PLACES, '每日上限')) || undefined} />
        <span className="t212-order-aside">{currency ?? '账户货币'}</span>
      </div>
      <div className="ios-row no-icon">
        <span className="ios-row-body">
          <strong>过去 24 小时</strong>
          <small>已用 {money(caps.dailyUsed, currency)} · 还可下单 {money(caps.dailyRemaining, currency)}</small>
        </span>
        <span className={`t212-order-meter t212-caps-meter ${usedRatio >= 1 ? 'full' : usedRatio >= 0.8 ? 'near' : ''}`} aria-hidden="true">
          <span style={{ transform: `scaleX(${usedRatio})` }} />
        </span>
      </div>
      <button type="submit" className="ios-row action left no-icon" disabled={!ready}>
        {busy ? <StudioSpinner size={16} /> : direction === 'raise' ? <ScanFace size={19} aria-hidden="true" /> : <Check size={19} aria-hidden="true" />}
        {direction === 'raise' ? '用面容 ID / 触控 ID 提高上限' : direction === 'lower' ? '降低上限' : '保存上限'}
      </button>
    </form>
    {problem && <p className="studio-feedback error" role="alert">{problem}</p>}
    {!problem && blocked && <p className="studio-feedback t212-caps-blocked">{blocker}</p>}
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
  </>;
}

function CapChangeRow({ change, currency }: { change: T212CapChange; currency: string | undefined }) {
  const refused = change.status === 'refused';
  const Icon = refused ? ShieldX : change.direction === 'raise' ? ArrowUpRight : ArrowDownRight;
  const tone = refused ? 'tone-rose' : change.direction === 'raise' ? 'tone-clay' : 'tone-sage';
  const action = refused ? '提高被拒绝' : change.direction === 'raise' ? '提高' : '降低';
  const pair = (from: number, to: number) => (from === to ? money(to, currency) : `${money(from, currency)} → ${money(to, currency)}`);
  const method = change.method === 'passkey' ? '面容 ID / 触控 ID' : '登录会话';
  return <div className="ios-row" role="listitem">
    <span className={`home-icon small ${tone}`} aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
    <span className="ios-row-body">
      <strong>{ENV_LABEL[change.env]} · {action}</strong>
      <small>单笔 {pair(change.from.maxOrderValue, change.to.maxOrderValue)} · 每日 {pair(change.from.dailyLimit, change.to.dailyLimit)}</small>
      <small title={change.reason ?? undefined}>{method} · {when(change.createdAt)}{change.reason ? ` · ${change.reason}` : ''}</small>
    </span>
    {refused && <span className="status-badge warn">已拒绝</span>}
  </div>;
}
