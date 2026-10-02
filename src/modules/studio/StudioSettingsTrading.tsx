import { useCallback, useEffect, useState } from 'react';
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { Globe, ScanFace, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api, readApiJson } from '@/shared/api';
import type { T212Env, T212Passkey, T212TradingConfig } from '@/shared/types';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

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
function day(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}
// WebAuthn errors carry DOMException-style names; their raw messages are English and technical.
function passkeyError(reason: unknown) {
  const name = reason instanceof Error ? reason.name : '';
  if (name === 'NotAllowedError') return '已取消，或设备没有完成面容 ID / 触控 ID 验证';
  if (name === 'InvalidStateError') return '这台设备已经为当前网址启用过了';
  if (name === 'SecurityError') return '当前网址不能创建通行密钥：需要 HTTPS 域名或 localhost';
  return reason instanceof Error && reason.message ? reason.message : '启用失败';
}

/**
 * Used by StudioConnections (Settings) for Trading 212 order safety: which accounts may trade, the per-order
 * cap, and Face ID / Touch ID passkeys per domain. Without a passkey for a domain every order there needs a
 * double confirmation instead.
 */
export function StudioSettingsTrading() {
  // Server order-safety settings and this user's passkeys; null while loading.
  const [config, setConfig] = useState<T212TradingConfig | null>(null);
  // Load failure (for example an older server without trading routes) shown in place of the rows.
  const [loadError, setLoadError] = useState('');
  // The action in flight: 'register' for this domain, or the id of the passkey being removed.
  const [busy, setBusy] = useState<string | null>(null);
  // Error of the last passkey action, kept visible until the next one.
  const [actionError, setActionError] = useState('');
  // The passkey waiting for the removal alert.
  const [removing, setRemoving] = useState<T212Passkey | null>(null);
  // Whether this browser offers a platform authenticator (Face ID / Touch ID / Windows Hello); null until checked.
  const [platform, setPlatform] = useState<boolean | null>(() => (browserSupportsWebAuthn() ? null : false));

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
  useEffect(() => {
    if (platform !== null) return;
    let active = true;
    void platformAuthenticatorIsAvailable().then(value => { if (active) setPlatform(value); }).catch(() => { if (active) setPlatform(false); });
    return () => { active = false; };
  }, [platform]);

  const host = window.location.hostname;
  const trusted = Boolean(config && (config.trustedOrigins.includes(window.location.origin)
    || (config.allowLocalhost && window.location.protocol === 'http:' && LOCAL_HOSTNAMES.includes(host))));
  const enabledHere = Boolean(config?.passkeys.some(item => item.rpId === host));
  // This domain first, then the others alphabetically.
  const passkeys = [...(config?.passkeys ?? [])].sort((a, b) => Number(b.rpId === host) - Number(a.rpId === host) || a.rpId.localeCompare(b.rpId));
  const unavailable = !trusted ? '当前网址不在服务器的下单白名单里' : platform === false ? '这个浏览器或设备不支持面容 ID / 触控 ID' : '';

  const enable = async () => {
    setBusy('register'); setActionError('');
    try {
      const options = await readApiJson<PublicKeyCredentialCreationOptionsJSON>(await api.studio.t212Trading.passkeyOptions());
      const response = await startRegistration({ optionsJSON: options });
      await readApiJson(await api.studio.t212Trading.registerPasskey(response));
      await reload();
      toast.success(`已在 ${host} 启用面容 ID / 触控 ID 下单`);
    } catch (reason) { setActionError(passkeyError(reason)); }
    finally { setBusy(null); }
  };
  const remove = async (passkey: T212Passkey) => {
    setBusy(passkey.id); setActionError('');
    try {
      await readApiJson(await api.studio.t212Trading.removePasskey(passkey.id));
      await reload();
      toast.success(`已移除 ${passkey.rpId} 的通行密钥`);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : '移除失败'); }
    finally { setBusy(null); }
  };

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
          <span className="ios-row-body"><strong>单笔上限</strong><small>STUDIO_T212_MAX_ORDER_VALUE · 超过的订单由服务器拒绝</small></span>
          <span className="t212-settings-value">{money(config.maxOrderValue, config.currency)}</span>
        </div>
        <div className="ios-row no-icon">
          <span className="ios-row-body"><strong>当前网址</strong><small className="mono">{window.location.origin}</small></span>
          <span className={`status-badge ${trusted ? 'good' : 'warn'}`}>{trusted ? '可下单' : '未列入白名单'}</span>
        </div>
        <button type="button" className="ios-row action left no-icon" disabled={busy !== null || Boolean(unavailable) || platform === null} onClick={() => void enable()}>
          {busy === 'register' ? <StudioSpinner size={16} /> : <ScanFace size={19} aria-hidden="true" />}
          {enabledHere ? '在这台设备上也启用面容 ID / 触控 ID' : '启用面容 ID / 触控 ID 下单'}
        </button>
      </>}
    </div>
    {config && unavailable && <p className="ios-section-footer">{unavailable}{trusted ? '。' : '：在服务器 .env 把 STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN 设为这个地址后重启 Studio。'}</p>}
    {actionError && <p className="studio-feedback error" role="alert">{actionError}</p>}

    {passkeys.length > 0 && <div className="ios-list t212-passkey-list" role="group" aria-label="已启用通行密钥的网址">
      {passkeys.map(passkey => <div className="ios-row" key={passkey.id}>
        <span className="home-icon small tone-slate" aria-hidden="true">{passkey.rpId === host ? <ScanFace size={18} strokeWidth={1.6} /> : <Globe size={18} strokeWidth={1.6} />}</span>
        <span className="ios-row-body">
          <strong>{passkey.rpId}{passkey.rpId === host && <span className="t212-passkey-current">当前</span>}</strong>
          <small>{passkey.label ?? '设备'} · {day(passkey.createdAt)} 启用{passkey.lastUsedAt ? ` · ${day(passkey.lastUsedAt)} 用过` : ''}</small>
        </span>
        <button type="button" className="icon-button danger" aria-label={`移除 ${passkey.rpId} 的通行密钥`} disabled={busy !== null} onClick={() => setRemoving(passkey)}>
          {busy === passkey.id ? <StudioSpinner size={16} /> : <Trash2 size={18} aria-hidden="true" />}
        </button>
      </div>)}
    </div>}
    <p className="ios-section-footer t212-settings-note">
      没有通行密钥的网址，每笔订单都需要二次确认。通行密钥按网址区分：studio.ajarche.com 和 Tailscale 地址需要分别启用。
      {config && !config.allowedEnvs.length && <> 下单目前关闭：在服务器 .env 设置 <code>STUDIO_T212_TRADING=demo</code>、<code>live</code> 或 <code>both</code>，可选 <code>STUDIO_T212_MAX_ORDER_VALUE</code>（默认 500），然后重启 Studio。</>}
    </p>

    {removing && <StudioConfirmSheet title={`移除 ${removing.rpId} 的通行密钥？`} message="移除后，在这个网址下单会改为二次确认。设备里保存的通行密钥可以在系统的「密码」设置里删除。" confirmLabel="移除"
      onCancel={() => setRemoving(null)}
      onConfirm={() => { const target = removing; setRemoving(null); void remove(target); }} />}
  </section>;
}
