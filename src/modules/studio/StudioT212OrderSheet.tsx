import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'motion/react';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { toast } from 'sonner';

import { IconAlertTriangle, IconChevronLeft, IconFaceId, IconShieldCheck } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import { T212_MODE_LABELS } from '@/shared/constants';
import type { T212Env, T212OrderSide, T212Position, T212TradingConfig } from '@/shared/types';
import { apiErrorCode, decimalInputProblem, parseDecimalInput } from '@/shared/utils';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import { StudioT212PasskeyEnroll } from '@/modules/studio/StudioT212Passkeys';
import '@/modules/studio/studio-orders.css';

type OrderType = 'market' | 'limit';
type TimeValidity = 'DAY' | 'GOOD_TILL_CANCEL';
type OrderPreview = {
  id: string; env: T212Env; ticker: string; side: T212OrderSide; type: OrderType; quantity: number;
  limitPrice?: number; timeValidity?: TimeValidity; estimatedValue: number; currency: string; maxOrderValue: number;
  // The rolling-24-hour cap and what other orders already used of it, before this one.
  dailyLimit: number; dailyUsed: number; dailyRemaining: number;
  warnings: string[]; expiresAt: string; requires: 'passkey' | 'confirm'; authentication?: PublicKeyCredentialRequestOptionsJSON;
};
type ReviewedOrder = OrderPreview & { deadline: number };
type OrderResult = { order: { id: string | null; status: string | null; ticker: string }; method: 'passkey' | 'confirm' };

const TICKER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SIDE_LABEL: Record<T212OrderSide, string> = { buy: '买入', sell: '卖出' };
// Decimal places the server accepts for a quantity and a limit price.
const QUANTITY_PLACES = 6;
const PRICE_PLACES = 4;
// The server keeps a preview for 60 s; the local countdown keeps a margin for the round trip.
const PREVIEW_WINDOW_MS = 58_000;
// Matches the sheet's CSS exit animation.
const EXIT_MS = 220;
// Steps slide like a navigation push; the exit is short because mode="wait" holds the next step until it ends.
const STEP_VARIANTS = {
  enter: (direction: number) => ({ opacity: 0, x: 28 * direction }),
  center: { opacity: 1, x: 0, transition: { type: 'spring' as const, stiffness: 420, damping: 38 } },
  exit: (direction: number) => ({ opacity: 0, x: -28 * direction, transition: { duration: 0.14, ease: 'easeIn' as const } }),
};
// Plain decimal text (never exponent notation such as 1e-7), without trailing zeros.
function decimalText(value: number) {
  return value.toFixed(12).replace(/\.?0+$/, '');
}
// The holding rounded down (never up) to the decimals an order may carry, as text for the quantity field.
function sellableQuantity(quantity: number) {
  const [whole, fraction = ''] = quantity.toFixed(12).split('.');
  const kept = fraction.slice(0, QUANTITY_PLACES).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}
