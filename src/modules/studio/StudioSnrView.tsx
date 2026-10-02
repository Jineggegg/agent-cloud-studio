import { useEffect, useState } from 'react';
import { ChevronDown, ExternalLink, LoaderCircle } from 'lucide-react';
import { createPortal } from 'react-dom';

import { api, readApiJson } from '@/shared/api';

// Matches the CSS slide-down so the cover leaves before the iframe unmounts.
const COVER_EXIT_MS = 380;

/** Used by StudioPage to open the real SNR app behind the authenticated, fixed-target gateway. */
export function StudioSnrView({ connected }: { connected: boolean }) {
  // The iframe only exists after the user explicitly opens the research app.
  const [url, setUrl] = useState<string | null>(null);
  // Grant requests cannot be duplicated while the secure cookie is being issued.
  const [busy, setBusy] = useState(false);
  // Gateway failures stay visible instead of opening an empty frame.
  const [error, setError] = useState('');
  // The full-screen cover plays its exit animation before it is removed.
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!closing) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => { setUrl(null); setClosing(false); }, reduced ? 0 : COVER_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  const open = async () => {
    setBusy(true); setError('');
    try { const access = await api.studio.snrAccess().then(readApiJson<{ url: string }>); setUrl(access.url); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开实验室'); }
    finally { setBusy(false); }
  };

  return <>
    <button type="button" className="ios-button filled" disabled={!connected || busy} onClick={() => void open()}>
      {busy ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <ExternalLink size={17} aria-hidden="true" />}打开实验室
    </button>
    {error && <p className="studio-feedback error" role="alert">{error}</p>}
    {url && createPortal(
      <div className={`studio-layer ${closing ? 'closing' : ''}`} onKeyDown={event => { if (event.key === 'Escape') setClosing(true); }}>
        <div className="studio-cover" role="dialog" aria-modal="true" aria-label="SNR 图表工作台">
          <header>
            <button type="button" className="navbar-back" onClick={() => setClosing(true)} autoFocus><ChevronDown size={22} aria-hidden="true" />完成</button>
            <strong>SNR 3.0</strong>
            <span>研究实验室</span>
          </header>
          <iframe title="SNR 3.0 研究实验室" src={url} allow="microphone 'self'" />
        </div>
      </div>,
      document.body,
    )}
  </>;
}
