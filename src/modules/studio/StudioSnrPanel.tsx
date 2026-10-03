
import { IconExternalLink, IconShieldCheck } from '@/modules/studio/icons/tabler';
import type { StudioSnr } from '@/shared/types';
import { StudioSnrView } from '@/modules/studio/StudioSnrView';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

const RESEARCH_AREAS = ['行情回放与图表标注', 'HPA / EL / SNR AOI', '纠正记录与样本库', 'Wiki 规则审核'];

/** Used by StudioPage's project app for the SNR K-line lab tab: health facts and the protected gateway into the lab. */
export function StudioSnrPanel({ snr, remoteUrl }: { snr: StudioSnr | null; remoteUrl: string | null }) {
  const online = Boolean(snr?.connected);
  const capabilities = online ? snr?.manifest?.capabilities ?? [] : [];
  return <div className="studio-stagger">
    <div className="snr-hero">
      <StudioTileIcon tone="sage" glyph="activity" size={30} />
      <div><h2>K 线实验室</h2><p>{snr?.manifest?.name ?? 'SNR Strategy Laboratory'} · 本机{snr?.manifest?.version ? ` · v${snr.manifest.version}` : ''}</p></div>
      <span className={`status-badge ${online ? 'good' : ''}`}>{online ? '在线' : '离线'}</span>
    </div>
    {!online && <p className="snr-offline-note" role="status">{snr?.reason ?? '未连接'}</p>}
    <div className="snr-facts">
      <div className="snr-fact"><span>研究阶段</span><strong>{snr?.phase ? `Phase ${snr.phase}` : '未知'}</strong></div>
      <div className="snr-fact"><span>数据集</span><strong>{online ? snr?.datasetCount ?? 0 : '–'}</strong></div>
      <div className="snr-fact"><span>策略规则</span><strong>{online ? snr?.rulesApproved ? '已批准' : '待审核' : '未知'}</strong></div>
      <div className="snr-fact"><span>交易</span><strong>{online ? snr?.tradingEnabled ? '已启用' : '未启用' : '未知'}</strong></div>
    </div>
    <div className="snr-actions">
      <StudioSnrView connected={online} />
      {remoteUrl && <a className="ios-button tinted" href={remoteUrl} target="_blank" rel="noreferrer">独立入口<IconExternalLink size={16} aria-hidden="true" /></a>}
    </div>
    {capabilities.length > 0 && <section className="ios-section">
      <div className="ios-section-header"><h2>接入能力</h2><span className="caption">来自实验室的集成清单</span></div>
      <div className="snr-capabilities">{capabilities.map(capability => <span className="status-badge" key={capability}>{capability}</span>)}</div>
    </section>}
    <section className="ios-section">
      <div className="ios-section-header"><h2>研究工作区</h2><span className="caption">登录保护</span></div>
      <div className="ios-list">
        {RESEARCH_AREAS.map((label, index) => <div className="ios-row" key={label}>
          <span className="ios-row-number">0{index + 1}</span>
          <span className="ios-row-body"><strong>{label}</strong></span>
          <span className="status-badge">开发中</span>
        </div>)}
      </div>
    </section>
    <p className="studio-boundary"><IconShieldCheck size={16} aria-hidden="true" />规则未审批 · 不自动训练 · 不执行交易</p>
  </div>;
}
