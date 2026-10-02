import { useCallback, useEffect, useState } from 'react';
import { Globe, ScanFace, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { T212Env, T212Passkey, T212TradingConfig } from '@/shared/types';
import { StudioT212CapsEditor } from '@/modules/studio/StudioT212Caps';
import { StudioT212PasskeyEnroll, StudioT212RemovePasskeySheet } from '@/modules/studio/StudioT212Passkeys';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function environments(envs: T212Env[]) {
  if (envs.includes('live') && envs.includes('demo')) return '实盘 + 模拟盘';
  if (envs.includes('live')) return '仅实盘';
  if (envs.includes('demo')) return '仅模拟盘';
  return '已关闭';
}
function day(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/**
 * Used by StudioConnections (Settings) for Trading 212 order safety: which accounts may trade, Face ID / Touch ID
 * passkeys per domain, and the per-order and daily caps per account (lowered freely, raised only with Face ID).
 * Without any passkey every order needs a double confirmation; once one exists, each domain must enable its own
 * before it can trade. Passkey changes ask for the password.
 */
export function StudioSettingsTrading() {
  // Server order-safety settings and this user's passkeys; null while loading.
  const [config, setConfig] = useState<T212TradingConfig | null>(null);
  // Load failure (for example an older server without trading routes) shown in place of the rows.
  const [loadError, setLoadError] = useState('');
  // The passkey whose removal alert (with its password or passkey step-up) is open.
  const [removing, setRemoving] = useState<T212Passkey | null>(null);

  // Re-read after registering or removing a passkey, or after saving caps.
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
  const trusted = Boolean(config && (config.trustedOrigins.includes(window.location.origin)
    || (config.allowLocalhost && window.location.protocol === 'http:' && LOCAL_HOSTNAMES.includes(host))));
  const enabledHere = Boolean(config?.passkeys.some(item => item.rpId === host));
  // Once a passkey exists anywhere (or the server requires one), this domain trades only after enabling its own.
  const blockedHere = Boolean(config && !enabledHere && (config.requirePasskey || config.passkeys.length > 0));
  // This domain first, then the others alphabetically.
  const passkeys = [...(config?.passkeys ?? [])].sort((a, b) => Number(b.rpId === host) - Number(a.rpId === host) || a.rpId.localeCompare(b.rpId));

  return <section className="ios-section" aria-labelledby="studio-trading-safety-heading">
    <div className="ios-section-header"><h2 id="studio-trading-safety-heading">交易安全</h2><span className="caption">Trading 212 下单</span></div>
    <div className="ios-list">
      {!config && !loadError && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
      {loadError && <div className="ios-row no-icon"><span className="ios-row-body"><small>{loadError}</small></span></div>}
      {config && <>
        <div className="ios-row no-icon">
          <span className="ios-row-body"><strong>允许下单的账户</strong><small>STUDIO_T212_TRADING</small></span>
          <span className={`status-badge ${config.allowedEnvs.includes('live') ? 'warn' : config.allowedEnvs.length ? 'good' : ''}`}>{environments(config.allowedEnvs)}</span>
        </div>
        <div className="ios-row no-icon">
          <span className="ios-row-body"><strong>当前网址</strong><small className="mono">{window.location.origin}</small></span>
          <span className={`status-badge ${trusted && !blockedHere ? 'good' : 'warn'}`}>{!trusted ? '未列入白名单' : blockedHere ? '需先启用面容 ID' : '可下单'}</span>
        </div>
      </>}
    </div>
    {config && <StudioT212PasskeyEnroll again={enabledHere} disabled={!trusted} onEnrolled={reload} />}
    {config && !trusted && <p className="ios-section-footer">当前网址不在服务器的下单白名单里：在服务器 .env 把 STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN 设为这个地址后重启 Studio。</p>}
    {config && trusted && blockedHere && <p className="ios-section-footer">
      {config.requirePasskey ? '服务器已关闭二次确认（STUDIO_T212_REQUIRE_PASSKEY=1）' : '你已在其他网址启用了面容 ID / 触控 ID'}，这个网址要先启用自己的通行密钥才能下单。
    </p>}

    {passkeys.length > 0 && <div className="ios-list t212-passkey-list" role="group" aria-label="已启用通行密钥的网址">
      {passkeys.map(passkey => <div className="ios-row" key={passkey.id}>
        <span className="home-icon small tone-slate" aria-hidden="true">{passkey.rpId === host ? <ScanFace size={18} strokeWidth={1.6} /> : <Globe size={18} strokeWidth={1.6} />}</span>
        <span className="ios-row-body">
          <strong>{passkey.rpId}{passkey.rpId === host && <span className="t212-passkey-current">当前</span>}</strong>
          <small>{passkey.label ?? '设备'} · {day(passkey.createdAt)} 启用{passkey.lastUsedAt ? ` · ${day(passkey.lastUsedAt)} 用过` : ''}</small>
        </span>
        <button type="button" className="icon-button danger" aria-label={`移除 ${passkey.rpId} 的通行密钥`} onClick={() => setRemoving(passkey)}>
          <Trash2 size={18} aria-hidden="true" />
        </button>
      </div>)}
    </div>}
    <p className="ios-section-footer t212-settings-note">
      还没有任何通行密钥时，每笔订单都需要二次确认；一旦在某个网址启用了面容 ID / 触控 ID，其他网址也要先启用自己的才能下单。
      通行密钥按网址区分：studio.ajarche.com 和 Tailscale 地址需要分别启用。启用或移除都要输入 Studio 登录密码，在通行密钥自己的网址也可以用它授权移除。
      {config && !config.allowedEnvs.length && <> 下单目前关闭：在服务器 .env 设置 <code>STUDIO_T212_TRADING=demo</code>、<code>live</code> 或 <code>both</code>，然后重启 Studio。</>}
    </p>

    {config && <StudioT212CapsEditor config={config} trusted={trusted} onSaved={reload} />}

    {removing && <StudioT212RemovePasskeySheet passkey={removing} onCancel={() => setRemoving(null)}
      onRemoved={() => { setRemoving(null); void reload(); }} />}
  </section>;
}
