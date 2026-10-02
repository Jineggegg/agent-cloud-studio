import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { toast } from 'sonner';
import { Copy, ExternalLink, KeyRound, RotateCw, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { HubProject, StudioMailAccount, StudioMailAccounts, StudioMailDevicePoll, StudioMailDeviceStart, StudioMailProvider } from '@/shared/types';
import { readableErrorMessage } from '@/shared/utils';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-mail.css';

const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords';
const PROVIDER_LABELS: Record<StudioMailProvider, string> = {
  'gmail-imap': 'Gmail · 应用专用密码',
  outlook: 'Outlook · Microsoft 登录',
  'gmail-oauth': 'Gmail · Google OAuth',
};
const STATUS_BADGES: Record<StudioMailAccount['status'], { label: string; tone: string }> = {
  ok: { label: '正常', tone: 'good' },
  reauth: { label: '需重新验证', tone: 'warn' },
  error: { label: '读取出错', tone: 'warn' },
};
// Inline groups open with the same spring the rest of Studio uses; reduced motion is handled by MotionConfig.
const EXPAND = { initial: { height: 0, opacity: 0 }, animate: { height: 'auto', opacity: 1 }, exit: { height: 0, opacity: 0 } } as const;
// Per-tab memory of an Outlook sign-in in progress: iPadOS may reload Studio while the user is at Microsoft.
const DEVICE_STORAGE_KEY = 'studio-mail-outlook-device-v1';

function ProviderIcon({ provider }: { provider: StudioMailProvider }) {
  return <span className={`home-icon small ${provider === 'outlook' ? 'tone-slate' : 'tone-clay'}`} aria-hidden="true">
    <span className="mail-provider-mark">{provider === 'outlook' ? 'O' : 'G'}</span>
  </span>;
}

function expiryTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// The sign-in saved before a reload, if it is well formed and its code has not expired. The server still checks
// that the poll id belongs to the signed-in user.
function readStoredDevice(): StudioMailDeviceStart | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(DEVICE_STORAGE_KEY) ?? 'null') as Partial<StudioMailDeviceStart> | null;
    const valid = value && typeof value.pollId === 'string' && typeof value.userCode === 'string' && typeof value.expiresAt === 'string'
      && typeof value.interval === 'number' && typeof value.verificationUri === 'string' && new URL(value.verificationUri).protocol === 'https:'
      && Date.parse(value.expiresAt) > Date.now();
    if (valid) return value as StudioMailDeviceStart;
    sessionStorage.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // Unreadable or unavailable storage (private mode, blocked site data): start fresh.
  }
  return null;
}

function storeDevice(device: StudioMailDeviceStart | null) {
  try {
    if (device) sessionStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(device));
    else sessionStorage.removeItem(DEVICE_STORAGE_KEY);
  } catch {
    // Resuming after a reload is a convenience; without storage the sign-in still works in this page.
  }
}

// Safari on iPad treats a password field next to an email field as a sign-up form and fills in a generated
// "strong password" (and offers to save it). Where CSS can mask a text field, the App Password uses one instead.
function canMaskTextField() {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');
}

/**
 * Used by StudioConnections (Settings) as the 邮箱账户 section: adds Gmail with an App Password (verified by
 * the server before saving) and Outlook with a Microsoft device code, shows each account's status, re-verifies
 * paused accounts, removes them, and points to the projects whose 邮箱 tab shows the unified inbox.
 */
