import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, RefreshCw, ShieldCheck } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { T212Activity, T212Change, T212Env, T212OrderSide, T212Overview, T212Point, T212Status, T212TradingConfig } from '@/shared/types';
import { StudioEquityChart } from '@/modules/studio/StudioEquityChart';
import { StudioT212OrderSheet } from '@/modules/studio/StudioT212OrderSheet';
import '@/modules/studio/studio-orders.css';

const RANGES = [{ days: 7, label: '1周' }, { days: 30, label: '1月' }, { days: 90, label: '3月' }, { days: 0, label: '全部' }];

function money(currency: string, digits = 2) {
  try {
    const formatter = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency || 'GBP', minimumFractionDigits: digits, maximumFractionDigits: digits });
    return (value: number) => formatter.format(value);
  } catch { return (value: number) => value.toFixed(2); }
}
function signed(format: (value: number) => string, value: number) {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${format(Math.abs(value))}`;
}

// Direction is shown by sign, arrow glyph and a colored mark, never by color alone.
function Delta({ change, format, label }: { change: T212Change | null; format: (value: number) => string; label: string }) {
  if (!change) return <span className="t212-delta muted">{label} · 记录不足</span>;
  const direction = change.amount > 0 ? 'gain' : change.amount < 0 ? 'loss' : 'flat';
  const Icon = direction === 'gain' ? ArrowUpRight : direction === 'loss' ? ArrowDownRight : Minus;
  return <span className={`t212-delta ${direction}`}>
    <Icon size={16} className="t212-mark" aria-hidden="true" />
    {signed(format, change.amount)}（{change.percent >= 0 ? '+' : '−'}{Math.abs(change.percent).toFixed(2)}%）<small>{label}</small>
  </span>;
}

/**
 * Used by StudioPage's project app as the Trading 212 view: balances, curve, positions and activity, plus order
 * placement through StudioT212OrderSheet when the server allows trading for the selected account.
 */
export function StudioTrading212() {
  // Server-side key files per environment; the keys themselves never reach the browser.
  const [status, setStatus] = useState<T212Status[] | null>(null);
  // The account being viewed; live is the default when both are configured.
  const [env, setEnv] = useState<T212Env>('live');
  // Latest account overview from the broker.
  const [overview, setOverview] = useState<T212Overview | null>(null);
  // Stored snapshots for the selected range.
  const [points, setPoints] = useState<T212Point[]>([]);
  // Recent fills and dividends.
  const [activity, setActivity] = useState<T212Activity[]>([]);
  // Selected chart range in days; 0 means all recorded history.
  const [days, setDays] = useState(30);
  // A request is in flight; drives the refresh spinner and skeletons.
  const [loading, setLoading] = useState(true);
  // Broker or configuration failure shown in place of numbers.
  const [error, setError] = useState('');
  // Server order-safety settings (allowed accounts, caps and daily usage, passkeys); null until loaded or when unavailable.
  const [trading, setTrading] = useState<T212TradingConfig | null>(null);
  // The open order sheet and what it was opened with (a position's ticker and side, or nothing from the toolbar).
  const [orderSheet, setOrderSheet] = useState<{ ticker?: string; side?: T212OrderSide } | null>(null);
  // Numbers the latest load, so a slower response for a previously selected account is dropped.
  const loadSequence = useRef(0);

  const load = useCallback(async (target: T212Env) => {
    const sequence = ++loadSequence.current;
    setLoading(true); setError('');
    try {
      const next = await readApiJson<T212Overview>(await api.studio.trading212.overview(target));
      if (sequence !== loadSequence.current) return;
      setOverview(next);
      // History and activity are secondary; their failure must not hide the balance.
      const [history, recent] = await Promise.all([
        api.studio.trading212.history(target, days).then(readApiJson<T212Point[]>).catch(() => [] as T212Point[]),
        api.studio.trading212.activity(target).then(readApiJson<T212Activity[]>).catch(() => [] as T212Activity[]),
      ]);
      if (sequence !== loadSequence.current) return;
      setPoints(history); setActivity(recent);
    } catch (reason) {
      if (sequence === loadSequence.current) setError(reason instanceof Error ? reason.message : 'Trading 212 读取失败');
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [days]);
  // Re-read the trading settings, e.g. after the order sheet enabled Face ID for this domain.
  const reloadTrading = useCallback(async () => {
    try { setTrading(await readApiJson<T212TradingConfig>(await api.studio.t212Trading.config())); } catch { /* keep the last settings */ }
  }, []);
  // Switching accounts drops the other account's numbers at once, so its positions can never feed an order sheet here.
  const switchEnv = (next: T212Env) => {
    if (next === env) return;
    setEnv(next); setOverview(null); setPoints([]); setActivity([]); setOrderSheet(null); setError('');
  };

  useEffect(() => {
    let active = true;
    void api.studio.trading212.status().then(readApiJson<T212Status[]>).then(value => {
      if (!active) return;
      setStatus(value);
      const preferred = value.find(item => item.env === 'live' && item.configured) ? 'live' : value.find(item => item.configured)?.env;
      if (preferred) { setEnv(preferred); } else { setLoading(false); }
    }).catch(reason => { if (active) { setError(reason instanceof Error ? reason.message : '状态读取失败'); setLoading(false); } });
    // Trading settings are optional: without them the view simply stays read-only.
    void api.studio.t212Trading.config().then(readApiJson<T212TradingConfig>).then(value => { if (active) setTrading(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const configured = status?.filter(item => item.configured) ?? [];
  const canLoad = configured.some(item => item.env === env);
  useEffect(() => { if (canLoad) void load(env); }, [canLoad, env, load]);

  if (status && !configured.length) {
    return <section className="ios-section first">
      <div className="ios-list"><div className="ios-empty">
        <ShieldCheck size={30} strokeWidth={1.5} aria-hidden="true" />
        <strong>尚未接入 Trading 212</strong>
        <span>在服务器的 .env 里设置 STUDIO_T212_ENV_FILE，指向包含 TRADING212_API_KEY 和 TRADING212_API_SECRET 的文件，然后重启 Studio。</span>
      </div></div>
    </section>;
  }

  // Only an overview of the selected account is shown or traded from; anything else is stale.
  const current = overview?.env === env ? overview : null;
  const format = money(current?.currency ?? 'GBP');
  const total = current?.positions.reduce((sum, position) => sum + position.value, 0) || 1;
  const tradable = Boolean(trading?.allowedEnvs.includes(env));
  return <div className="t212 studio-stagger">
    <div className="t212-toolbar">
      {configured.length > 1 && <div className="segmented" role="radiogroup" aria-label="账户">
        {configured.map(item => <button key={item.env} type="button" role="radio" aria-checked={env === item.env} onClick={() => switchEnv(item.env)}>{item.env === 'live' ? '实盘' : '模拟'}</button>)}
      </div>}
      <span className={`status-badge ${tradable ? (env === 'live' ? 'warn' : 'good') : ''}`}><ShieldCheck size={14} aria-hidden="true" />{tradable ? '可交易' : '只读'} · {env === 'live' ? '实盘' : '模拟'}</span>
      {trading && current && <button type="button" className="ios-button tinted t212-trade-button" onClick={() => setOrderSheet({})}>交易</button>}
      <button type="button" className={`icon-button ${loading ? 'refreshing' : ''}`} aria-label="刷新" title="刷新" disabled={loading} onClick={() => void load(env)}><RefreshCw size={18} className="refresh-icon" aria-hidden="true" /></button>
    </div>

    {error && <p className="studio-feedback error" role="alert">{error}</p>}

    {!current && loading && <div className="studio-skeleton" role="status" aria-label="正在读取账户"><div className="skeleton-block" style={{ height: 120 }} /><div className="skeleton-block" style={{ height: 240 }} /></div>}

    {current && <>
      <section className="t212-hero" aria-label="总资产">
        <span className="t212-hero-label">总资产</span>
        <strong className="t212-hero-value">{format(current.totalValue)}</strong>
        <Delta change={current.changes.today} format={format} label="今日" />
      </section>

      <section className="t212-card">
        <div className="t212-card-head">
          <h2>资产曲线</h2>
          <div className="segmented small" role="radiogroup" aria-label="时间范围">
            {RANGES.map(range => <button key={range.days} type="button" role="radio" aria-checked={days === range.days} onClick={() => setDays(range.days)}>{range.label}</button>)}
          </div>
        </div>
        {points.length >= 2
          ? <StudioEquityChart points={points} format={format} axisFormat={money(current.currency, 0)} />
          : <p className="t212-chart-empty">曲线从 Studio 首次读取账户时开始记录，每 30 分钟一个点；{current.recordedSince ? `已于 ${new Date(current.recordedSince).toLocaleString('zh-CN')} 开始记录。` : '稍后回来就能看到。'}</p>}
      </section>

      <div className="t212-stats">
        <div className="t212-stat"><span>昨日盈亏</span><Delta change={current.changes.yesterday} format={format} label="" /></div>
        <div className="t212-stat"><span>持仓浮动盈亏</span><strong>{signed(format, current.investments.unrealized)}</strong></div>
        <div className="t212-stat"><span>已实现盈亏</span><strong>{signed(format, current.investments.realized)}</strong></div>
        <div className="t212-stat"><span>可用现金</span><strong>{format(current.cash.available)}</strong></div>
        <div className="t212-stat"><span>持仓市值</span><strong>{format(current.investments.value)}</strong></div>
        <div className="t212-stat"><span>投入成本</span><strong>{format(current.investments.cost)}</strong></div>
      </div>
      {(current.changes.today && !current.changes.today.flowAdjusted) && <p className="ios-section-footer">资金流水暂时读取失败，今日盈亏未扣除入金 / 出金。</p>}

      <section className="ios-section">
        <div className="ios-section-header"><h2>持仓</h2><span className="caption">{current.positions.length} 只 · 按市值</span></div>
        <div className="ios-list">
          {current.positions.map(position => {
            const pct = position.cost ? position.pnl / position.cost * 100 : 0;
            const direction = position.pnl > 0 ? 'gain' : position.pnl < 0 ? 'loss' : 'flat';
            return <div className="ios-row t212-position" key={position.ticker}>
              <span className="ios-row-body">
                <strong>{position.name}</strong>
                <small>{position.ticker.replace(/(_[A-Z]{2})?_EQ$/, '').replace(/l$/, '')} · {position.quantity.toLocaleString('zh-CN', { maximumFractionDigits: 4 })} 股 · 均价 {position.averagePrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</small>
                <span className="t212-weight" aria-hidden="true"><span style={{ width: `${Math.max(2, position.value / total * 100)}%` }} /></span>
                {tradable && <span className="t212-row-actions">
                  <button type="button" className="t212-row-action buy" aria-label={`买入 ${position.name}`} onClick={() => setOrderSheet({ ticker: position.ticker, side: 'buy' })}><i aria-hidden="true" />买入</button>
                  <button type="button" className="t212-row-action sell" aria-label={`卖出 ${position.name}`} onClick={() => setOrderSheet({ ticker: position.ticker, side: 'sell' })}><i aria-hidden="true" />卖出</button>
                </span>}
              </span>
              <span className="t212-position-figures">
                <strong>{format(position.value)}</strong>
                <span className={`t212-delta ${direction}`}>{direction === 'gain' ? <ArrowUpRight size={14} className="t212-mark" aria-hidden="true" /> : direction === 'loss' ? <ArrowDownRight size={14} className="t212-mark" aria-hidden="true" /> : null}{signed(format, position.pnl)}（{pct >= 0 ? '+' : '−'}{Math.abs(pct).toFixed(1)}%）</span>
                <small>占比 {(position.value / total * 100).toFixed(1)}%</small>
              </span>
            </div>;
          })}
          {!current.positions.length && <div className="ios-row no-icon"><span className="ios-row-body"><small>当前没有持仓</small></span></div>}
        </div>
      </section>

      {activity.length > 0 && <section className="ios-section">
        <div className="ios-section-header"><h2>最近成交与分红</h2></div>
        <div className="ios-list">
          {activity.map(item => <div className="ios-row" key={`${item.kind}-${item.id}`}>
            <span className={`t212-kind ${item.kind}`}>{item.kind === 'buy' ? '买入' : item.kind === 'sell' ? '卖出' : '分红'}</span>
            <span className="ios-row-body"><strong>{item.name || item.ticker}</strong>
              <small>{item.at ? new Date(item.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}{item.quantity ? ` · ${item.quantity} 股` : ''}{item.price !== null ? ` · ${item.price}` : ''}</small></span>
            <span className="t212-position-figures">
              {item.value !== null && <strong>{format(Math.abs(item.value))}</strong>}
              {item.realized !== null && <small>实现 {signed(format, item.realized)}</small>}
            </span>
          </div>)}
        </div>
      </section>}
      <p className="ios-section-footer">数据来自 Trading 212 公共 API（Beta），{new Date(current.fetchedAt).toLocaleTimeString('zh-CN')} 更新。{tradable && trading
        ? `每笔订单都要经过面容 ID / 触控 ID 或二次确认，单笔上限 ${format(trading.caps.envs[env].maxOrderValue)}，今日还可买入 ${format(trading.caps.envs[env].dailyRemaining)}（每日买入上限 ${format(trading.caps.envs[env].dailyLimit)}）。`
        : '当前账户只读，不会下单或修改账户。'}</p>
    </>}

    {orderSheet && trading && current && <StudioT212OrderSheet env={env} config={trading} positions={current.positions} format={format}
      initialTicker={orderSheet.ticker} initialSide={orderSheet.side}
      onClose={() => setOrderSheet(null)} onPlaced={() => { void load(env); void reloadTrading(); }} onTradingChange={reloadTrading} />}
  </div>;
}
