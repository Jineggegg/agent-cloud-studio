import { useEffect, useState } from 'react';

import { IconRefresh, IconServer } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { StudioRemoteHost, StudioRemoteStatus } from '@/shared/types';
import { SettingsIcon } from '@/modules/studio/StudioSettingsRows';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

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
    <SettingsIcon><IconServer size={18} strokeWidth={1.6} /></SettingsIcon>
    <span className="ios-row-body"><strong>{host.label}</strong><small className="mono">{host.target}{tools ? ` — ${tools}` : ''}</small></span>
    {status === null ? <StudioSpinner size={16} label="正在检查" />
      : <span className={`status-badge ${status.online ? 'good' : 'warn'}`}>{status.online ? `在线 ${status.latencyMs ?? '–'} ms` : '离线'}</span>}
    <button type="button" className="icon-button" aria-label={`重新检查 ${host.label}`} disabled={status === null} onClick={check}><IconRefresh size={17} aria-hidden="true" /></button>
  </div>;
}

/** Used by Settings → 网络与远程主机: the SSH hosts the server can run projects on, each checked when the page opens. */
export function StudioSettingsRemote() {
  // SSH hosts configured on the server (names, labels and targets only).
  const [hosts, setHosts] = useState<StudioRemoteHost[] | null>(null);
  useEffect(() => {
    let active = true;
    void api.studio.remote.hosts().then(readApiJson<StudioRemoteHost[]>).then(value => { if (active) setHosts(value); }).catch(() => { if (active) setHosts([]); });
    return () => { active = false; };
  }, []);
  return <section className="ios-section" aria-labelledby="studio-remote-heading">
    <div className="ios-section-header"><h2 id="studio-remote-heading">远程主机</h2><span className="caption">Tailscale + SSH</span></div>
    <div className="ios-list">
      {hosts === null && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
      {hosts?.map(host => <RemoteHostRow key={host.name} host={host} />)}
      {hosts?.length === 0 && <div className="ios-row no-icon"><span className="ios-row-body"><small>服务器还没有配置远程主机（.env 里的 STUDIO_SSH_HOSTS）</small></span></div>}
    </div>
    <p className="ios-section-footer">在「新建」或项目「设置 → 运行位置」里选择主机后，项目里的 Claude Code / Codex / 终端会在那台主机上运行。</p>
  </section>;
}