export function StudioSettingsMail() {
  // Accounts plus whether the server can offer Outlook sign-in; null until a load succeeds (unknown, not "unconfigured").
  const [data, setData] = useState<StudioMailAccounts | null>(null);
  // The account list could not be loaded (server or network).
  const [loadError, setLoadError] = useState('');
  // Projects with the 邮箱 module, to show where the inbox appears; null until loaded or when that request failed.
  const [projects, setProjects] = useState<HubProject[] | null>(null);
  // The inline Gmail form is expanded.
  const [gmailOpen, setGmailOpen] = useState(false);
  // Gmail address typed in the form.
  const [email, setEmail] = useState('');
  // App Password typed in the form; cleared as soon as it is saved or the form closes.
  const [password, setPassword] = useState('');
  // Gmail verification failure shown under the form, e.g. Google rejected the App Password.
  const [gmailError, setGmailError] = useState('');
  // The request in flight, which locks the other account controls.
  const [busy, setBusy] = useState<'gmail' | 'outlook' | 'remove' | null>(null);
  // The Outlook code shown while the server waits for the Microsoft sign-in; null when none runs. Restored after a reload.
  const [device, setDevice] = useState<StudioMailDeviceStart | null>(readStoredDevice);
  // Outlook sign-in could not start or ended without connecting.
  const [outlookError, setOutlookError] = useState('');
  // The account waiting for the remove confirmation.
  const [pendingRemove, setPendingRemove] = useState<StudioMailAccount | null>(null);

  const load = useCallback(() => api.studio.mail.accounts().then(readApiJson<StudioMailAccounts>).then(
    value => { setData(value); setLoadError(''); },
    // The previous list (if any) stays; nothing is guessed about the server's Outlook configuration.
    reason => setLoadError(readableErrorMessage(reason, '邮箱账户读取失败')),
  ), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    void api.studio.projects.list().then(readApiJson<HubProject[]>)
      .then(value => { if (active) setProjects(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => { storeDevice(device); }, [device]);

  // Polls at the server's interval until Microsoft answers. Coming back from the Microsoft page checks at once;
  // the server still decides when Microsoft is actually asked.
  useEffect(() => {
    if (!device) return;
    let active = true;
    let polling = false;
    let timer = 0;
    const poll = async () => {
      if (polling) return;
      polling = true;
      window.clearTimeout(timer);
      try {
        const result = await readApiJson<StudioMailDevicePoll>(await api.studio.mail.pollOutlook(device.pollId));
        if (!active) return;
        if (result.status === 'pending') { timer = window.setTimeout(() => void poll(), device.interval * 1000); return; }
        setDevice(null);
        if (result.status === 'connected') {
          toast.success(`已连接 ${result.account?.email ?? 'Outlook'}`);
          void load();
        } else {
          setOutlookError(result.message ?? (result.status === 'expired' ? '代码已过期，请重新添加 Outlook' : 'Outlook 登录失败，请重试'));
        }
      } catch (reason) {
        if (!active) return;
        setDevice(null);
        setOutlookError(readableErrorMessage(reason, 'Outlook 登录失败，请重试'));
      } finally { polling = false; }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
    timer = window.setTimeout(() => void poll(), device.interval * 1000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [device, load]);

  const closeGmail = () => { setGmailOpen(false); setPassword(''); setGmailError(''); };
  // A paused Gmail account is re-verified by adding the same address with a new App Password.
  const reverifyGmail = (account: StudioMailAccount) => { setEmail(account.email); setPassword(''); setGmailError(''); setGmailOpen(true); };
  const addGmail = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('gmail'); setGmailError('');
    try {
      const account = await readApiJson<StudioMailAccount>(await api.studio.mail.addImap(email.trim(), password));
      setEmail(''); setPassword(''); setGmailOpen(false);
      toast.success(`已连接 ${account.email}`);
      await load();
    } catch (reason) {
      setGmailError(readableErrorMessage(reason, 'Gmail 连接失败，请重试'));
    } finally { setBusy(null); }
  };
  const startOutlook = async () => {
    setBusy('outlook'); setOutlookError('');
    try { setDevice(await readApiJson<StudioMailDeviceStart>(await api.studio.mail.startOutlook())); }
    catch (reason) { setOutlookError(readableErrorMessage(reason, 'Outlook 登录无法开始')); }
    finally { setBusy(null); }
  };
  const copyCode = async () => {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.userCode);
      toast.success('代码已复制');
    } catch { toast('请长按代码手动复制'); }
  };
  const remove = async (account: StudioMailAccount) => {
    setBusy('remove');
    try {
      await readApiJson(await api.studio.mail.removeAccount(account.id));
      toast(`已移除 ${account.email}`);
      await load();
    } catch (reason) { toast.error(readableErrorMessage(reason, '移除失败')); }
    finally { setBusy(null); }
  };

  const outlookReady = Boolean(data?.outlookConfigured);
  const outlookCaption = data ? (outlookReady ? 'Outlook.com / Hotmail，用 Microsoft 账户登录' : '服务器还没有设置 STUDIO_OUTLOOK_CLIENT_ID（见 docs/mail.md）')
    : loadError ? '账户列表没有读到，暂时无法确认 Outlook 是否可用' : 'Outlook.com / Hotmail，用 Microsoft 账户登录';
  const mailProjects = projects?.filter(project => project.modules.includes('mail')) ?? null;
  const maskWithCss = canMaskTextField();
  return <section className="ios-section" aria-labelledby="studio-mail-heading">
    <div className="ios-section-header"><h2 id="studio-mail-heading">邮箱账户</h2><span className="caption">只读</span></div>
    <div className="ios-list">
      {data === null && !loadError && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
      {data === null && loadError && <div className="ios-row no-icon">
        <span className="ios-row-body"><strong>邮箱账户没有读到</strong><small>{loadError}</small></span>
        <button type="button" className="ios-button tinted" onClick={() => void load()}><RotateCw size={15} aria-hidden="true" />重试</button>
      </div>}
      {data?.accounts.map(account => {
        const badge = STATUS_BADGES[account.status];
        // Paused accounts get the action that replaces their credentials instead of a bare status badge.
        const reverify = account.status === 'reauth' && account.provider === 'gmail-imap' ? () => reverifyGmail(account)
          : account.status === 'reauth' && account.provider === 'outlook' && outlookReady ? () => void startOutlook() : null;
        return <div className="ios-row" key={account.id}>
          <ProviderIcon provider={account.provider} />
          <span className="ios-row-body">
            <strong>{account.email}</strong>
            <small>{account.status !== 'ok' && account.lastError ? account.lastError : account.displayName ? `${PROVIDER_LABELS[account.provider]} · ${account.displayName}` : PROVIDER_LABELS[account.provider]}</small>
          </span>
          <span className="mail-account-actions">
            {reverify
              ? <button type="button" className="ios-button tinted mail-reverify" aria-label={`重新验证 ${account.email}`} disabled={busy !== null || device !== null} onClick={reverify}>重新验证</button>
              : <span className={`status-badge ${badge.tone}`}>{badge.label}</span>}
            <button type="button" className="icon-button danger" aria-label={`移除 ${account.email}`} title="移除" disabled={busy !== null} onClick={() => setPendingRemove(account)}>
              <Trash2 size={17} aria-hidden="true" />
            </button>
          </span>
        </div>;
      })}
      {data?.accounts.length === 0 && <div className="ios-row no-icon"><span className="ios-row-body"><small>还没有邮箱账户。添加后，开启了「邮箱」模块的项目会汇总所有账户的收件箱。</small></span></div>}

      <button type="button" className="ios-row action left" aria-expanded={gmailOpen} disabled={busy !== null && busy !== 'gmail'}
        onClick={() => (gmailOpen ? closeGmail() : setGmailOpen(true))}>
        <ProviderIcon provider="gmail-imap" />
        <span className="ios-row-body"><strong>添加 Gmail</strong><small>推荐：应用专用密码，不会过期</small></span>
      </button>
      <AnimatePresence initial={false}>
        {gmailOpen && <m.form key="gmail" className="mail-setup" style={{ overflow: 'hidden' }} {...EXPAND} onSubmit={event => void addGmail(event)} aria-label="添加 Gmail">
          <ol className="mail-steps">
            <li>在 Google 账号的「安全性」里开启两步验证。</li>
            <li>打开「应用专用密码」，新建一个名为 Studio 的密码。</li>
            <li>把显示的 16 位密码粘贴到下面，空格可以保留。</li>
          </ol>
          <a className="mail-link" href={APP_PASSWORDS_URL} target="_blank" rel="noopener noreferrer">打开应用专用密码页面<ExternalLink size={15} aria-hidden="true" /></a>
          <div className="mail-fields">
            <label>Gmail 地址
              <input type="email" inputMode="email" autoComplete="email" autoCapitalize="off" autoCorrect="off" spellCheck={false} required
                placeholder="name@gmail.com" value={email} disabled={busy === 'gmail'} onChange={event => setEmail(event.target.value)} />
            </label>
            <label>应用专用密码
              {/* Not a password manager field: no generated password, nothing saved to the keychain. */}
              <input type={maskWithCss ? 'text' : 'password'} className={maskWithCss ? 'mail-secret' : undefined} name="studio-gmail-app-code"
                autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} required data-1p-ignore="" data-lpignore="true"
                placeholder="xxxx xxxx xxxx xxxx" value={password} disabled={busy === 'gmail'} onChange={event => setPassword(event.target.value)} />
            </label>
          </div>
          {gmailError && <p className="mail-form-error" role="alert">{gmailError}</p>}
          <div className="mail-form-actions">
            <button type="button" className="ios-button tinted" disabled={busy === 'gmail'} onClick={closeGmail}>取消</button>
            <button type="submit" className="ios-button filled" disabled={busy !== null || !email.trim() || !password.trim()}>
              {busy === 'gmail' ? <><StudioSpinner size={15} />正在登录 Gmail…</> : <><KeyRound size={16} aria-hidden="true" />验证并保存</>}
            </button>
          </div>
        </m.form>}
      </AnimatePresence>

      <button type="button" className="ios-row action left" disabled={busy !== null || device !== null || !outlookReady} onClick={() => void startOutlook()}>
        <ProviderIcon provider="outlook" />
        <span className="ios-row-body">
          <strong>添加 Outlook</strong>
          <small>{outlookCaption}</small>
        </span>
        {busy === 'outlook' && <StudioSpinner size={16} label="正在开始" />}
      </button>
      <AnimatePresence initial={false}>
        {device && <m.div key="device" className="mail-device" style={{ overflow: 'hidden' }} {...EXPAND}>
          <p>打开 Microsoft 登录页面，输入下面的代码，并允许 Studio「读取你的邮件」。</p>
          <div className="mail-device-code">
            <span aria-label={`登录代码 ${device.userCode}`}>{device.userCode}</span>
            <button type="button" className="icon-button" aria-label="复制代码" title="复制代码" onClick={() => void copyCode()}><Copy size={18} aria-hidden="true" /></button>
          </div>
          <div className="mail-device-actions">
            <a className="ios-button filled" href={device.verificationUri} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" />打开验证页面</a>
            <button type="button" className="ios-button tinted" onClick={() => setDevice(null)}>取消</button>
          </div>
          <span className="mail-device-wait" role="status"><StudioSpinner size={14} />等待你在 Microsoft 页面完成登录{expiryTime(device.expiresAt) ? ` · ${expiryTime(device.expiresAt)} 前有效` : ''}</span>
        </m.div>}
      </AnimatePresence>
    </div>
    {loadError && <p className="studio-feedback error" role="alert">{loadError}</p>}
    {outlookError && <p className="studio-feedback error" role="alert">{outlookError}</p>}
    {mailProjects && <p className="ios-section-footer mail-projects-hint">
      {mailProjects.length
        ? <>统一收件箱在这些项目的「邮箱」页：{mailProjects.map((project, index) => <span key={project.id}>{index > 0 && '、'}
          <Link to={`/projects/${encodeURIComponent(project.id)}?tab=mail`}>{project.name}</Link></span>)}。其他项目可在「设置」里勾选「邮箱」模块。</>
        : '还没有项目开启「邮箱」：打开一个项目，在「设置」里勾选「邮箱」模块并保存，项目里就会出现「邮箱」页，汇总这里的所有账户。'}
    </p>}
    <p className="ios-section-footer">只读访问：Gmail 以只读方式打开收件箱，不会标记已读；Outlook 只申请 Mail.Read。密码和令牌加密保存在这台电脑上，不会回传到浏览器；邮件内容不会自动发给任何 AI。</p>

    {pendingRemove && <StudioConfirmSheet title={`移除 ${pendingRemove.email}？`}
      message={pendingRemove.provider === 'gmail-oauth' ? '会断开这个项目的 Google OAuth 连接。' : '保存的密码或令牌会从这台电脑删除，邮箱本身不受影响。'}
      confirmLabel="移除"
      onCancel={() => setPendingRemove(null)}
      onConfirm={() => { const account = pendingRemove; setPendingRemove(null); void remove(account); }} />}
  </section>;
}
