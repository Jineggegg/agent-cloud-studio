import { useCallback, useEffect, useState } from 'react';
import { Globe, ScanFace, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { T212Env, T212Passkey, T212TradingConfig } from '@/shared/types';
import { StudioT212PasskeyEnroll, StudioT212RemovePasskeySheet } from '@/modules/studio/StudioT212Passkeys';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

const BROKER_BADGE = { ok: ['已连接', 'good'], off: ['未安装', ''], unreachable: ['无法连接', 'warn'] } as const;

function environments(envs: T212Env[]) {
  if (envs.includes('live') && envs.includes('demo')) return '实盘 + 模拟盘';
  if (envs.includes('live')) return '仅实盘';
  if (envs.includes('demo')) return '仅模拟盘';
  return '已关闭';
}
function money(value: number, currency: string | undefined) {
  if (!currency) return `${value.toLocaleString('zh-CN')}（账户货币）`;
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toLocaleString('zh-CN')} ${currency}`; }
}
// "实盘剩余 £1,840（已用 £160）· 模拟盘剩余 …" for the accounts the broker reports a daily budget for; '' when none.
function dailyBudgets(config: T212TradingConfig) {
  if (!(config.maxDailyOrderValue > 0)) return '';
  return (['live', 'demo'] as T212Env[]).flatMap(env => {
    const budget = config.dailyOrderValue?.[env];
    if (!budget || budget.remaining === null) return [];
    return [`${env === 'live' ? '实盘' : '模拟盘'}剩余 ${money(budget.remaining, budget.currency)}（已用 ${money(budget.used, budget.currency)}）`];
  }).join(' · ');
}
function day(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/**
 * Used by StudioConnections (Settings) for Trading 212 order safety. Orders are placed only by the separate order
 * broker (its own OS user and key); this shows whether Studio reaches it, the accounts and cap from its own config,
 * and its passkeys grouped by domain (RP ID). Each domain trades only with its own passkey; enrolling one needs an
 * enrollment code printed on the server, removing one a passkey of this domain or such a code.
 */
export function StudioSettingsTrading() {
  // Broker status, settings and passkeys; null while loading.
  const [config, setConfig] = useState<T212TradingConfig | null>(null);
  // Load failure (for example an older server without trading routes) shown in place of the rows.
  const [loadError, setLoadError] = useState('');
  // The passkey whose removal alert (with its code or passkey step-up) is open.
  const [removing, setRemoving] = useState<T212Passkey | null>(null);

  // Re-read after registering or removing a passkey.
  const reload = useCallback(async () => {
    try { setConfig(await readApiJson<T212TradingConfig>(await api.studio.t212Trading.config())); setLoadError(''); }
    catch (reason) { setLoadError(reason instanceof Error ? reason.message : '交易设置读取失败'); }
  }, []);
  useEffect(() => {
    let active = true;
    void api.studio.t212Trading.config().then(readApiJson<T212TradingConfig>)
      .then(value => { if (active) setConfig(value); })
      .catch((reason: unknown) => { if (active) setLoadError(reason instanceof Error ? reason.message : '交易设置读取失败'); });
    return () => { active = false; };
  }, []);

  const host = window.location.hostname;
  const connected = config?.broker.status === 'ok';
  const trusted = Boolean(config?.trustedOrigins.includes(window.location.origin));
  const enabledHere = Boolean(config?.passkeys.some(item => item.rpId === host));
  const keys = config?.broker.status === 'ok' ? config.broker.keys : null;
  const missingKeys = keys ? (config?.allowedEnvs ?? []).filter(env => !keys[env]) : [];
  // Passkeys grouped by domain: this domain first, then the others alphabetically.
  const domains = [...new Set((config?.passkeys ?? []).map(item => item.rpId))]
    .sort((a, b) => Number(b === host) - Number(a === host) || a.localeCompare(b));
  const [badge, tone] = config ? BROKER_BADGE[config.broker.status] : BROKER_BADGE.off;

  return <section className="ios-section" aria-labelledby="studio-trading-safety-heading">
    <div className="ios-section-header"><h2 id="studio-trading-safety-heading">交易安全</h2><span className="caption">Trading 212 下单</span></div>
    <div className="ios-list">
      {!config && !loadError && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
      {loadError && <div className="ios-row no-icon"><span className="ios-row-body"><small>{loadError}</small></span></div>}
      {config && <>
        <div className="ios-row no-icon">
          <span className="ios-row-body"><strong>交易代理</strong><small>{config.broker.status === 'ok' ? '独立系统用户 studio-trader · 下单密钥只在代理里' : config.broker.message}</small></span>
          <span className={`status-badge ${tone}`}>{badge}</span>
        </div>
        {connected && config.isolation && !config.isolation.ok && <div className="ios-row no-icon">
          <span className="ios-row-body"><strong>隔离无效</strong><small>{config.isolation.notes.join(' ') || 'Studio 的系统用户可能绕过交易代理读出下单密钥，交易代理暂时保护不了下单。'}</small></span>
          <span className="status-badge warn">隔离无效</span>
        </div>}
        {connected && <>
          <div className="ios-row no-icon">
            <span className="ios-row-body"><strong>允许下单的账户</strong><small>交易代理 config.json · allowedEnvs</small></span>
            <span className={`status-badge ${config.allowedEnvs.includes('live') ? 'warn' : config.allowedEnvs.length ? 'good' : ''}`}>{environments(config.allowedEnvs)}</span>
          </div>
          <div className="ios-row no-icon">
            <span className="ios-row-body"><strong>单笔上限</strong><small>超过的订单由交易代理拒绝 · 每小时最多 {config.maxOrdersPerHour} 笔{config.maxDailyOrderValue ? ` · 每个账户每日累计上限 ${money(config.maxDailyOrderValue, config.currency)}` : ''}{config.liveOrderCooldownSeconds ? ` · 实盘冷却 ${config.liveOrderCooldownSeconds} 秒` : ''}</small></span>
            <span className="t212-settings-value">{money(config.maxOrderValue, config.currency)}</span>
          </div>
          {dailyBudgets(config) && <div className="ios-row no-icon">
            <span className="ios-row-body"><strong>今日剩余额度</strong><small>{dailyBudgets(config)} · 滚动 24 小时，实盘和模拟盘分别计算</small></span>
          </div>}
          <div className="ios-row no-icon">
            <span className="ios-row-body"><strong>当前网址</strong><small className="mono">{window.location.origin}</small></span>
            <span className={`status-badge ${trusted && enabledHere ? 'good' : 'warn'}`}>{!trusted ? '未列入白名单' : enabledHere ? '可下单' : '需先启用面容 ID'}</span>
          </div>
        </>}
      </>}
    </div>
    {connected && <StudioT212PasskeyEnroll again={enabledHere} disabled={!trusted} onEnrolled={reload} />}
    {connected && !trusted && <p className="ios-section-footer">当前网址不在交易代理的白名单里：在服务器的 /var/lib/studio-trader/config.json 的 origins 里加入这个地址，然后重启交易代理。</p>}
    {connected && missingKeys.length > 0 && <p className="ios-section-footer">交易代理还没有{missingKeys.map(env => (env === 'live' ? '实盘' : '模拟盘')).join('、')}下单密钥：在服务器上运行 studio-trader set-key 写入。</p>}

    {domains.map(rpId => <div className="ios-list t212-passkey-list" role="group" aria-label={`${rpId} 的通行密钥`} key={rpId}>
      {(config?.passkeys ?? []).filter(item => item.rpId === rpId).map(passkey => <div className="ios-row" key={passkey.id}>
        <span className="home-icon small tone-slate" aria-hidden="true">{rpId === host ? <ScanFace size={18} strokeWidth={1.6} /> : <Globe size={18} strokeWidth={1.6} />}</span>
        <span className="ios-row-body">
          <strong>{rpId}{rpId === host && <span className="t212-passkey-current">当前</span>}</strong>
          <small>{passkey.credentialIdPrefix}… · {passkey.multiDevice ? '可同步' : '单设备'} · {day(passkey.createdAt)} 启用{passkey.lastUsedAt ? ` · ${day(passkey.lastUsedAt)} 用过` : ''}</small>
        </span>
        <button type="button" className="icon-button danger" aria-label={`移除 ${rpId} 的通行密钥（${passkey.label ?? '设备'}）`} onClick={() => setRemoving(passkey)}>
          <Trash2 size={18} aria-hidden="true" />
        </button>
      </div>)}
    </div>)}
    <p className="ios-section-footer t212-settings-note">
      下单由独立的交易代理完成：Studio 不持有下单密钥，交易代理只接受用这个网址的面容 ID / 触控 ID 确认的订单，自己核对金额和上限。
      通行密钥按网址区分，studio.ajarche.com 和 Tailscale 地址需要分别启用。启用需要服务器上生成的一次性注册码；移除需要这个网址的通行密钥或新的注册码。
      这里显示的设备名由浏览器提供，被入侵的 Studio 可以伪造，不能作为依据；要核对一把通行密钥确实是你自己的设备，请在服务器上运行 <code>studio-trader passkeys</code>，比对 AAGUID、凭据 ID 和登记时间。
      {config?.broker.status === 'off' && <> 安装方法见 <code>docs/t212-broker.md</code>，装好后在 Studio 的 .env 设置 <code>STUDIO_T212_BROKER_SOCKET=/run/studio-trader/broker.sock</code> 并重启 Studio。</>}
      {connected && !config.allowedEnvs.length && <> 下单目前关闭：在交易代理的 config.json 里设置 <code>allowedEnvs</code>（例如 <code>["demo"]</code>），然后重启交易代理。</>}
    </p>

    {removing && <StudioT212RemovePasskeySheet passkey={removing} canUsePasskey={enabledHere} onCancel={() => setRemoving(null)}
      onRemoved={() => { setRemoving(null); void reload(); }} />}
  </section>;
}
