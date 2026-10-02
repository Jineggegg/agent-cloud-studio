import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { ApiRequestError, api, readApiJson } from '@/shared/api';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';

// Absolute links open in a new tab. Relative links point at other repository files, which Studio
// does not serve, so they render as plain text instead of leading to a blank page.
function GuideLink({ href, children }: { href?: string; children?: ReactNode }) {
  return href && /^https?:\/\//i.test(href)
    ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
    : <span>{children}</span>;
}

/**
 * Used by StudioSettingsNetwork to show the network guide (docs/network.md) inside Studio. The
 * server sends the text, so the guide opens on either door, including the tailnet door in mainland
 * China where GitHub often does not load.
 */
export function StudioNetworkGuide({ onClose }: { onClose: () => void }) {
  // The guide's Markdown once loaded; null while the request runs or after it failed.
  const [markdown, setMarkdown] = useState<string | null>(null);
  // Why the guide could not be shown; null while loading or once loaded.
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.studio.networkGuide().then(readApiJson<{ markdown?: unknown }>)
      .then(value => {
        if (typeof value.markdown !== 'string') throw new Error('unexpected guide');
        if (active) setMarkdown(value.markdown);
      })
      .catch((error: unknown) => {
        if (active) setFailure(error instanceof ApiRequestError ? error.message : '说明读取失败，请检查网络后重试');
      });
    return () => { active = false; };
  }, []);

  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />
    <div className="library-sheet studio-network-guide" role="dialog" aria-modal="true" aria-labelledby="studio-network-guide-title">
      <div className="library-grabber" aria-hidden="true" />
      <header>
        <h2 id="studio-network-guide-title">连接方式说明</h2>
        <button type="button" className="ios-button tinted" autoFocus onClick={onClose}>完成</button>
      </header>
      {markdown !== null
        ? <article className="studio-network-guide-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: GuideLink }}>{markdown}</ReactMarkdown>
        </article>
        : failure !== null
          ? <p className="studio-network-guide-status" role="alert">{failure}</p>
          : <p className="studio-network-guide-status"><StudioSpinner size={16} label="读取中" /></p>}
    </div>
  </div>, document.body);
}
