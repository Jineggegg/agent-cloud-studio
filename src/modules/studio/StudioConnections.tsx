import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CandlestickChart, ChevronRight, ExternalLink, Info, KeyRound, LoaderCircle, MessagesSquare, ShieldCheck, SquareTerminal } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { StudioStatus, T212Status } from '@/shared/types';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';

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

  const act = async (kind: 'save' | 'test' | 'remove', operation: () => Promise<void>) => {
    setBusy(kind); setError(''); setResult('');
    try { await operation(); await onChange(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败'); }
    finally { setBusy(null); }
  };

  return <>
    <section className="ios-section" aria-labelledby="studio-deepseek-heading">
      <div className="ios-section-header"><h2 id="studio-deepseek-heading">DeepSeek API</h2><span className="caption">本地密钥库</span></div>
      <div className="ios-list">
        <div className="ios-row">
          <span className="home-icon small tone-slate" aria-hidden="true"><MessagesSquare size={22} /></span>
          <span className="ios-row-body"><strong>DeepSeek</strong><small>{status?.deepseek.baseUrl ?? 'https://api.deepseek.com'}</small></span>
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
        <button type="button" className="ios-row action left destructive no-icon" disabled={busy !== null || !configured} onClick={() => setConfirmRemove(true)}>
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
        <Link to="/workspace" className="ios-row">
          <span className="home-icon small tone-clay" aria-hidden="true">C</span>
          <span className="ios-row-body"><strong>Claude Code</strong><small>Claude 订阅 · 开发工具会话</small></span>
          <ChevronRight size={18} className="chevron" aria-hidden="true" />
        </Link>
        <Link to="/workspace" className="ios-row">
          <span className="home-icon small tone-graphite" aria-hidden="true"><SquareTerminal size={20} /></span>
          <span className="ios-row-body"><strong>Codex</strong><small>ChatGPT 订阅 · 开发工具会话</small></span>
          <ChevronRight size={18} className="chevron" aria-hidden="true" />
        </Link>
        {status?.agentWorkbenchUrl && <a className="ios-row" href={status.agentWorkbenchUrl} target="_blank" rel="noreferrer">
          <span className="home-icon small tone-stone" aria-hidden="true"><ExternalLink size={18} /></span>
          <span className="ios-row-body"><strong>外部工作台</strong><small>{status.agentWorkbenchUrl}</small></span>
          <ChevronRight size={18} className="chevron" aria-hidden="true" />
        </a>}
      </div>
      <p className="ios-section-footer">开发工具直接调用这台电脑上已登录的 Claude Code 与 Codex CLI，不替换凭据，也不会转为 API 计费。</p>
    </section>

    <section className="ios-section" aria-labelledby="studio-t212-heading">
      <div className="ios-section-header"><h2 id="studio-t212-heading">Trading 212</h2><span className="caption">只读</span></div>
      <div className="ios-list">
        {(t212 ?? []).map(item => <div className="ios-row" key={item.env}>
          <span className="home-icon small tone-moss" aria-hidden="true"><CandlestickChart size={17} strokeWidth={1.6} /></span>
          <span className="ios-row-body"><strong>{item.env === 'live' ? '实盘账户' : '模拟账户'}</strong><small>{item.source ? `密钥文件 · ${item.source}` : '未设置密钥文件'}</small></span>
          <span className={`status-badge ${item.configured ? 'good' : ''}`}>{item.configured ? '已接入' : '未接入'}</span>
        </div>)}
        {t212 === null && <div className="ios-row no-icon"><span className="ios-row-body"><small>正在检查…</small></span></div>}
      </div>
      <p className="ios-section-footer">密钥只保存在服务器指定的 .env 文件里（STUDIO_T212_ENV_FILE / STUDIO_T212_DEMO_ENV_FILE），Studio 只发送读取请求，不会下单。</p>
    </section>

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
