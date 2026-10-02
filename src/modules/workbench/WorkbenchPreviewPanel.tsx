import { useState } from 'react';
import type { FormEvent } from 'react';
import { ExternalLink, Globe, RotateCw, SquareTerminal } from 'lucide-react';

import { StudioSpinner } from '@/modules/studio';

// Hosts that only mean "the computer running the server"; another device reaching Studio cannot open them as-is.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

// Accepts "localhost:5173" or a full address; only http(s) can be previewed.
function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function shortLabel(address: string) {
  try {
    const url = new URL(address);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return address;
  }
}

/**
 * Used by the workbench inspector's 预览 panel: shows a web page in a frame — an address detected in the terminal
 * output (a dev server) or one typed in — with reload and open-in-new-tab. It says plainly when a frame cannot work
 * (an http page inside https Studio, or a localhost address seen from another device) instead of failing silently.
 */
export function WorkbenchPreviewPanel({ detected, onOpenTerminal }: { detected: string[]; onOpenTerminal: () => void }) {
  // The address the owner picked or typed; null follows the newest detected address.
  const [chosen, setChosen] = useState<string | null>(null);
  // The address field while it is being edited; null mirrors the address on show.
  const [draft, setDraft] = useState<string | null>(null);
  // Bumped by reload so the frame loads again even for the same address.
  const [reloads, setReloads] = useState(0);
  // The frame has finished loading the current address.
  const [loadedKey, setLoadedKey] = useState('');
  // The typed address was not a web address.
  const [invalid, setInvalid] = useState(false);

  const address = chosen ?? detected[0] ?? null;
  const frameKey = `${address}#${reloads}`;
  let host = '';
  let insecure = false;
  try {
    if (address) {
      const url = new URL(address);
      host = url.hostname;
      insecure = url.protocol === 'http:' && window.location.protocol === 'https:';
    }
  } catch { /* an unparsable address shows no hints */ }
  const pageHost = window.location.hostname;
  const loopbackElsewhere = LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(pageHost);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = normalizeAddress(draft ?? address ?? '');
    setInvalid(!next);
    if (!next) return;
    setChosen(next);
    setDraft(null);
    setReloads(value => value + 1);
  };
  const useStudioHost = () => {
    if (!address) return;
    const url = new URL(address);
    url.hostname = pageHost;
    setChosen(url.toString());
    setDraft(null);
  };

  return <div className="wb-preview">
    <form className="wb-preview-bar" onSubmit={submit}>
      <label className="wb-preview-address">
        <Globe size={14} aria-hidden="true" />
        <input value={draft ?? address ?? ''} onChange={event => { setDraft(event.target.value); setInvalid(false); }} placeholder="localhost:5173 或完整地址"
          aria-label="预览地址" aria-invalid={invalid || undefined} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <button type="button" className="icon-button plain" aria-label="重新载入" title="重新载入" disabled={!address} onClick={() => setReloads(value => value + 1)}>
        <RotateCw size={17} aria-hidden="true" />
      </button>
      <a className={`icon-button plain ${address ? '' : 'is-disabled'}`} href={address ?? undefined} target="_blank" rel="noreferrer" aria-label="在新标签页打开" title="在新标签页打开"
        aria-disabled={!address || undefined} onClick={event => { if (!address) event.preventDefault(); }}>
        <ExternalLink size={17} aria-hidden="true" />
      </a>
    </form>
    {invalid && <p className="wb-preview-note is-error" role="alert">请输入 http 或 https 地址，例如 localhost:5173。</p>}
    {detected.length > 0 && <div className="wb-preview-chips" role="group" aria-label="终端里检测到的地址">
      {detected.slice(0, 6).map(url => <button type="button" key={url} className="wb-chip" aria-pressed={url === address}
        onClick={() => { setChosen(url); setDraft(null); setInvalid(false); }}>{shortLabel(url)}</button>)}
    </div>}
    {address && loopbackElsewhere && <p className="wb-preview-note">
      这是运行服务器那台电脑上的地址，其他设备可能打不开。
      <button type="button" className="wb-link-button" onClick={useStudioHost}>改用 {pageHost}</button>
    </p>}
    {address && insecure && <p className="wb-preview-note">Studio 通过 https 打开，浏览器不允许在页面里嵌入 http 网页，请用右上角在新标签页打开。</p>}

    {address ? <div className="wb-preview-frame">
      {loadedKey !== frameKey && <div className="wb-preview-loading"><StudioSpinner size={22} label="正在载入网页" /></div>}
      <iframe key={frameKey} src={address} title={`网页预览：${shortLabel(address)}`} onLoad={() => setLoadedKey(frameKey)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" referrerPolicy="no-referrer" />
    </div> : <div className="wb-panel-empty">
      <Globe size={28} strokeWidth={1.5} aria-hidden="true" />
      <strong>还没有可预览的网页</strong>
      <p>在终端里启动开发服务器（例如 npm run dev），检测到的地址会出现在这里；也可以在上方直接输入地址。</p>
      <button type="button" className="ios-button tinted" onClick={onOpenTerminal}><SquareTerminal size={16} aria-hidden="true" />打开终端</button>
    </div>}
  </div>;
}
