import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { ScanFace } from 'lucide-react';
import { toast } from 'sonner';

import { api, readApiJson } from '@/shared/api';
import type { T212Passkey } from '@/shared/types';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

// Matches the alert's CSS exit animation in studio.css.
const EXIT_MS = 180;

function exitDelay() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS;
}
// WebAuthn errors carry DOMException-style names; their raw messages are English and technical.
function passkeyError(reason: unknown, fallback: string) {
  const name = reason instanceof Error ? reason.name : '';
  if (name === 'NotAllowedError') return '已取消，或设备没有完成面容 ID / 触控 ID 验证';
  if (name === 'InvalidStateError') return '这台设备已经为当前网址启用过了';
  if (name === 'SecurityError') return '当前网址不能使用通行密钥：需要 HTTPS 域名或 localhost';
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * Used by StudioSettingsTrading and StudioT212OrderSheet to enable Face ID / Touch ID for the current domain.
 * Adding a passkey needs a one-time enrollment code that the owner prints on the server as the order broker's OS
 * user; the broker checks it before issuing a registration challenge, so a Studio session alone cannot enrol one.
 */
export function StudioT212PasskeyEnroll({ again, disabled = false, onEnrolled }: {
  again: boolean; disabled?: boolean; onEnrolled: () => Promise<void> | void;
}) {
  // Enrollment code from `studio-trader enroll-code`; kept for a retry after a cancelled Face ID prompt (the broker
  // uses it up only when a passkey is stored), cleared on success.
  const [code, setCode] = useState('');
  // Registration in flight; locks the form and shows a spinner.
  const [busy, setBusy] = useState(false);
  // Last failure (wrong or expired code, cancelled prompt), kept until the next attempt.
  const [error, setError] = useState('');
  // Whether this browser offers a platform authenticator (Face ID / Touch ID / Windows Hello); null until checked.
  const [platform, setPlatform] = useState<boolean | null>(() => (browserSupportsWebAuthn() ? null : false));
  const fieldId = useId();

  useEffect(() => {
    if (platform !== null) return;
    let active = true;
    void platformAuthenticatorIsAvailable().then(value => { if (active) setPlatform(value); }).catch(() => { if (active) setPlatform(false); });
    return () => { active = false; };
  }, [platform]);

  const ready = !busy && !disabled && platform === true && code.trim().length > 0;
  const enroll = async () => {
    setBusy(true); setError('');
    try {
      const options = await readApiJson<PublicKeyCredentialCreationOptionsJSON>(await api.studio.t212Trading.passkeyOptions(code.trim()));
      const response = await startRegistration({ optionsJSON: options });
      await readApiJson(await api.studio.t212Trading.registerPasskey(response));
      setCode('');
      toast.success(`已在 ${window.location.hostname} 启用面容 ID / 触控 ID 下单`);
      await onEnrolled();
    } catch (reason) { setError(passkeyError(reason, '启用失败')); }
    finally { setBusy(false); }
  };

  return <>
    <form className="ios-list t212-enroll" aria-label="启用面容 ID / 触控 ID" onSubmit={event => { event.preventDefault(); if (ready) void enroll(); }}>
      <div className="ios-field">
        <label htmlFor={fieldId}>注册码</label>
        <input id={fieldId} type="text" autoComplete="one-time-code" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
          value={code} onChange={event => setCode(event.target.value)} disabled={busy || disabled || platform === false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" />
      </div>
      <button type="submit" className="ios-row action left no-icon" disabled={!ready}>
        {busy ? <StudioSpinner size={16} /> : <ScanFace size={19} aria-hidden="true" />}
        {again ? '在这台设备上也启用面容 ID / 触控 ID' : '启用面容 ID / 触控 ID 下单'}
      </button>
    </form>
    <p className="ios-section-footer">注册码在 Windows 上生成：<code>wsl.exe -d Ubuntu -u studio-trader -e /opt/studio-trader/bin/studio-trader enroll-code</code>，10 分钟内有效，只能登记一把通行密钥。</p>
    {platform === false && <p className="ios-section-footer">这个浏览器或设备不支持面容 ID / 触控 ID</p>}
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
  </>;
}

/**
 * Used by StudioSettingsTrading to remove a passkey. The order broker needs a Face ID / Touch ID assertion from any
 * passkey of the current domain (so a lost device can be removed from another one) or a fresh enrollment code.
 */
export function StudioT212RemovePasskeySheet({ passkey, canUsePasskey, onRemoved, onCancel }: {
  passkey: T212Passkey; canUsePasskey: boolean; onRemoved: () => void; onCancel: () => void;
}) {
  // Enrollment code typed into the alert, for removing without a passkey of this domain.
  const [code, setCode] = useState('');
  // The step-up in flight: the enrollment code, or a Face ID / Touch ID check with this domain's passkey.
  const [busy, setBusy] = useState<'code' | 'passkey' | null>(null);
  // Failure of the last attempt (wrong code, cancelled prompt), shown inside the alert.
  const [error, setError] = useState('');
  // The exit animation runs before the chosen callback unmounts the alert.
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Any passkey of this domain can authorise the removal, in a browser with WebAuthn.
  const viaPasskey = canUsePasskey && browserSupportsWebAuthn();

  useEffect(() => {
    // Focus starts in the code field and returns to the trigger afterwards.
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const finish = (callback: () => void) => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(callback, exitDelay());
  };
  const cancel = () => { if (busy === null) finish(onCancel); };
  const remove = async (method: 'code' | 'passkey') => {
    setBusy(method); setError('');
    try {
      const proof = method === 'code'
        ? { enrollmentCode: code.trim() }
        : { assertion: await startAuthentication({ optionsJSON: await readApiJson<PublicKeyCredentialRequestOptionsJSON>(await api.studio.t212Trading.removalOptions(passkey.id)) }) };
      await readApiJson(await api.studio.t212Trading.removePasskey(passkey.id, proof));
      toast.success(`已移除 ${passkey.rpId} 的通行密钥`);
      finish(onRemoved);
    } catch (reason) { setError(passkeyError(reason, '移除失败')); }
    finally { setBusy(null); }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (event.key !== 'Tab' || !panel.current) return;
    // Keep keyboard focus inside the alert.
    const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return createPortal(
    <div className={`studio-layer ${closing ? 'closing' : ''}`} onKeyDown={onKeyDown}>
      <div className="sheet-scrim" aria-hidden="true" onClick={cancel} />
      <form ref={panel} className="sheet-panel t212-stepup" role="alertdialog" aria-modal="true" aria-labelledby="t212-remove-title" aria-describedby="t212-remove-message"
        onSubmit={event => { event.preventDefault(); if (code.trim() && busy === null) void remove('code'); }}>
        <div className="sheet-text">
          <h2 id="t212-remove-title">{`移除 ${passkey.rpId} 的通行密钥？`}</h2>
          <p id="t212-remove-message">
            {viaPasskey ? '用这个网址的面容 ID / 触控 ID 验证，或输入服务器上生成的注册码。' : '输入服务器上生成的注册码（studio-trader enroll-code）确认。'}
            移除后要重新启用，才能在这个网址用面容 ID / 触控 ID 下单；设备里保存的通行密钥可以在系统的「密码」设置里删除。
          </p>
        </div>
        <div className="t212-stepup-field">
          <input ref={input} type="text" aria-label="注册码" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autoComplete="one-time-code"
            autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} disabled={busy !== null} />
          {error && <p className="t212-stepup-error" role="alert">{error}</p>}
        </div>
        {viaPasskey && <button type="button" className="sheet-action t212-stepup-passkey" disabled={busy !== null} onClick={() => void remove('passkey')}>
          {busy === 'passkey' ? <StudioSpinner size={16} /> : <ScanFace size={18} aria-hidden="true" />}用面容 ID / 触控 ID 验证
        </button>}
        <div className="sheet-actions">
          <button type="button" className="sheet-action" disabled={busy !== null} onClick={cancel}>取消</button>
          <button type="submit" className="sheet-action destructive" disabled={!code.trim() || busy !== null}>
            {busy === 'code' && <StudioSpinner size={16} />}移除
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
