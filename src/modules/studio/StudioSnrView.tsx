import { useState } from 'react';
import { ArrowLeft, ExternalLink, LoaderCircle } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';

/** Used by StudioPage to open the real SNR app behind the authenticated, fixed-target gateway. */
export function StudioSnrView({ connected }: { connected: boolean }) {
  // The iframe only exists after the user explicitly opens the research app.
  const [url, setUrl] = useState<string | null>(null);
  // Grant requests cannot be duplicated while the secure cookie is being issued.
  const [busy, setBusy] = useState(false);
  // Gateway failures stay visible instead of opening an empty frame.
  const [error, setError] = useState('');
  const open = async () => {
    setBusy(true); setError('');
    try { const access = await api.studio.snrAccess().then(readApiJson<{ url: string }>); setUrl(access.url); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开实验室'); }
    finally { setBusy(false); }
  };
  if (url) return <div className="studio-snr-overlay" role="region" aria-label="SNR 图表工作台"><header><button className="command-button" onClick={() => setUrl(null)}><ArrowLeft size={17} />Studio</button><strong>SNR 3.0</strong><span>研究实验室</span></header><iframe title="SNR 3.0 研究实验室" src={url} allow="microphone 'self'" /></div>;
  return <div><button className="command-button primary" disabled={!connected || busy} onClick={() => void open()}>{busy ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}打开实验室</button>{error && <p className="studio-feedback error" role="alert">{error}</p>}</div>;
}
