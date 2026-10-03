import { useEffect, useState } from 'react';
import { m } from 'motion/react';
import { createPortal } from 'react-dom';

import { IconChevronDown, IconExternalLink, IconRotateClockwise, IconWorld } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { HubProject, StudioLinkStatus, StudioProjectLink } from '@/shared/types';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

function host(url: string) {
  try { return new URL(url).host; } catch { return url; }
}

/** Used by StudioPage to browse a project's websites: live status per link, in-app when embeddable, else a new tab. */
export function StudioLinksSheet({ project, onClose }: { project: HubProject; onClose: () => void }) {
  // Live answer/frameability per URL; null while the server is checking.
  const [status, setStatus] = useState<StudioLinkStatus[] | null>(null);
  // The link shown in the in-app browser, when the site allows framing.
  const [browsing, setBrowsing] = useState<StudioProjectLink | null>(null);
  // Bumped to reload the in-app browser frame.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    void api.studio.projects.linkStatus(project.id).then(readApiJson<StudioLinkStatus[]>)
      .then(value => { if (active) setStatus(value); })
      .catch(() => { if (active) setStatus([]); });
    return () => { active = false; };
  }, [project.id]);

  const open = (link: StudioProjectLink) => {
    const info = status?.find(item => item.url === link.url);
    if (info?.frameable) { setBrowsing(link); return; }
    window.open(link.url, '_blank', 'noopener,noreferrer');
  };

  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') { if (browsing) setBrowsing(null); else onClose(); } }}>
    <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />
    <div className="library-sheet links-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-links-title">
      <div className="library-grabber" aria-hidden="true" />
      <header><h2 id="studio-links-title">{project.name} · 网站</h2><button type="button" className="ios-button tinted" autoFocus onClick={onClose}>完成</button></header>
      <div className="link-grid">
        {project.links.map((link, index) => {
          const info = status?.find(item => item.url === link.url);
          return <m.button type="button" key={link.url} className="link-card" onClick={() => open(link)}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.035, type: 'spring', stiffness: 300, damping: 30 }}
            whileTap={{ scale: 0.96 }}>
            <span className="link-card-icon" aria-hidden="true"><IconWorld size={20} strokeWidth={1.6} /></span>
            <span className="link-card-text"><strong>{link.label}</strong><small>{host(link.url)}</small></span>
            <span className="link-card-status">
              {status === null ? <StudioSpinner size={14} label="检查中" />
                : <><span className={`status-dot ${info?.ok ? 'good' : ''}`} aria-hidden="true" />{info?.ok ? `${info.latencyMs ?? '–'} ms` : info?.status ? `HTTP ${info.status}` : '无法连接'}</>}
            </span>
            <IconExternalLink size={15} className="link-card-open" aria-label={info?.frameable ? '在应用内打开' : '在新标签打开'} />
          </m.button>;
        })}
      </div>
      <p className="ios-section-footer">能嵌入的网站在 Studio 里打开；设置了禁止嵌入的网站（例如超级教授）会在新标签打开。链接可以在项目「设置」里编辑。</p>
    </div>

    {browsing && <div className="studio-cover browser-cover" role="dialog" aria-modal="true" aria-label={browsing.label}>
      <header>
        <button type="button" className="navbar-back ios-press" onClick={() => setBrowsing(null)}><IconChevronDown size={22} aria-hidden="true" />完成</button>
        <strong>{browsing.label}</strong>
        <span className="browser-actions">
          <button type="button" className="icon-button" aria-label="重新加载" onClick={() => setReloadKey(key => key + 1)}><IconRotateClockwise size={18} aria-hidden="true" /></button>
          <a className="icon-button" href={browsing.url} target="_blank" rel="noopener noreferrer" aria-label="在新标签打开"><IconExternalLink size={18} aria-hidden="true" /></a>
        </span>
      </header>
      <iframe key={reloadKey} title={browsing.label} src={browsing.url} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerPolicy="no-referrer" />
    </div>}
  </div>, document.body);
}
