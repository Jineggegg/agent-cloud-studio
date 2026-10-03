import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { toast } from 'sonner';

import { IconFaceId, IconLock, IconLogout, IconTrash, IconWorld } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { StudioPasswordLock, StudioRevokeAllResult, StudioSecurityEvent, StudioSecurityOverview, StudioSignInPasskey } from '@/shared/types';
import { useAuth } from '@/modules/auth';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-security.css';

// Matches the alert's CSS exit animation in studio.css.
const EXIT_MS = 180;
// Events shown before "显示全部".
const COLLAPSED_EVENTS = 6;

const EVENT_LABELS: Record<string, string> = {
  'login-failed': '密码登录失败',
  'login-succeeded': '密码登录',
  'account-locked': '密码登录已锁定',
  'lockout-cleared': '密码锁定已解除',
  'passkey-signin': '面容 ID 登录',
  'tailscale-signin': 'Tailscale 登录',
  'handoff-signin': '切换入口登录',
  'passkey-signin-failed': '面容 ID 登录失败',
  'passkey-added': '添加了登录通行密钥',
  'passkey-removed': '移除了登录通行密钥',
  'sessions-revoked': '退出了所有设备',
  'api-keys-revoked': '停用了 API 密钥',
  'push-subscribed': '新的推送订阅',
  'step-up-failed': '设置里输错了密码',
};
const DOOR_LABELS: Record<string, string> = { cloudflare: '公网', tailnet: 'Tailscale', direct: '本机 / 局域网' };
// The server logs short machine words; these are the ones worth translating.
const FAILURE_LABELS: Record<string, string> = {
  'credential-unknown': '未登记的通行密钥',
  'challenge-unknown': '验证已过期',
  'verification-failed': '设备验证未通过',
  'user-mismatch': '通行密钥不属于这个账户',
  'user-missing': '账户不存在',
  malformed: '数据无效',
};
// What lifted a password lock (lockout-cleared events, "<method> · <which lock>").
const UNLOCK_LABELS: Record<string, string> = {
  password: '由密码登录解除',
  passkey: '由面容 ID 登录解除',
  Tailscale: '由 Tailscale 登录解除',
  'step-up': '由设置里的密码确认解除',
  'command line': '由本机命令解除',
};
// The password locks, one per door; the session one only shows while it holds.
const LOCK_ROWS: { key: keyof StudioSecurityOverview['passwordLocks']; title: string; hint: string }[] = [
  { key: 'public', title: '公网密码登录', hint: '连续输错 5 次锁定，只影响 studio.ajarche.com 的密码登录' },
  { key: 'tailnet', title: 'Tailscale 密码登录', hint: '和公网分开计数，公网被猜密码时这里照常' },
  { key: 'session', title: '设置里的密码确认', hint: '已登录后再次输入密码（添加通行密钥、API 密钥、切换入口）' },
];

