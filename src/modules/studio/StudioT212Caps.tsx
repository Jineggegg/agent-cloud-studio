import { useId, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { Check, ScanFace } from 'lucide-react';
import { toast } from 'sonner';

import { api, readApiJson } from '@/shared/api';
import { T212_ENV_LABELS } from '@/shared/constants';
import type {
  T212AccountCaps, T212CapChange, T212CapLimits, T212CapsInput, T212Env, T212StepUpChallenge, T212TradingConfig,
} from '@/shared/types';
import { apiErrorCode, decimalInputProblem, parseDecimalInput } from '@/shared/utils';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioT212HistoryList, StudioT212HistoryRow } from '@/modules/studio/StudioT212History';
import { StudioT212ReviewSheet } from '@/modules/studio/StudioT212ReviewSheet';
import '@/modules/studio/studio-orders.css';

type Direction = 'raise' | 'lower';
// What the editor is doing: saving a lowering, fetching a raise challenge, showing the raise for review, or running
// Face ID and the save. Anything but null locks the account switch and the fields.
type CapsBusy = 'saving' | 'challenge' | 'review' | 'passkey' | null;
// A raise waiting for the user's go-ahead: the exact values the challenge was issued for.
// POST /caps/challenge: the challenge plus the server's current caps and the new ones, which the review shows.
type CapsChallenge = T212StepUpChallenge & { env: T212Env; from: T212CapLimits; to: T212CapLimits };
type PendingRaise = { input: T212CapsInput; challenge: CapsChallenge };

const ENVS: T212Env[] = ['live', 'demo'];
// Caps are amounts of money: the server accepts at most two decimals.
const CAP_PLACES = 2;