// Mirrors the server for held tickers: value per share in the account currency, FX-converted for limits, and a
// limit sell never below the current value (it fills at the limit or better). Unheld tickers have no rate here,
// so they are quantity × limit in the instrument's own currency and the server converts them.
function estimateValue(position: T212Position | undefined, side: T212OrderSide, type: OrderType, quantity: number, limitPrice: number | null) {
  const perShare = position && position.quantity > 0 ? position.value / position.quantity : 0;
  if (type === 'market') return quantity * perShare;
  if (limitPrice === null) return 0;
  if (position && position.currentPrice > 0 && perShare > 0) {
    const atLimit = quantity * limitPrice * (perShare / position.currentPrice);
    return side === 'sell' ? Math.max(atLimit, quantity * perShare) : atLimit;
  }
  return quantity * limitPrice;
}
// Wall-clock time for the expiry countdown; only called from event handlers and the countdown interval.
function currentTime() {
  return Date.now();
}
function exitDelay() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS;
}
function reasonText(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * Used by StudioTrading212 to place one Trading 212 order: form with a live estimate against the per-order cap
 * and, for buys, the remaining rolling-24-hour allowance (both per account, edited in Settings), a server-checked review, then Face ID / Touch ID (passkey) or, while the user has no passkey anywhere, a second
 * destructive confirmation. Where a passkey is required but missing, it offers to enable one for this domain.
 */
export function StudioT212OrderSheet({ env, config, positions, format, initialTicker, initialSide, onClose, onPlaced, onTradingChange }: {
  env: T212Env; config: T212TradingConfig; positions: T212Position[]; format: (value: number) => string;
  initialTicker?: string; initialSide?: T212OrderSide; onClose: () => void; onPlaced: () => void;
  onTradingChange: () => Promise<void> | void;
}) {
  // Instrument code typed or picked from the holdings, e.g. AAPL_US_EQ.
  const [ticker, setTicker] = useState(initialTicker ?? '');
  // Requested direction; selling is only offered for held tickers.
  const [side, setSide] = useState<T212OrderSide>(initialSide ?? 'buy');
  // Requested type; tickers that are not held are always limit orders, whatever this says.
  const [type, setType] = useState<OrderType>('market');
  // Quantity and limit price stay as typed text so partial input such as "1." is not rewritten.
  const [quantityText, setQuantityText] = useState('');
  const [limitText, setLimitText] = useState('');
  // Limit order lifetime: until the exchange day ends, or until cancelled in Trading 212.
  const [timeValidity, setTimeValidity] = useState<TimeValidity>('DAY');
  // The server-checked preview being reviewed; null while editing the form.
  const [preview, setPreview] = useState<ReviewedOrder | null>(null);
  // A confirmation attempt consumed the single-use preview, so a fresh one is needed.
  const [spent, setSpent] = useState(false);
  // Request in flight; locks the actions and shows a spinner. While 'confirm', the sheet cannot be closed.
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  // Server or authenticator failure, kept visible until the next attempt.
  const [error, setError] = useState('');
  // The second, destructive confirmation alert for users without any passkey.
  const [confirming, setConfirming] = useState(false);
  // Ticks once a second while reviewing so the expiry countdown stays honest.
  const [clock, setClock] = useState(0);
  // The exit animation runs before the sheet unmounts.
  const [closing, setClosing] = useState(false);
  // The server refused the double confirmation for this domain (its config can be newer than ours).
  const [passkeyRefused, setPasskeyRefused] = useState(false);
  // The broker may or may not have executed the confirmed order (timeout, 408, 5xx): no new preview is offered.
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  // The order the server held back because an identical one had an unknown outcome; it can be acknowledged.
  const [unknownPendingOrder, setUnknownPendingOrder] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  // Whether the sheet is still mounted, so an outcome that arrives after it was closed is reported with a toast.
  const mounted = useRef(true);

  const enabled = config.allowedEnvs.includes(env);
  // STUDIO_T212_TRADING allows this account, so only the user's own trading mode can have left it out.
  const serverAllows = config.tradingMode.ceiling === 'both' || config.tradingMode.ceiling === env;
  const host = window.location.hostname;
  const passkeyHere = config.passkeys.some(item => item.rpId === host);
  const otherDomains = [...new Set(config.passkeys.map(item => item.rpId))].filter(rpId => rpId !== host);
  const needsPasskey = !passkeyHere && (config.requirePasskey || config.passkeys.length > 0 || passkeyRefused);
  const code = ticker.trim();
  const position = positions.find(item => item.ticker === code && item.quantity > 0);
  const orderType: OrderType = position ? type : 'limit';
  const orderSide: T212OrderSide = position ? side : 'buy';
  const quantity = parseDecimalInput(quantityText, QUANTITY_PLACES);
  const limitPrice = orderType === 'limit' ? parseDecimalInput(limitText, PRICE_PLACES) : null;
  const sellAllText = position ? sellableQuantity(position.quantity) : '';
  const remainder = position ? position.quantity - Number(sellAllText) : 0;
  // "全部" rounded the holding down; the leftover fraction is explained instead of silently disappearing.
  const showRemainder = Boolean(position && orderSide === 'sell' && quantityText === sellAllText && remainder > 1e-12);
  const quantityProblem = showRemainder && sellAllText === '0' ? '' : decimalInputProblem(quantityText, QUANTITY_PLACES, '数量');
  const limitProblem = orderType === 'limit' ? decimalInputProblem(limitText, PRICE_PLACES, '限价') : '';
  const estimate = quantity === null ? 0 : estimateValue(position, orderSide, orderType, quantity, limitPrice);
  const caps = config.caps.envs[env];
  const cap = caps.maxOrderValue;
  // Only a held ticker's estimate is in the account currency; the server converts and checks the others.
  const converted = Boolean(position);
  const overCap = converted && estimate > cap;
  // Only buys use the daily allowance. Informational only: it can be stale (the 24-hour window rolls on), so the
  // server has the last word.
  const overDaily = orderSide === 'buy' && converted && !overCap && estimate > caps.dailyRemaining;
  const overHolding = Boolean(orderSide === 'sell' && position && quantity !== null && quantity > position.quantity + 1e-9);
  const ready = enabled && TICKER.test(code) && quantity !== null && (orderType === 'market' || limitPrice !== null) && !overCap && !overHolding;
  const orderKey = `${env}|${code}|${orderSide}|${quantity ?? ''}`;
  const secondsLeft = preview ? Math.max(0, Math.ceil((preview.deadline - clock) / 1000)) : 0;
  const expired = Boolean(preview && (spent || secondsLeft <= 0));

  useEffect(() => {
    // Focus moves into the sheet and returns to whatever opened it.
    const previous = document.activeElement as HTMLElement | null;
    mounted.current = true;
    return () => { mounted.current = false; previous?.focus?.(); };
  }, []);
  useEffect(() => {
    if (!preview || spent) return;
    const timer = window.setInterval(() => setClock(currentTime()), 1000);
    return () => window.clearInterval(timer);
  }, [preview, spent]);

  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(onClose, exitDelay());
  };
  // Scrim, Escape and the header buttons: refused while an order confirmation is in flight, so its outcome stays visible.
  const close = () => { if (busy !== 'confirm') dismiss(); };
  const back = () => { setPreview(null); setSpent(false); setError(''); setUnknownOutcome(false); };

  const requestPreview = async (acknowledgeUnknown = false) => {
    if (!ready || quantity === null) return;
    setBusy('preview'); setError('');
    try {
      const next = await readApiJson<OrderPreview>(await api.studio.t212Trading.preview({
        env, ticker: code, side: orderSide, type: orderType, quantity,
        ...(orderType === 'limit' && limitPrice !== null ? { limitPrice, timeValidity } : {}),
        ...(acknowledgeUnknown ? { acknowledgeUnknown: true } : {}),
      }));
      const receivedAt = currentTime();
      setClock(receivedAt);
      setPreview({ ...next, deadline: receivedAt + PREVIEW_WINDOW_MS });
      setSpent(false); setUnknownOutcome(false); setUnknownPendingOrder(null);
    } catch (reason) {
      const kind = apiErrorCode(reason);
      // Both refusals are handled on their own step: enabling Face ID here, or acknowledging the unknown order.
      if (kind === 'T212_PASSKEY_REQUIRED') { setPasskeyRefused(true); setPreview(null); }
      if (kind === 'T212_ORDER_UNKNOWN_PENDING') { setUnknownPendingOrder(orderKey); setPreview(null); }
      // The caps or the trading mode may have changed elsewhere (Settings, another device): refresh what the form shows.
      if (kind === 'T212_ORDER_CAP' || kind === 'T212_DAILY_CAP' || kind === 'T212_TRADING_DISABLED') void onTradingChange();
      setError(reasonText(reason, '无法生成订单预览'));
    } finally { setBusy(null); }
  };

  const submit = async (proof: { assertion: unknown } | { confirmed: true }) => {
    if (!preview) return;
    setBusy('confirm'); setError('');
    try {
      const result = await readApiJson<OrderResult>(await api.studio.t212Trading.confirm(preview.id, proof));
      toast.success(`已提交${SIDE_LABEL[preview.side]} ${preview.quantity} 股 ${preview.ticker}`, {
        description: `Trading 212 订单 ${result.order.id ?? ''} · ${result.order.status ?? '已受理'}`.trim(),
      });
      onPlaced();
      dismiss();
    } catch (reason) {
      const message = reasonText(reason, '下单失败');
      const unknown = apiErrorCode(reason) === 'T212_ORDER_UNKNOWN';
      if (!mounted.current) {
        // The sheet was unmounted anyway (for example by its parent); the outcome must still reach the user.
        toast.error(unknown ? `${SIDE_LABEL[preview.side]} ${preview.ticker} 的订单状态未知` : `${SIDE_LABEL[preview.side]} ${preview.ticker} 没有提交`, {
          description: unknown ? `${message}。请先在 Trading 212 核对，不要直接重新下单。` : message,
        });
        return;
      }
      // Previews are single use: whatever went wrong, confirming again needs a fresh preview.
      setSpent(true);
      // A narrowed trading mode turns the sheet into its "not enabled" step once the settings are re-read.
      if (['T212_ORDER_CAP', 'T212_DAILY_CAP', 'T212_TRADING_DISABLED'].includes(apiErrorCode(reason))) void onTradingChange();
      setUnknownOutcome(unknown);
      setError(message);
    } finally { if (mounted.current) setBusy(null); }
  };

  const confirmWithPasskey = async () => {
    if (!preview?.authentication) return;
    setBusy('confirm'); setError('');
    let assertion: unknown;
    try {
      assertion = await startAuthentication({ optionsJSON: preview.authentication });
    } catch (reason) {
      // Cancelling Face ID never reaches the server, so the same preview can be confirmed again.
      setBusy(null);
      setError(reason instanceof Error && reason.name === 'NotAllowedError'
        ? '已取消面容 ID / 触控 ID 验证，订单没有提交'
        : `无法完成面容 ID / 触控 ID 验证${reason instanceof Error && reason.message ? `：${reason.message}` : ''}`);
      return;
    }
    await submit({ assertion });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Keys from the second confirmation alert bubble here through the React tree; that alert handles them.
    if (confirming || event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab' || !sheet.current) return;
    // Keep keyboard focus inside the sheet.
    const focusable = [...sheet.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const ratio = converted ? Math.min(1, cap > 0 ? estimate / cap : 0) : 0;
  const meterTone = overCap ? 'over' : ratio >= 0.8 ? 'near' : '';
  const holdings = positions.filter(item => item.quantity > 0);
  const envLabel = env === 'live' ? '实盘' : '模拟';
  const direction = preview ? 1 : -1;
  const estimateText = estimate <= 0 ? '—' : converted ? `≈ ${format(estimate)}` : `≈ ${estimate.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  const estimateNote = !converted && estimate > 0
    ? `按标的计价货币计算；预览时服务器换算成账户货币，再按单笔上限 ${format(cap)} 和今日剩余额度检查`
    : overCap ? `超过单笔上限 ${format(cap)}，请减少数量` : `单笔上限 ${format(cap)}`;
  const dailyNote = orderSide === 'sell'
    ? `卖出不占用每日买入额度（今日还可买入 ${format(caps.dailyRemaining)}）`
    : overDaily
      ? `超过今日剩余买入额度 ${format(caps.dailyRemaining)}，服务器会拒绝；可以在「设置 → 交易安全」调整每日上限`
      : `今日剩余买入额度 ${format(caps.dailyRemaining)} · 每日上限 ${format(caps.dailyLimit)}（滚动 24 小时）`;

  const form = <m.form key="form" className="t212-order-step" custom={direction} variants={STEP_VARIANTS} initial="enter" animate="center" exit="exit"
    onSubmit={event => { event.preventDefault(); void requestPreview(); }}>
    <div className="ios-list t212-order-fields">
      <div className="ios-field">
        <label htmlFor="t212-order-ticker">代码</label>
        <input id="t212-order-ticker" value={ticker} onChange={event => setTicker(event.target.value)} autoFocus={!initialTicker}
          autoCapitalize="characters" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="例如 AAPL_US_EQ" />
      </div>
      {holdings.length > 0 && <div className="t212-order-chips" role="group" aria-label="持仓">
        {holdings.map(item => <button type="button" key={item.ticker} className="t212-order-chip" aria-pressed={item.ticker === code}
          title={item.ticker} onClick={() => setTicker(item.ticker)}>{item.name || item.ticker}</button>)}
      </div>}
      <div className="t212-order-row">
        <span id="t212-order-side">方向</span>
        <div className="segmented t212-order-segmented" role="radiogroup" aria-labelledby="t212-order-side">
          {(['buy', 'sell'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={orderSide === value}
            disabled={value === 'sell' && !position} onClick={() => setSide(value)}>{SIDE_LABEL[value]}</button>)}
        </div>
      </div>
      <div className="t212-order-row">
        <span id="t212-order-type">类型</span>
        <div className="segmented t212-order-segmented" role="radiogroup" aria-labelledby="t212-order-type">
          <button type="button" role="radio" aria-checked={orderType === 'market'} disabled={!position} onClick={() => setType('market')}>市价</button>
          <button type="button" role="radio" aria-checked={orderType === 'limit'} onClick={() => setType('limit')}>限价</button>
        </div>
      </div>
      <div className="ios-field">
        <label htmlFor="t212-order-quantity">数量</label>
        <input id="t212-order-quantity" inputMode="decimal" autoComplete="off" value={quantityText} autoFocus={Boolean(initialTicker)}
          onChange={event => setQuantityText(event.target.value)} placeholder="股数，最多 6 位小数" aria-invalid={overHolding || Boolean(quantityProblem) || undefined} />
        {position && <span className="t212-order-aside">持有 {position.quantity.toLocaleString('zh-CN', { maximumFractionDigits: 10 })}</span>}
        {position && orderSide === 'sell' && <button type="button" className="t212-order-all" onClick={() => setQuantityText(sellAllText)}>全部</button>}
      </div>
      {orderType === 'limit' && <div className="ios-field">
        <label htmlFor="t212-order-limit">限价</label>
        <input id="t212-order-limit" inputMode="decimal" autoComplete="off" value={limitText} onChange={event => setLimitText(event.target.value)}
          placeholder={position ? `现价 ${position.currentPrice.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}` : '每股价格'} aria-invalid={Boolean(limitProblem) || undefined} />
        {position?.currency && <span className="t212-order-aside">{position.currency}</span>}
      </div>}
      {orderType === 'limit' && <div className="t212-order-row">
        <span id="t212-order-validity">有效期</span>
        <div className="segmented t212-order-segmented" role="radiogroup" aria-labelledby="t212-order-validity">
          <button type="button" role="radio" aria-checked={timeValidity === 'DAY'} onClick={() => setTimeValidity('DAY')}>当日有效</button>
          <button type="button" role="radio" aria-checked={timeValidity === 'GOOD_TILL_CANCEL'} onClick={() => setTimeValidity('GOOD_TILL_CANCEL')}>撤单前有效</button>
        </div>
      </div>}
    </div>
    {code && !position && <p className="t212-order-hint">没有持有这个标的：只能挂限价买入。限价按它的计价货币填写（伦敦股票通常是便士），预览时服务器会换算金额；无法换算汇率时会拒绝。</p>}
    {showRemainder && position && <p className="t212-order-hint">
      {sellAllText === '0'
        ? `持仓只有 ${decimalText(position.quantity)} 股，不到 0.000001 股，Studio 无法卖出，请在 Trading 212 里处理。`
        : `「全部」按 6 位小数向下取整为 ${sellAllText} 股，会留下 ${decimalText(remainder)} 股零头：Trading 212 的 API 订单最多 6 位小数，零头需要在 Trading 212 里处理。`}
    </p>}
    <section className={`t212-order-estimate ${meterTone}`} aria-label="预计金额" aria-live="polite">
      <span>预计金额</span>
      <strong>{estimateText}</strong>
      {converted && <span className="t212-order-meter" aria-hidden="true"><span style={{ transform: `scaleX(${ratio})` }} /></span>}
      <small>{estimateNote}</small>
      <small className={`t212-order-daily ${overDaily ? 'over' : ''}`}>{dailyNote}</small>
    </section>
    {(quantityProblem || limitProblem) && <p className="studio-feedback error" role="alert">{quantityProblem || limitProblem}</p>}
    {overHolding && position && <p className="studio-feedback error" role="alert">卖出数量超过持仓（持有 {decimalText(position.quantity)} 股）</p>}
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    {unknownPendingOrder === orderKey && <button type="button" className="ios-button tinted t212-order-acknowledge" disabled={busy !== null} onClick={() => void requestPreview(true)}>
      我已在 Trading 212 核对过，之前那笔没有成交，仍要下单
    </button>}
    <div className="t212-order-actions">
      <button type="submit" className="ios-button filled t212-order-primary" disabled={!ready || busy !== null}>
        {busy === 'preview' && <StudioSpinner size={16} />}下一步
      </button>
    </div>
  </m.form>;

  const review = preview && <m.div key="review" className="t212-order-step" custom={direction} variants={STEP_VARIANTS} initial="enter" animate="center" exit="exit">
    <section className="t212-order-review" aria-label="订单摘要">
      <span className={`t212-kind ${preview.side}`}>{SIDE_LABEL[preview.side]}</span>
      <h3>{SIDE_LABEL[preview.side]} {preview.quantity} 股</h3>
      <p>{positions.find(item => item.ticker === preview.ticker)?.name ?? preview.ticker} · {preview.ticker}</p>
      <strong className="t212-order-review-value">≈ {format(preview.estimatedValue)}</strong>
      <dl>
        <div><dt>账户</dt><dd>{preview.env === 'live' ? '实盘 · 真实资金' : '模拟盘'}</dd></div>
        <div><dt>类型</dt><dd>{preview.type === 'market' ? '市价单' : `限价 ${preview.limitPrice} · ${preview.timeValidity === 'GOOD_TILL_CANCEL' ? '撤单前有效' : '当日有效'}`}</dd></div>
        <div><dt>单笔上限</dt><dd>{format(preview.maxOrderValue)}</dd></div>
        <div><dt>今日买入额度</dt><dd>{preview.side === 'sell'
          ? `${format(preview.dailyRemaining)} · 卖出不占用`
          : `${format(preview.dailyRemaining)} · 下单后 ${format(Math.max(0, preview.dailyRemaining - preview.estimatedValue))}`}</dd></div>
        <div><dt>确认方式</dt><dd>{preview.requires === 'passkey' ? '面容 ID / 触控 ID' : '二次确认'}</dd></div>
      </dl>
    </section>
    {preview.warnings.length > 0 && <ul className="t212-order-warnings" aria-label="提醒">
      {preview.warnings.map(warning => <li key={warning}><IconAlertTriangle size={15} aria-hidden="true" />{warning}</li>)}
    </ul>}
    <div className="t212-order-timer-row">
      <span>{expired ? '这份预览已失效，需要重新生成' : `${secondsLeft} 秒内确认有效`}</span>
      <span className={`t212-order-timer ${expired ? 'spent' : ''}`} aria-hidden="true"><span key={preview.id} style={{ animationDuration: `${PREVIEW_WINDOW_MS}ms` }} /></span>
    </div>
    {unknownOutcome
      ? <div className="t212-order-unknown" role="alert">
        <IconAlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>订单状态未知</strong>
          <span>{error}</span>
          <span>请打开 Trading 212 查看订单记录，确认这笔订单是否已经提交，不要直接重新下单。Studio 不会自动重试；几分钟内再下相同的订单需要你明确确认。</span>
        </div>
      </div>
      : error && <p className="studio-feedback error" role="alert">{error}</p>}
    {preview.requires === 'confirm' && !expired && <p className="t212-order-note">还没有启用面容 ID / 触控 ID，下单前需要再确认一次。可以在「设置 → 交易安全」里启用。</p>}
    <div className="t212-order-actions">
      {unknownOutcome
        ? <button type="button" className="ios-button tinted t212-order-primary" onClick={close}>关闭，去 Trading 212 核对</button>
        : expired
          ? <button type="button" className="ios-button filled t212-order-primary" disabled={busy !== null} onClick={() => void requestPreview()}>
            {busy === 'preview' && <StudioSpinner size={16} />}重新生成预览
          </button>
          : preview.requires === 'passkey'
            ? <button type="button" className="ios-button filled t212-order-primary" disabled={busy !== null} onClick={() => void confirmWithPasskey()}>
              {busy === 'confirm' ? <StudioSpinner size={16} /> : <IconFaceId size={19} aria-hidden="true" />}用面容 ID / 触控 ID {SIDE_LABEL[preview.side]}
            </button>
            : <button type="button" className="ios-button t212-order-primary t212-order-danger" disabled={busy !== null} onClick={() => setConfirming(true)}>
              {busy === 'confirm' && <StudioSpinner size={16} />}{SIDE_LABEL[preview.side]}下单
            </button>}
    </div>
  </m.div>;

  const enroll = <m.div key="enroll" className="t212-order-step" custom={direction} variants={STEP_VARIANTS} initial="enter" animate="center" exit="exit">
    <div className="t212-order-off">
      <IconFaceId size={32} strokeWidth={1.5} aria-hidden="true" />
      <strong>先为 {host} 启用面容 ID / 触控 ID</strong>
      <span>{config.requirePasskey
        ? '服务器要求每笔订单都用面容 ID / 触控 ID 确认（STUDIO_T212_REQUIRE_PASSKEY=1）。'
        : otherDomains.length
          ? `你已在 ${otherDomains.join('、')} 启用了面容 ID / 触控 ID。为了不让其他网址绕过它，这里不能再用二次确认下单。`
          : error || '服务器要求先为这个网址启用面容 ID / 触控 ID。'}</span>
      <span>启用需要输入 Studio 登录密码，之后这个网址的每笔订单都用面容 ID / 触控 ID 确认。</span>
    </div>
    <StudioT212PasskeyEnroll again={false} onEnrolled={async () => { setPasskeyRefused(false); setError(''); await onTradingChange(); }} />
  </m.div>;

  // Not enabled: either the server does not allow this account at all, or the user's trading mode leaves it out.
  const off = <m.div key="off" className="t212-order-step" custom={direction} variants={STEP_VARIANTS} initial="enter" animate="center" exit="exit">
    <div className="t212-order-off">
      <IconShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" />
      {serverAllows ? <>
        <strong>{env === 'live' ? '实盘' : '模拟盘'}下单已关闭</strong>
        <span>允许下单的账户目前是「{T212_MODE_LABELS[config.tradingMode.mode]}」。可以在「设置 → 交易安全」开启{env === 'live' ? '实盘' : '模拟盘'}，开启需要面容 ID / 触控 ID。</span>
      </> : <>
        <strong>{env === 'live' ? '实盘' : '模拟盘'}下单未开启</strong>
        <span>在服务器的 .env 里设置 <code>STUDIO_T212_TRADING={env}</code>（或 <code>both</code> 同时开启实盘和模拟盘），然后重启 Studio。</span>
        <span>单笔和每日上限默认取 <code>STUDIO_T212_MAX_ORDER_VALUE</code> 和 <code>STUDIO_T212_MAX_DAILY_VALUE</code>，可以在「设置 → 交易安全」修改（提高需要面容 ID / 触控 ID）。开启后每笔订单都要经过面容 ID / 触控 ID 或二次确认。</span>
      </>}
    </div>
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    <div className="t212-order-actions"><button type="button" className="ios-button tinted t212-order-primary" onClick={close}>好</button></div>
  </m.div>;

  return createPortal(
    <div className={`studio-layer ${closing ? 'closing' : ''}`} onKeyDown={onKeyDown}>
      <div className="sheet-scrim" aria-hidden="true" onClick={close} />
      <div ref={sheet} className="t212-order-sheet" role="dialog" aria-modal="true" aria-labelledby="t212-order-title" aria-busy={busy === 'confirm' || undefined}>
        <div className="t212-order-grabber" aria-hidden="true" />
        <header className="t212-order-header">
          {preview
            ? <button type="button" className="t212-order-nav" disabled={busy !== null} onClick={back}><IconChevronLeft size={22} aria-hidden="true" />修改</button>
            : <button type="button" className="t212-order-nav" disabled={busy === 'confirm'} onClick={close}>取消</button>}
          <h2 id="t212-order-title">{preview ? '确认订单' : `交易 · ${envLabel}`}</h2>
          <span className={`t212-env-badge ${env}`}>{env === 'live' ? '实盘' : '模拟'}</span>
        </header>
        <div className="t212-order-body">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            {!enabled ? off : review || (needsPasskey ? enroll : form)}
          </AnimatePresence>
        </div>
      </div>
      {confirming && preview && <StudioConfirmSheet
        title={`确认${SIDE_LABEL[preview.side]} ${preview.quantity} 股 ${preview.ticker}（约 ${format(preview.estimatedValue)}）？`}
        message={`${preview.env === 'live' ? '实盘账户，使用真实资金' : '模拟账户'} · ${preview.type === 'market' ? '市价单' : `限价 ${preview.limitPrice}`}。提交后只能在 Trading 212 里撤单。`}
        confirmLabel={`确认${SIDE_LABEL[preview.side]}`}
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void submit({ confirmed: true }); }} />}
    </div>,
    document.body,
  );
}
