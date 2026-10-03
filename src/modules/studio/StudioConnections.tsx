import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CandlestickChart, ChevronRight, ExternalLink, Info, KeyRound, LoaderCircle, MessagesSquare, RefreshCw, Server, ShieldCheck, SquareTerminal } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import { useTheme } from '@/shared/context/ThemeContext';
import type { StudioRemoteHost, StudioRemoteStatus, StudioStatus, T212Status, ThemeMode } from '@/shared/types';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { StudioSettingsMail } from '@/modules/studio/StudioSettingsMail';
import { StudioSettingsModels } from '@/modules/studio/StudioSettingsModels';
import { StudioSettingsNetwork } from '@/modules/studio/StudioSettingsNetwork';
import { StudioSettingsQuota } from '@/modules/studio/StudioSettingsQuota';
import { StudioSettingsRuntime } from '@/modules/studio/StudioSettingsRuntime';
import { StudioSettingsSecurity } from '@/modules/studio/StudioSettingsSecurity';
import { StudioSettingsTrading } from '@/modules/studio/StudioSettingsTrading';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

const THEMES: [ThemeMode, string][] = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']];

function RemoteHostRow({ host }: { host: StudioRemoteHost }) {
  // Result of the last SSH check; null while a check is running (it can take a few seconds).
  const [status, setStatus] = useState<StudioRemoteStatus | null>(null);
  const check = () => {
    setStatus(null);
    void api.studio.remote.status(host.name).then(readApiJson<StudioRemoteStatus>)
      .then(setStatus)
      .catch((reason: unknown) => setStatus({ name: host.name, online: false, latencyMs: null, checkedAt: new Date().toISOString(), tools: { claude: false, codex: false, tmux: false }, error: reason instanceof Error ? reason.message : '检查失败' }));
  };
  // Checked once on open; the button re-checks on demand.
  useEffect(check, [host.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const tools = status?.online ? (['claude', 'codex', 'tmux'] as const).map(tool => `${tool} ${status.tools[tool] ? '✓' : '✗'}`).join(' · ') : status?.error;
  return <div className="ios-row">
    <span className="home-icon small tone-graphite" aria-hidden="true"><Server size={18} strokeWidth={1.6} /></span>
    <span className="ios-row-body"><strong>{host.label}</strong><small className="mono">{host.target}{tools ? ` — ${tools}` : ''}</small></span>
    {status === null ? <StudioSpinner size={16} label="正在检查" />
      : <span className={`status-badge ${status.online ? 'good' : 'warn'}`}>{status.online ? `在线 ${status.latencyMs ?? '–'} ms` : '离线'}</span>}
    <button type="button" className="icon-button" aria-label={`重新检查 ${host.label}`} disabled={status === null} onClick={check}><RefreshCw size={17} aria-hidden="true" /></button>
  </div>;
}

/** Used by StudioPage for local secret provisioning without ever reading a saved key back to the browser. */
export function StudioConnections({ status, onChange }: { status: StudioStatus | null; onChange: () => Promise<void> }) {
  // The unsaved credential is cleared immediately after successful provisioning.
  const [key, setKey] = useState('');
  // Pending requests lock credential controls and avoid repeated verification.
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  // Verified status is transient and not confused with merely saving a key.
  const [result, setResult] = useState('');
  // Configuration errors are shown next to the credential input.
  const [error, setError] = useState('');
  // Removing a key waits for an explicit confirmation in the alert.
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Which Trading 212 key files the server found; the keys themselves are never sent.
  const [t212, setT212] = useState<T212Status[] | null>(null);
  useEffect(() => {
    let active = true;
    void api.studio.trading212.status().then(readApiJson<T212Status[]>).then(value => { if (active) setT212(value); }).catch(() => { if (active) setT212([]); });
    return () => { active = false; };
  }, []);
  const configured = Boolean(status?.deepseek.configured);
  const { themeMode, isDarkMode, setThemeMode } = useTheme();
  // SSH hosts configured on the server (names, labels and targets only).
  const [hosts, setHosts] = useState<StudioRemoteHost[] | null>(null);
  useEffect(() => {
    let active = true;
    void api.studio.remote.hosts().then(readApiJson<StudioRemoteHost[]>).then(value => { if (active) setHosts(value); }).catch(() => { if (active) setHosts([]); });
    return () => { active = false; };
  }, []);

  const act = async (kind: 'save' | 'test' | 'remove', operation: () => Promise<void>) => {
    setBusy(kind); setError(''); setResult('');
    try { await operation(); await onChange(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败'); }
    finally { setBusy(null); }
  };

  return <>
    <section className="ios-section first" aria-labelledby="studio-appearance-heading">
      <div className="ios-section-header"><h2 id="studio-appearance-heading">外观</h2></div>
      <div className="ios-list">
        <div className="ios-row no-icon appearance-row">
          <span className="ios-row-body"><strong>主题</strong><small>{themeMode === 'system' ? `跟随系统 · 当前${isDarkMode ? '深色' : '浅色'}` : '固定外观，不随系统变化'}</small></span>
          <div className="segmented" role="radiogroup" aria-label="主题">
            {THEMES.map(([mode, label]) => <button type="button" role="radio" key={mode} aria-checked={themeMode === mode} onClick={() => setThemeMode(mode)}>{label}</button>)}
          </div>
        </div>
      </div>
    </section>

    <StudioSettingsRuntime />

    <StudioSettingsNetwork />

    <StudioSettingsSecurity />

    <section className="ios-section" aria-labelledby="studio-remote-heading">
      <div className="ios-section-header"><h2 id="studio-remote-heading">远程主机</h2><span className="caption">Tailscale + SSH</span></div>
      <div className="ios-list">
        {hosts === null && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
        {hosts?.map(host => <RemoteHostRow key={host.name} host={host} />)}
        {hosts?.length === 0 && <div className="ios-row no-icon"><span className="ios-row-body"><small>服务器还没有配置远程主机（.env 里的 STUDIO_SSH_HOSTS）</small></span></div>}
      </div>
      <p className="ios-section-footer">在「新建」或项目「设置 → 运行位置」里选择主机后，项目里的 Claude Code / Codex / 终端会在那台主机上运行。</p>
    </section>

    <StudioSettingsMail />

    <section className="ios-section" aria-labelledby="studio-deepseek-heading">
      <div className="ios-section-header"><h2 id="studio-deepseek-heading">DeepSeek API</h2><span className="caption">本地密钥库</span></div>
      <div className="ios-list">
        <div className="ios-row">
          <span className="home-icon small tone-slate" aria-hidden="true"><MessagesSquare size={22} /></span>
          <span className="ios-row-body"><strong>DeepSeek</strong><small>{status?.deepseek.source === 'file' ? '来自服务器密钥文件（STUDIO_DEEPSEEK_ENV_FILE）' : status?.deepseek.baseUrl ?? 'https://api.deepseek.com'}</small></span>
          <span className={`status-badge ${configured ? 'good' : 'warn'}`}>{configured ? '已配置' : '未配置'}</span>
        </div>
        <form className="ios-row-group" onSubmit={event => { event.preventDefault(); void act('save', async () => { await api.studio.saveKey(key).then(readApiJson); setKey(''); setResult('密钥已保存'); }); }}>
          <div className="ios-field">
            <label htmlFor="studio-api-key">API 密钥</label>
            <input id="studio-api-key" type="password" autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              value={key} onChange={event => setKey(event.target.value)} placeholder={configured ? '输入新密钥以替换' : '必填'} disabled={busy !== null} />
            <button className="ios-button filled" disabled={busy !== null || !key.trim()}>
              {busy === 'save' ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}保存
            </button>
          </div>
        </form>
        <button type="button" className="ios-row action left no-icon" disabled={busy !== null || !configured}
          onClick={() => void act('test', async () => { await api.studio.testKey().then(readApiJson); setResult('连接验证通过'); })}>
          {busy === 'test' && <LoaderCircle size={18} className="spin" aria-hidden="true" />}验证连接
        </button>
        <button type="button" className="ios-row action left destructive no-icon" disabled={busy !== null || status?.deepseek.source !== 'vault'} onClick={() => setConfirmRemove(true)}>
          {busy === 'remove' && <LoaderCircle size={18} className="spin" aria-hidden="true" />}移除密钥
        </button>
      </div>
      {result && <p className="studio-feedback good" role="status">{result}</p>}
      {error && <p className="studio-feedback error" role="alert">{error}</p>}
      <p className="ios-section-footer">凭据在本机加密保存，不会回传到浏览器。验证只调用模型列表接口，不产生对话费用；对话费用计入你的 DeepSeek API 账户。</p>
    </section>

    <section className="ios-section" aria-labelledby="studio-agents-heading">
      <div className="ios-section-header"><h2 id="studio-agents-heading">Claude · Codex</h2><span className="caption">本机订阅登录</span></div>
      <div className="ios-list">
        <Link to="/work?new=claude" className="ios-row">
          <span className="home-icon small tone-clay" aria-hidden="true">C</span>
          <span className="ios-row-body"><strong>Claude Code</strong><small>Claude 订阅 · 在工作台中对话</small></span>
          <ChevronRight size={18} className="chevron" aria-hidden="true" />
        </Link>
        <Link to="/work?new=codex" className="ios-row">
          <span className="home-icon small tone-graphite" aria-hidden="true"><SquareTerminal size={20} /></span>
          <span className="ios-row-body"><strong>Codex</strong><small>ChatGPT 订阅 · 在工作台中对话</small></span>
          <ChevronRight size={18} className="chevron" aria-hidden="true" />
        </Link>
        {status?.agentWorkbenchUrl && <a className="ios-row" href={status.agentWorkbenchUrl} target="_blank" rel="noreferrer">
          <span className="home-icon small tone-stone" aria-hidden="true"><ExternalLink size={18} /></span>
          <span className="ios-row-body"><strong>外部工作台</strong><small>{status.agentWorkbenchUrl}</small></span>
          <ChevronRight size={18} className="chevron" aria-hidden="true" />
        </a>}
      </div>
      <p className="ios-section-footer">工作台直接调用这台电脑上已登录的 Claude Code 与 Codex CLI，不替换凭据，也不会转为 API 计费。</p>
    </section>

    <StudioSettingsModels />

    <StudioSettingsQuota />

    <section className="ios-section" aria-labelledby="studio-t212-heading">
      <div className="ios-section-header"><h2 id="studio-t212-heading">Trading 212</h2><span className="caption">密钥文件</span></div>
      <div className="ios-list">
        {(t212 ?? []).map(item => <div className="ios-row" key={item.env}>
          <span className="home-icon small tone-moss" aria-hidden="true"><CandlestickChart size={17} strokeWidth={1.6} /></span>
          <span className="ios-row-body"><strong>{item.env === 'live' ? '实盘账户' : '模拟账户'}</strong><small>{item.source ? `密钥文件 · ${item.source}` : '未设置密钥文件'}</small></span>
          <span className={`status-badge ${item.configured ? 'good' : ''}`}>{item.configured ? '已接入' : '未接入'}</span>
        </div>)}
        {t212 === null && <div className="ios-row no-icon"><span className="ios-row-body"><small>正在检查…</small></span></div>}
      </div>
      <p className="ios-section-footer">密钥只保存在服务器指定的 .env 文件里（STUDIO_T212_ENV_FILE / STUDIO_T212_DEMO_ENV_FILE），下单默认关闭，开启方式和安全设置见下方「交易安全」。</p>
    </section>

    <StudioSettingsTrading />

    <section className="ios-section" aria-labelledby="studio-about-heading">
      <div className="ios-section-header"><h2 id="studio-about-heading">关于</h2></div>
      <div className="ios-list">
        <a className="ios-row" href="https://github.com/Jineggegg/agent-cloud-studio" target="_blank" rel="noreferrer">
          <span className="home-icon small tone-slate" aria-hidden="true"><Info size={20} /></span>
          <span className="ios-row-body"><strong>Agent Cloud Studio</strong><small>修改版源码</small></span>
          <ExternalLink size={16} className="chevron" aria-hidden="true" />
        </a>
        <a className="ios-row" href="https://github.com/siteboon/claudecodeui" target="_blank" rel="noreferrer">
          <span className="home-icon small tone-stone" aria-hidden="true"><ShieldCheck size={20} /></span>
          <span className="ios-row-body"><strong>CloudCLI UI</strong><small>上游项目 · AGPL-3.0-or-later</small></span>
          <ExternalLink size={16} className="chevron" aria-hidden="true" />
        </a>
      </div>
    </section>

    {confirmRemove && <StudioConfirmSheet title="移除 DeepSeek 密钥？" message="本地保存的密钥将被删除，之后需要重新输入才能对话。" confirmLabel="移除"
      onCancel={() => setConfirmRemove(false)}
      onConfirm={() => { setConfirmRemove(false); void act('remove', async () => { await api.studio.removeKey().then(readApiJson); setResult('密钥已移除'); }); }} />}
  </>;
}