function money(value: number, currency: string | undefined) {
  if (!currency) return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}（账户货币）`;
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${currency}`; }
}
// "£250.00 → £400.00", or just the value when it does not change.
function change(from: number, to: number, currency: string | undefined) {
  return from === to ? money(to, currency) : `${money(from, currency)} → ${money(to, currency)}`;
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
 * the per-order cap and the rolling-24-hour cap on buys with today's usage, the server ceiling, applied changes and,
 * listed apart, refused raises. Lowering is saved with the session alone; raising asks the server for a challenge
 * bound to the exact new values, shows them for review, then signs it with Face ID / Touch ID, so it needs a passkey
 * on this domain (the editor explains when there is none).
 */
export function StudioT212CapsEditor({ config, trusted, onSaved }: {
  config: T212TradingConfig; trusted: boolean; onSaved: () => Promise<void> | void;
}) {
  // The account whose caps are shown and edited; starts on the first account that may trade.
  const [env, setEnv] = useState<T212Env>(() => config.allowedEnvs[0] ?? 'live');
  // The save in progress; kept here so the account switch stays locked through the whole raise.
  const [busy, setBusy] = useState<CapsBusy>(null);
  const headingId = useId();
  const caps = config.caps.envs[env];
  const currency = caps.currency ?? config.currency;
  const currencyOf = (item: T212CapChange) => (item.env ? config.caps.envs[item.env].currency : undefined) ?? config.currency;

  return <>
    <div className="t212-subheading">
      <h3 id={headingId}>下单上限</h3>
      <div className="segmented small" role="radiogroup" aria-label="上限所属账户">
        {ENVS.map(value => <button key={value} type="button" role="radio" aria-checked={env === value} disabled={busy !== null}
          onClick={() => setEnv(value)}>{T212_ENV_LABELS[value]}</button>)}
      </div>
    </div>
    {/* Remounted whenever the saved caps change, so the fields start from what the server now enforces. */}
    <CapsForm key={`${env}:${caps.maxOrderValue}:${caps.dailyLimit}:${caps.updatedAt ?? ''}`} env={env} caps={caps} currency={currency}
      ceiling={config.caps.ceiling} blocker={raiseBlocker(config, trusted)} labelledBy={headingId} busy={busy} setBusy={setBusy} onSaved={onSaved} />
    <p className="ios-section-footer t212-settings-note">
      服务器硬上限 {money(config.caps.ceiling, currency)}（<code>STUDIO_T212_CAP_CEILING</code>），任何修改都不能超过。
      降低上限立即生效，不需要验证；提高上限要先核对数值，再用这个网址的面容 ID / 触控 ID 验证，60 秒内有效。
      每日上限只计买入：过去 24 小时已提交、正在提交和状态未知的买单；卖出不占用额度，但仍受单笔上限限制。
      {!caps.custom && ` 当前是服务器默认值（单笔 ${money(config.caps.defaults.maxOrderValue, currency)}，每日 ${money(config.caps.defaults.dailyLimit, currency)}）。`}
    </p>

    <StudioT212HistoryList title="上限变更记录" items={config.capChanges} renderItem={item => <CapChangeRow change={item} currency={currencyOf(item)} />} />
    <StudioT212HistoryList title="被拒绝的提高" items={config.capRefusals} renderItem={item => <CapChangeRow change={item} currency={currencyOf(item)} />} />
  </>;
}

function CapsForm({ env, caps, currency, ceiling, blocker, labelledBy, busy, setBusy, onSaved }: {
  env: T212Env; caps: T212AccountCaps; currency: string | undefined; ceiling: number; blocker: string; labelledBy: string;
  busy: CapsBusy; setBusy: (busy: CapsBusy) => void; onSaved: () => Promise<void> | void;
}) {
  // Typed caps, kept as text so partial input such as "1." is not rewritten; the key resets them after a save.
  const [orderText, setOrderText] = useState(() => String(caps.maxOrderValue));
  const [dailyText, setDailyText] = useState(() => String(caps.dailyLimit));
  // The raise shown for review between fetching its challenge and Face ID; null otherwise.
  const [pendingRaise, setPendingRaise] = useState<PendingRaise | null>(null);
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

  const fail = (reason: unknown, raising: boolean) => {
    const message = saveError(reason);
    setError(message);
    // A cancelled Face ID prompt is the user's own choice; everything else is reported as a failure too.
    if (!cancelled(reason)) toast.error(raising ? '上限没有提高' : '上限没有保存', { description: message });
    // Any caps refusal may mean the server's caps moved on (another tab, a stale review): show what is in force now.
    if (apiErrorCode(reason).startsWith('T212_CAPS_')) void onSaved();
  };
  // Lowering saves at once; raising first fetches the challenge bound to these values and shows them for review.
  const save = async () => {
    if (!ready || maxOrderValue === null || dailyLimit === null) return;
    const input: T212CapsInput = { env, maxOrderValue, dailyLimit };
    setError('');
    if (direction === 'raise') {
      setBusy('challenge');
      try {
        const challenge = await readApiJson<CapsChallenge>(await api.studio.t212Trading.capsChallenge(input));
        setPendingRaise({ input, challenge });
        setBusy('review');
      } catch (reason) { fail(reason, true); setBusy(null); }
      return;
    }
    setBusy('saving');
    try {
      await readApiJson(await api.studio.t212Trading.updateCaps(input));
      toast.success(`已降低${T212_ENV_LABELS[env]}上限`, { description: `单笔 ${money(maxOrderValue, currency)} · 每日 ${money(dailyLimit, currency)}` });
      await onSaved();
    } catch (reason) { fail(reason, false); }
    finally { setBusy(null); }
  };
  // Called straight from the review's confirm tap, so Face ID starts within that user gesture.
  const confirmRaise = async () => {
    if (!pendingRaise) return;
    const { input, challenge } = pendingRaise;
    setBusy('passkey');
    try {
      const assertion = await startAuthentication({ optionsJSON: challenge.authentication });
      await readApiJson(await api.studio.t212Trading.updateCaps(input, { challengeId: challenge.challengeId, assertion }));
      toast.success(`已用面容 ID / 触控 ID 提高${T212_ENV_LABELS[env]}上限`, {
        description: `单笔 ${money(input.maxOrderValue, currency)} · 每日 ${money(input.dailyLimit, currency)}`,
      });
      setPendingRaise(null);
      await onSaved();
    } catch (reason) { setPendingRaise(null); fail(reason, true); }
    finally { setBusy(null); }
  };
  const cancelRaise = () => { setPendingRaise(null); setBusy(null); };

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
          <strong>过去 24 小时买入</strong>
          <small>已用 {money(caps.dailyUsed, currency)} · 还可买入 {money(caps.dailyRemaining, currency)}</small>
        </span>
        <span className={`t212-order-meter t212-caps-meter ${usedRatio >= 1 ? 'full' : usedRatio >= 0.8 ? 'near' : ''}`} aria-hidden="true">
          <span style={{ transform: `scaleX(${usedRatio})` }} />
        </span>
      </div>
      <button type="submit" className="ios-row action left no-icon" disabled={!ready}>
        {busy === 'saving' || busy === 'challenge' ? <StudioSpinner size={16} /> : direction === 'raise' ? <ScanFace size={19} aria-hidden="true" /> : <Check size={19} aria-hidden="true" />}
        {direction === 'raise' ? '用面容 ID / 触控 ID 提高上限' : direction === 'lower' ? '降低上限' : '保存上限'}
      </button>
    </form>
    {problem && <p className="studio-feedback error" role="alert">{problem}</p>}
    {!problem && blocked && <p className="studio-feedback t212-caps-blocked">{blocker}</p>}
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    {/* The review step of a raise: the account and both caps from → to as the server reported them with the
        challenge (never this page's possibly stale copy), before Face ID / Touch ID is asked for. */}
    {pendingRaise && <StudioT212ReviewSheet title={`提高${T212_ENV_LABELS[pendingRaise.challenge.env]}上限？`}
      message="服务器只接受下面这组数值，而且只在上限仍是左边的值时有效。确认后用面容 ID / 触控 ID 验证，验证 60 秒内有效。"
      rows={[
        { label: '账户', value: T212_ENV_LABELS[pendingRaise.challenge.env] },
        { label: '单笔上限', value: change(pendingRaise.challenge.from.maxOrderValue, pendingRaise.challenge.to.maxOrderValue, currency) },
        { label: '每日上限', value: change(pendingRaise.challenge.from.dailyLimit, pendingRaise.challenge.to.dailyLimit, currency) },
      ]}
      verifying={busy === 'passkey'} onConfirm={() => void confirmRaise()} onCancel={cancelRaise} />}
  </>;
}

function CapChangeRow({ change: item, currency }: { change: T212CapChange; currency: string | undefined }) {
  const refused = item.status === 'refused';
  const action = refused ? '提高被拒绝' : item.direction === 'raise' ? '提高' : '降低';
  const values = item.from && item.to
    ? `单笔 ${change(item.from.maxOrderValue, item.to.maxOrderValue, currency)} · 每日 ${change(item.from.dailyLimit, item.to.dailyLimit, currency)}`
    : '请求无效，没有可识别的数值';
  return <StudioT212HistoryRow heading={`${item.env ? T212_ENV_LABELS[item.env] : '未知账户'} · ${action}`} values={values}
    mark={item.direction === 'raise' ? 'up' : 'down'} refused={refused} method={item.method} createdAt={item.createdAt} reason={item.reason} who={item} />;
}