function exitDelay() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS;
}
function day(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}
function moment(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// "· 12 次" when one row stands for repeated sign-ins of the same session or device.
function eventLine(event: StudioSecurityEvent) {
  return [moment(event.at), DOOR_LABELS[event.door] ?? event.door, event.client !== 'unknown' ? event.client : '', eventDetail(event),
    (event.repeats ?? 1) > 1 ? `${event.repeats} 次` : ''].filter(Boolean).join(' · ');
}

function eventDetail(event: StudioSecurityEvent) {
  const detail = event.detail ?? '';
  // The method of a successful password login is already in its title.
  if (event.type === 'login-succeeded') return '';
  if (event.type === 'lockout-cleared') {
    const [method, ...rest] = detail.split(' · ');
    return [UNLOCK_LABELS[method] ?? method, ...rest].join(' · ');
  }
  if (detail.startsWith('wrong-password')) return '密码错误';
  if (detail.startsWith('unknown-user')) return '用户名不存在';
  return FAILURE_LABELS[detail] ?? detail;
}
// "已退出所有设备：停用 2 个 API 密钥、断开 3 个连接" — only what was actually revoked.
function revocationSummary(result: StudioRevokeAllResult | null) {
  const revoked = result?.revoked;
  const parts = [
    revoked?.apiKeys ? `停用 ${revoked.apiKeys} 个 API 密钥` : '',
    revoked?.webSockets ? `断开 ${revoked.webSockets} 个连接` : '',
    revoked?.snrAccess ? '关闭 SNR 研究入口' : '',
    revoked?.pushSubscriptions ? `移除 ${revoked.pushSubscriptions} 个推送订阅` : '',
  ].filter(Boolean);
  return parts.length ? `已退出所有设备：${parts.join('、')}。请重新登录` : '已退出所有设备，请重新登录';
}

function lockText(lock: StudioPasswordLock, hint: string) {
  return lock.locked && lock.lockedUntil ? `错误次数过多，${moment(lock.lockedUntil)} 前不能用密码` : hint;
}

// WebAuthn errors carry DOMException-style names; their raw messages are English and technical.
function passkeyError(reason: unknown, fallback: string) {
  const name = reason instanceof Error ? reason.name : '';
  if (name === 'NotAllowedError') return '已取消，或设备没有完成面容 ID / 触控 ID 验证';
  if (name === 'InvalidStateError') return '这台设备已经为当前网址启用过了';
  if (name === 'SecurityError') return '当前网址不能使用通行密钥：需要 HTTPS 域名';
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

// Removal alert: the Studio password is the step-up for taking a sign-in passkey away.
function RemoveSignInPasskeySheet({ passkey, onRemoved, onCancel }: {
  passkey: StudioSignInPasskey; onRemoved: () => void; onCancel: () => void;
}) {
  // Studio login password typed into the alert.
  const [password, setPassword] = useState('');
  // The removal request is in flight; locks the alert.
  const [busy, setBusy] = useState(false);
  // Failure of the last attempt (wrong password, locked), shown inside the alert.
  const [error, setError] = useState('');
  // The exit animation runs before the chosen callback unmounts the alert.
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus starts in the password field and returns to the trigger afterwards.
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const finish = (callback: () => void) => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(callback, exitDelay());
  };
  const cancel = () => { if (!busy) finish(onCancel); };
  const remove = async () => {
    setBusy(true); setError('');
    try {
      await readApiJson(await api.auth.security.removePasskey(passkey.id, password));
      toast.success(`已移除 ${passkey.rpId} 的登录通行密钥`);
      finish(onRemoved);
    } catch (reason) { setError(reason instanceof Error && reason.message ? reason.message : '移除失败'); }
    finally { setBusy(false); }
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
      <form ref={panel} className="sheet-panel security-stepup" role="alertdialog" aria-modal="true"
        aria-labelledby="security-remove-title" aria-describedby="security-remove-message"
        onSubmit={event => { event.preventDefault(); if (password && !busy) void remove(); }}>
        <div className="sheet-text">
          <h2 id="security-remove-title">{`移除 ${passkey.rpId} 的登录通行密钥？`}</h2>
          <p id="security-remove-message">
            输入 Studio 登录密码确认。移除后这个网址不能再用面容 ID 登录；设备里保存的通行密钥可以在系统的「密码」设置里删除。
          </p>
        </div>
        <div className="security-stepup-field">
          <input ref={input} type="password" aria-label="登录密码" placeholder="Studio 登录密码" autoComplete="current-password"
            autoCapitalize="off" autoCorrect="off" spellCheck={false} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
          {error && <p className="security-stepup-error" role="alert">{error}</p>}
        </div>
        <div className="sheet-actions">
          <button type="button" className="sheet-action" disabled={busy} onClick={cancel}>取消</button>
          <button type="submit" className="sheet-action destructive" disabled={!password || busy}>
            {busy && <StudioSpinner size={16} />}移除
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/**
 * Used by StudioConnections (Settings) for the account's own security: the password lock state,
 * "用面容 ID 登录" passkeys per domain (adding and removing both need the Studio password), the
 * server's recent security events, and "退出所有设备", which revokes every session (this one
 * included) and signs this page out.
 */
export function StudioSettingsSecurity() {
  const { logout } = useAuth();
  // Passkeys, events and the lock state from the server; null while loading.
  const [overview, setOverview] = useState<StudioSecurityOverview | null>(null);
  // Load failure shown in place of the rows.
  const [loadError, setLoadError] = useState('');
  // Studio password for the step-up before a new passkey; cleared once it is enrolled.
  const [password, setPassword] = useState('');
  // Which action is in flight; locks the controls it affects.
  const [busy, setBusy] = useState<'enroll' | 'revoke' | null>(null);
  // Failure of the last enrolment (wrong password, cancelled prompt), until the next attempt.
  const [enrollError, setEnrollError] = useState('');
  // The passkey whose removal alert is open.
  const [removing, setRemoving] = useState<StudioSignInPasskey | null>(null);
  // The "退出所有设备" confirmation is open.
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  // The event list shows the newest few until expanded.
  const [showAllEvents, setShowAllEvents] = useState(false);
  const passwordFieldId = useId();

  // Re-read after adding or removing a passkey, so the list and the event log agree with the server.
  const reload = useCallback(async () => {
    try { setOverview(await readApiJson<StudioSecurityOverview>(await api.auth.security.overview())); setLoadError(''); }
    catch (reason) { setLoadError(reason instanceof Error ? reason.message : '安全设置读取失败'); }
  }, []);
  useEffect(() => {
    let active = true;
    void api.auth.security.overview().then(readApiJson<StudioSecurityOverview>)
      .then(value => { if (active) setOverview(value); })
      .catch((reason: unknown) => { if (active) setLoadError(reason instanceof Error ? reason.message : '安全设置读取失败'); });
    return () => { active = false; };
  }, []);

  const host = window.location.hostname;
  const supported = browserSupportsWebAuthn();
  const originAllowed = Boolean(overview?.passkeyOrigins.includes(window.location.origin));
  const enabledHere = Boolean(overview?.passkeys.some(item => item.rpId === host));
  const canEnroll = supported && originAllowed && busy === null && password.length > 0;
  // This domain first, then the others alphabetically.
  const passkeys = [...(overview?.passkeys ?? [])].sort((a, b) => Number(b.rpId === host) - Number(a.rpId === host) || a.rpId.localeCompare(b.rpId));
  const events = overview?.events ?? [];
  const visibleEvents = showAllEvents ? events : events.slice(0, COLLAPSED_EVENTS);
  const importantEvents = overview?.importantEvents ?? [];
  const signIns = overview?.signIns ?? [];
  const lockRows = overview ? LOCK_ROWS.filter((row) => row.key !== 'session' || overview.passwordLocks.session.locked) : [];

  const enroll = async () => {
    setBusy('enroll'); setEnrollError('');
    try {
      const options = await readApiJson<PublicKeyCredentialCreationOptionsJSON>(await api.auth.security.passkeyOptions(password));
      const response = await startRegistration({ optionsJSON: options });
      await readApiJson(await api.auth.security.registerPasskey(response));
      setPassword('');
      toast.success(`已在 ${host} 启用面容 ID 登录`);
      await reload();
    } catch (reason) { setEnrollError(passkeyError(reason, '启用失败')); }
    finally { setBusy(null); }
  };
  const revokeAll = async () => {
    setBusy('revoke');
    try {
      const result = await readApiJson<StudioRevokeAllResult>(await api.auth.security.revokeAll());
      toast.success(revocationSummary(result));
      logout();
    } catch (reason) {
      toast.error(reason instanceof Error && reason.message ? reason.message : '操作失败');
      setBusy(null);
    }
  };

  return <section className="ios-section" aria-labelledby="studio-security-heading">
    <div className="ios-section-header"><h2 id="studio-security-heading">安全</h2><span className="caption">登录与会话</span></div>
    <div className="ios-list">
      {!overview && !loadError && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
      {loadError && <div className="ios-row no-icon"><span className="ios-row-body"><small>{loadError}</small></span></div>}
      {lockRows.map((row) => {
        const lock = overview?.passwordLocks[row.key];
        if (!lock) return null;
        return <div className="ios-row" key={row.key}>
          <span className="home-icon small tone-slate" aria-hidden="true"><IconLock size={18} strokeWidth={1.6} /></span>
          <span className="ios-row-body"><strong>{row.title}</strong><small>{lockText(lock, row.hint)}</small></span>
          <span className={`status-badge ${lock.locked ? 'warn' : 'good'}`}>{lock.locked ? '已锁定' : '正常'}</span>
        </div>;
      })}
    </div>

    {overview && <form className="ios-list security-enroll" aria-label="启用面容 ID 登录"
      onSubmit={event => { event.preventDefault(); if (canEnroll) void enroll(); }}>
      <div className="ios-field">
        <label htmlFor={passwordFieldId}>登录密码</label>
        <input id={passwordFieldId} type="password" autoComplete="current-password" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          value={password} onChange={event => setPassword(event.target.value)} disabled={busy !== null || !supported || !originAllowed} placeholder="Studio 登录密码" />
      </div>
      <button type="submit" className="ios-row action left no-icon" disabled={!canEnroll}>
        {busy === 'enroll' ? <StudioSpinner size={16} /> : <IconFaceId size={19} aria-hidden="true" />}
        {enabledHere ? '在这台设备上也启用面容 ID 登录' : '在这台设备启用面容 ID 登录'}
      </button>
    </form>}
    {enrollError && <p className="studio-feedback error" role="alert">{enrollError}</p>}
    {overview && !supported && <p className="ios-section-footer">这个浏览器不支持通行密钥（需要 HTTPS 和支持面容 ID / 触控 ID 的设备）。</p>}
    {overview && supported && !originAllowed && <p className="ios-section-footer">
      当前网址不是 Studio 配置的入口：在服务器 .env 把 STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN 设为这个地址后重启 Studio，才能在这里启用面容 ID 登录。
    </p>}

    {passkeys.length > 0 && <div className="ios-list security-passkey-list" role="group" aria-label="登录通行密钥">
      {passkeys.map(passkey => <div className="ios-row" key={passkey.id}>
        <span className="home-icon small tone-slate" aria-hidden="true">{passkey.rpId === host ? <IconFaceId size={18} strokeWidth={1.6} /> : <IconWorld size={18} strokeWidth={1.6} />}</span>
        <span className="ios-row-body">
          <strong>{passkey.rpId}{passkey.rpId === host && <span className="security-current">当前</span>}</strong>
          <small>{passkey.label ?? '设备'} · {day(passkey.createdAt)} 启用{passkey.lastUsedAt ? ` · ${day(passkey.lastUsedAt)} 用过` : ''}</small>
        </span>
        <button type="button" className="icon-button danger" aria-label={`移除 ${passkey.rpId} 的登录通行密钥`} onClick={() => setRemoving(passkey)}>
          <IconTrash size={18} aria-hidden="true" />
        </button>
      </div>)}
    </div>}
    <p className="ios-section-footer">
      通行密钥按网址区分：studio.ajarche.com 和 Tailscale 地址要分别启用。登录页的「用面容 ID 登录」不需要用户名和密码；密码被锁定时也能用它登录并解除锁定。
    </p>

    {importantEvents.length > 0 && <>
      <h3 className="security-subheading" id="studio-security-important-heading">重要事件</h3>
      <div className="ios-list" role="group" aria-labelledby="studio-security-important-heading">
        {importantEvents.map(event => <div className="ios-row no-icon security-event" key={event.id}>
          <span className="ios-row-body">
            <strong>{EVENT_LABELS[event.type] ?? event.type}</strong>
            <small>{eventLine(event)}</small>
          </span>
        </div>)}
      </div>
    </>}
    {signIns.length > 0 && <>
      <h3 className="security-subheading" id="studio-security-signins-heading">最近登录</h3>
      <div className="ios-list" role="group" aria-labelledby="studio-security-signins-heading">
        {signIns.map(event => <div className="ios-row no-icon security-event" key={event.id}>
          <span className="ios-row-body">
            <strong>{EVENT_LABELS[event.type] ?? event.type}</strong>
            <small>{eventLine(event)}</small>
          </span>
        </div>)}
      </div>
    </>}
    {overview && <h3 className="security-subheading" id="studio-security-events-heading">最近的安全事件</h3>}
    {overview && <div className="ios-list security-events" role="group" aria-labelledby="studio-security-events-heading">
      {events.length === 0 && <div className="ios-row no-icon"><span className="ios-row-body"><small>还没有安全事件</small></span></div>}
      {visibleEvents.map(event => <div className="ios-row no-icon security-event" key={event.id}>
        <span className="ios-row-body">
          <strong>{EVENT_LABELS[event.type] ?? event.type}</strong>
          <small>{eventLine(event)}</small>
        </span>
      </div>)}
      {events.length > COLLAPSED_EVENTS && <button type="button" className="ios-row action left no-icon" onClick={() => setShowAllEvents(value => !value)}>
        {showAllEvents ? '收起' : `显示全部 ${events.length} 条`}
      </button>}
    </div>}

    <div className="ios-list security-revoke">
      <button type="button" className="ios-row action left destructive no-icon" disabled={busy !== null} onClick={() => setConfirmRevoke(true)}>
        {busy === 'revoke' ? <StudioSpinner size={16} /> : <IconLogout size={18} aria-hidden="true" />}退出所有设备
      </button>
    </div>
    <p className="ios-section-footer">所有已登录的浏览器（包括这台）都会立即退出，正在运行的对话和终端连接会断开，API 密钥会被停用、SNR 研究入口会关闭、推送通知要在各设备上重新开启，之后需要重新登录。</p>

    {removing && <RemoveSignInPasskeySheet passkey={removing} onCancel={() => setRemoving(null)}
      onRemoved={() => { setRemoving(null); void reload(); }} />}
    {confirmRevoke && <StudioConfirmSheet title="退出所有设备？" message="所有已登录的浏览器（包括这台）都会退出，之后需要重新登录。" confirmLabel="退出所有设备"
      onCancel={() => setConfirmRevoke(false)}
      onConfirm={() => { setConfirmRevoke(false); void revokeAll(); }} />}
  </section>;
}
