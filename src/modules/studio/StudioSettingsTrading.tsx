import { useCallback, useEffect, useRef, useState } from 'react';

import { IconFaceId, IconFileText, IconTrash, IconWorld } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { T212Passkey, T212TradingConfig } from '@/shared/types';
import { StudioT212CapsEditor } from '@/modules/studio/StudioT212Caps';
import { StudioT212PasskeyEnroll, StudioT212RemovePasskeySheet } from '@/modules/studio/StudioT212Passkeys';
import { SettingsLinkRow } from '@/modules/studio/StudioSettingsRows';
import { StudioT212TradingModeSelector } from '@/modules/studio/StudioT212TradingMode';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
// The Trading 212 app links here (/apps/connections#t212-trading-safety) when an account is not enabled for orders.
const SECTION_ID = 't212-trading-safety';

/**
 * Used by StudioConnections (Settings → Trading 212) for order safety, controls and current state only: which
 * accounts may trade (a one-tap selector within STUDIO_T212_TRADING; adding an account needs Face ID), Face ID /
 * Touch ID passkeys per domain, and the per-order and daily caps per account (lowered freely, raised only with Face
 * ID). Without any passkey every order needs a double confirmation; once one exists, each domain must enable its own
 * before it can trade. Passkey changes ask for the password. Every record (changes, refusals, Face ID requests) is one
 * level further in, on 变更日志 (`onOpenLog`).
 */
export function StudioSettingsTrading({ onOpenLog }: { onOpenLog: () => void }) {
  // Server order-safety settings and this user's passkeys; null while loading.
  const [config, setConfig] = useState<T212TradingConfig | null>(null);
  // Load failure (for example an older server without trading routes) shown in place of the rows.
  const [loadError, setLoadError] = useState('');
  // The passkey whose removal alert (with its password or passkey step-up) is open.
  const [removing, setRemoving] = useState<T212Passkey | null>(null);
  const section = useRef<HTMLElement>(null);
  const loaded = config !== null;

  // Opened from the Trading 212 app's link: bring this section into view once its rows exist.
  useEffect(() => {
    if (!loaded || window.location.hash !== `#${SECTION_ID}`) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section.current?.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }, [loaded]);

  // Re-read after registering or removing a passkey, or after saving caps or the trading mode.
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

  return <>
    <section ref={section} id={SECTION_ID} className="ios-section" aria-labelledby="studio-trading-safety-heading">
      <div className="ios-section-header"><h2 id="studio-trading-safety-heading">交易安全</h2></div>
      {!config && <div className="ios-list">
        {!loadError && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
        {loadError && <div className="ios-row no-icon"><span className="ios-row-body"><small>{loadError}</small></span></div>}
      </div>}
      {config && <>
        <StudioT212TradingModeSelector config={config} trusted={trusted} onSaved={reload} />
        <div className="ios-list t212-origin">
          <div className="ios-row no-icon">
            <span className="ios-row-body"><strong>当前网址</strong><small className="mono">{window.location.origin}</small></span>
            <span className={`status-badge ${trusted && !blockedHere ? 'good' : 'warn'}`}>{!trusted ? '未列入白名单' : blockedHere ? '需先启用面容 ID' : '可下单'}</span>
          </div>
        </div>
        <StudioT212PasskeyEnroll again={enabledHere} disabled={!trusted} onEnrolled={reload} />
        {/* The one thing that cannot be fixed from this page, so it says where to fix it. */}
        {!trusted && <p className="ios-section-footer">当前网址不在服务器的下单白名单里：在服务器 .env 把 STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN 设为这个地址后重启 Studio。</p>}
      </>}

      {passkeys.length > 0 && <div className="ios-list t212-passkey-list" role="group" aria-label="已启用通行密钥的网址">
        {passkeys.map(passkey => <div className="ios-row" key={passkey.id}>
          <span className="home-icon small tone-slate" aria-hidden="true">{passkey.rpId === host ? <IconFaceId size={18} strokeWidth={1.6} /> : <IconWorld size={18} strokeWidth={1.6} />}</span>
          <span className="ios-row-body">
            <strong>{passkey.rpId}{passkey.rpId === host && <span className="t212-passkey-current">当前</span>}</strong>
            <small>{passkey.label ?? '设备'}</small>
          </span>
          <button type="button" className="icon-button danger" aria-label={`移除 ${passkey.rpId} 的通行密钥`} onClick={() => setRemoving(passkey)}>
            <IconTrash size={18} aria-hidden="true" />
          </button>
        </div>)}
      </div>}

      {config && <StudioT212CapsEditor config={config} trusted={trusted} onSaved={reload} />}

      {removing && <StudioT212RemovePasskeySheet passkey={removing} onCancel={() => setRemoving(null)}
        onRemoved={() => { setRemoving(null); void reload(); }} />}
    </section>
    {/* Records are rarely needed, so they are one level further in and read only when that page opens. */}
    <section className="ios-section" aria-label="记录">
      <div className="ios-list">
        <SettingsLinkRow icon={<IconFileText size={18} />} title="变更日志" onClick={onOpenLog} />
      </div>
    </section>
  </>;
}
