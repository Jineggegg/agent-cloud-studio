import { useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, LoaderCircle, Plug, Trash2 } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { StudioStatus } from '@/shared/types';

/** Used by StudioPage for local secret provisioning without ever reading a saved key back to the browser. */
export function StudioConnections({ status, onChange }: { status: StudioStatus | null; onChange: () => Promise<void> }) {
  // The unsaved credential is cleared immediately after successful provisioning.
  const [key, setKey] = useState('');
  // Pending requests lock credential controls and avoid repeated verification.
  const [busy, setBusy] = useState(false);
  // Verified status is transient and not confused with merely saving a key.
  const [result, setResult] = useState('');
  // Configuration errors are shown next to the credential input.
  const [error, setError] = useState('');
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setResult('');
    try { await operation(); await onChange(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败'); }
    finally { setBusy(false); }
  };
  return <div className="studio-connections">
    <div className="studio-section-heading"><h2>模型连接</h2><span>本地密钥库</span></div>
    <section className="studio-connection">
      <div className="connection-identity"><span className="connection-symbol deepseek"><Plug size={22} /></span><div><h3>DeepSeek API</h3><p>{status?.deepseek.baseUrl ?? 'https://api.deepseek.com'}</p></div><span className={`status-label ${status?.deepseek.configured ? 'good' : ''}`}>{status?.deepseek.configured ? '已配置' : '未配置'}</span></div>
      <form onSubmit={event => { event.preventDefault(); void act(async () => { await api.studio.saveKey(key).then(readApiJson); setKey(''); setResult('密钥已保存'); }); }}>
        <label htmlFor="studio-api-key">API 密钥</label>
        <div className="connection-key-row"><input id="studio-api-key" type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} placeholder={status?.deepseek.configured ? '输入新密钥以替换' : '输入 DeepSeek API 密钥'} disabled={busy} />
          <button className="command-button" disabled={busy || !key.trim()}><KeyRound size={16} />保存</button></div>
      </form>
      <div className="connection-actions"><button className="command-button" disabled={busy || !status?.deepseek.configured} onClick={() => void act(async () => { await api.studio.testKey().then(readApiJson); setResult('连接验证通过'); })}>{busy ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}验证连接</button>
        <button className="icon-button" title="移除密钥" aria-label="移除密钥" disabled={busy || !status?.deepseek.configured} onClick={() => {
          if (window.confirm('移除本地保存的 DeepSeek 密钥？')) void act(async () => { await api.studio.removeKey().then(readApiJson); setResult('密钥已移除'); });
        }}><Trash2 size={18} /></button></div>
      {result && <p className="studio-feedback good" role="status">{result}</p>}
      {error && <p className="studio-feedback error" role="alert">{error}</p>}
      <div className="connection-meta"><span>凭据：本地加密</span><span>计费：DeepSeek API 账户</span></div>
    </section>
    <div className="studio-section-heading"><h2>订阅工作台</h2><span>现有登录</span></div>
    <div className="studio-integration-row"><span className="connection-symbol claude">C</span><div><h3>Claude Code</h3><p>Claude 订阅</p></div>{status?.agentWorkbenchUrl ? <a className="command-button" href={status.agentWorkbenchUrl} target="_blank" rel="noreferrer">打开<ExternalLink size={16} /></a> : <span className="status-label">入口未配置</span>}</div>
    <div className="studio-integration-row"><span className="connection-symbol codex">O</span><div><h3>Codex</h3><p>ChatGPT 订阅</p></div>{status?.agentWorkbenchUrl ? <a className="command-button" href={status.agentWorkbenchUrl} target="_blank" rel="noreferrer">打开<ExternalLink size={16} /></a> : <span className="status-label">入口未配置</span>}</div>
    <div className="studio-section-heading"><h2>关于</h2><span>修改版</span></div>
    <div className="studio-legal">Agent Cloud Studio <a href="https://github.com/Jineggegg/agent-cloud-studio" target="_blank" rel="noreferrer">源码</a><br /><a href="https://github.com/siteboon/claudecodeui" target="_blank" rel="noreferrer">CloudCLI UI</a> · AGPL-3.0-or-later</div>
  </div>;
}
