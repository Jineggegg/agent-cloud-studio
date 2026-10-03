import { useState } from 'react';

import { IconKey, IconLoader2, IconSparkles } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { StudioStatus } from '@/shared/types';
import { StudioBrandMark } from '@/modules/studio/brandIcons';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { SettingsIcon } from '@/modules/studio/StudioSettingsRows';

/** Used by Settings → DeepSeek for local secret provisioning without ever reading a saved key back to the browser. */
export function StudioSettingsDeepSeek({ status, onChange }: { status: StudioStatus | null; onChange: () => Promise<void> }) {
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
  const configured = Boolean(status?.deepseek.configured);
  const { suggestNextPrompt } = useUiPreferences();
  const setPreference = useSetUiPreference();

  const act = async (kind: 'save' | 'test' | 'remove', operation: () => Promise<void>) => {
    setBusy(kind); setError(''); setResult('');
    try { await operation(); await onChange(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '连接失败'); }
    finally { setBusy(null); }
  };

  return <>
  <section className="ios-section first" aria-labelledby="studio-deepseek-heading">
    <div className="ios-section-header"><h2 id="studio-deepseek-heading">API 密钥</h2><span className="caption">本地密钥库</span></div>
    <div className="ios-list">
      <div className="ios-row">
        <SettingsIcon><StudioBrandMark brand="deepseek" size={18} /></SettingsIcon>
        <span className="ios-row-body"><strong>DeepSeek</strong><small>{status?.deepseek.source === 'file' ? '来自服务器密钥文件（STUDIO_DEEPSEEK_ENV_FILE）' : status?.deepseek.baseUrl ?? 'https://api.deepseek.com'}</small></span>
        <span className={`status-badge ${configured ? 'good' : 'warn'}`}>{configured ? '已配置' : '未配置'}</span>
      </div>
      <form className="ios-row-group" onSubmit={event => { event.preventDefault(); void act('save', async () => { await api.studio.saveKey(key).then(readApiJson); setKey(''); setResult('密钥已保存'); }); }}>
        <div className="ios-field">
          <label htmlFor="studio-api-key">API 密钥</label>
          <input id="studio-api-key" type="password" autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            value={key} onChange={event => setKey(event.target.value)} placeholder={configured ? '输入新密钥以替换' : '必填'} disabled={busy !== null} />
          <button className="ios-button filled" disabled={busy !== null || !key.trim()}>
            {busy === 'save' ? <IconLoader2 size={16} className="spin" aria-hidden="true" /> : <IconKey size={16} aria-hidden="true" />}保存
          </button>
        </div>
      </form>
      <button type="button" className="ios-row action left no-icon" disabled={busy !== null || !configured}
        onClick={() => void act('test', async () => { await api.studio.testKey().then(readApiJson); setResult('连接验证通过'); })}>
        {busy === 'test' && <IconLoader2 size={18} className="spin" aria-hidden="true" />}验证连接
      </button>
      <button type="button" className="ios-row action left destructive no-icon" disabled={busy !== null || status?.deepseek.source !== 'vault'} onClick={() => setConfirmRemove(true)}>
        {busy === 'remove' && <IconLoader2 size={18} className="spin" aria-hidden="true" />}移除密钥
      </button>
    </div>
    {result && <p className="studio-feedback good" role="status">{result}</p>}
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    <p className="ios-section-footer">凭据在本机加密保存，不会回传到浏览器。验证只调用模型列表接口，不产生对话费用；对话费用计入你的 DeepSeek API 账户。新建项目时的 AI 起名也用这把密钥（每次不到 0.01 元）。</p>

    {confirmRemove && <StudioConfirmSheet title="移除 DeepSeek 密钥？" message="本地保存的密钥将被删除，之后需要重新输入才能对话。" confirmLabel="移除"
      onCancel={() => setConfirmRemove(false)}
      onConfirm={() => { setConfirmRemove(false); void act('remove', async () => { await api.studio.removeKey().then(readApiJson); setResult('密钥已移除'); }); }} />}
  </section>
  <section className="ios-section" aria-labelledby="studio-suggest-heading">
    <div className="ios-section-header"><h2 id="studio-suggest-heading">输入建议</h2></div>
    <div className="ios-list">
      <label className="ios-row switch-row">
        <SettingsIcon><IconSparkles size={18} /></SettingsIcon>
        <span className="ios-row-body"><strong>建议下一句</strong><small>回复完成后，在输入框里淡淡显示建议的下一条消息，点发送即可</small></span>
        <input type="checkbox" role="switch" className="ios-switch" aria-label="建议下一句" checked={suggestNextPrompt}
          onChange={event => setPreference('suggestNextPrompt', event.target.checked)} />
      </label>
    </div>
    <p className="ios-section-footer">适用于工作台里的 Claude Code、Codex、DeepSeek 对话和 DeepSeek 应用。只把最近几轮对话（代码块省略）发给 deepseek-chat，每次约千分之一元；没有密钥时只在助手问「要我继续吗？」时建议「好的，继续」。</p>
  </section>
  </>;
}
