import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { toast } from 'sonner';
import { Check, ExternalLink, Globe, KeyRound, Network, RefreshCw } from 'lucide-react';

import { ApiRequestError, api, readApiJson } from '@/shared/api';
import { buildHandoffUrl, readIngressPreference, writeIngressPreference } from '@/shared/utils';
import type { StudioIngress, StudioIngressId, StudioNetworkInfo } from '@/shared/types';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-network.css';

/** POST /api/auth/handoff: a one-time code for the target door, valid for 60 s. */
type HandoffTicket = { code: string; target: StudioIngressId; origin: string; expiresAt: string };

/** Result of timing a request to a door's /health. */
type ProbeResult = { reachable: true; latencyMs: number } | { reachable: false };

const DOCS_URL = 'https://github.com/Jineggegg/agent-cloud-studio/blob/main/docs/network.md';
// A door that has not answered by then is reported as unreachable.
const PROBE_TIMEOUT_MS = 5000;
const DOOR_ICONS: Record<StudioIngressId, typeof Globe> = { public: Globe, tailnet: Network };
const DOOR_TONES: Record<StudioIngressId, string> = { public: 'tone-slate', tailnet: 'tone-sage' };

// Times a no-cors request to the door's public health check. The response is opaque, so this
// only proves that the origin answered (through Cloudflare Access, if any) and how fast.
async function probeDoor(origin: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = performance.now();
  try {
    await fetch(`${origin}/health`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal });
    return { reachable: true, latencyMs: Math.max(1, Math.round(performance.now() - started)) };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

// The endpoint is new; an older server (or a test stub) answering something else must not break Settings.
function isNetworkInfo(value: unknown): value is StudioNetworkInfo {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as StudioNetworkInfo).ingresses)
    && Array.isArray((value as StudioNetworkInfo).guidance);
}

function handoffFailure(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'AUTH_INVALID_CREDENTIALS') return '密码不正确';
    if (error.code === 'AUTH_HANDOFF_TARGET_UNCONFIGURED') return '这个入口还没有在服务器上配置';
    return error.message;
  }
  return '切换失败，请检查网络后重试';
}

/** Used by StudioConnections (Settings) for choosing how this device reaches Studio: the public domain (default) or Tailscale through AJ. */
export function StudioSettingsNetwork() {
  // Both doors and the one serving this page, from the server; null while loading.
  const [info, setInfo] = useState<StudioNetworkInfo | null>(null);
  // Set when the network endpoint could not be read, so the section offers a retry instead of a spinner.
  const [loadFailed, setLoadFailed] = useState(false);
  // Latest reachability probe per door; a missing key means the probe is still running.
  const [probes, setProbes] = useState<Partial<Record<StudioIngressId, ProbeResult>>>({});
  // The door being switched to; locks the rows while the code is fetched and the page navigates away.
  const [switching, setSwitching] = useState<StudioIngressId | null>(null);
  // Door whose switch waits for the account password (a Tailscale session moving to the public door).
  const [passwordFor, setPasswordFor] = useState<StudioIngressId | null>(null);
  // The password being typed; cleared once a code was issued.
  const [password, setPassword] = useState('');
  // This device's remembered door on this origin, read once on open.
  const [preferred] = useState<StudioIngressId | null>(() => readIngressPreference());

  const fetchInfo = useCallback(() => {
    void api.studio.network().then(readApiJson<unknown>)
      .then(value => {
        if (!isNetworkInfo(value)) throw new Error('unexpected network info');
        setInfo(value);
      })
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(fetchInfo, [fetchInfo]);
  const retryLoad = () => {
    setLoadFailed(false);
    fetchInfo();
  };

  // Each probe round gets a number, so a slow answer from an earlier round never overwrites a newer one.
  const probeRound = useRef(0);
  const runProbes = useCallback((ingresses: StudioIngress[]) => {
    const round = ++probeRound.current;
    for (const ingress of ingresses) {
      if (!ingress.origin) continue;
      void probeDoor(ingress.origin).then(result => {
        if (round === probeRound.current) setProbes(previous => ({ ...previous, [ingress.id]: result }));
      });
    }
  }, []);
  useEffect(() => { if (info) runProbes(info.ingresses); }, [info, runProbes]);
  const reprobe = () => {
    if (!info) return;
    setProbes({});
    runProbes(info.ingresses);
  };

  const handoff = async (ingress: StudioIngress, withPassword?: string) => {
    setSwitching(ingress.id);
    try {
      const ticket = await api.studio.handoff(ingress.id, withPassword).then(readApiJson<HandoffTicket>);
      setPassword('');
      writeIngressPreference(ingress.id);
      // The page on the other origin redeems the code at boot (auth module) and opens this same path.
      window.location.assign(buildHandoffUrl(ticket.origin, ticket.code));
    } catch (error) {
      setSwitching(null);
      if (error instanceof ApiRequestError && error.code === 'AUTH_HANDOFF_PASSWORD_REQUIRED') {
        setPasswordFor(ingress.id);
        return;
      }
      toast.error(handoffFailure(error));
    }
  };

  const choose = (ingress: StudioIngress) => {
    if (!info || switching || ingress.id === info.current || !ingress.origin) return;
    // A Tailscale session never moves to the public door without the password (server rule).
    if (info.session === 'tailscale' && ingress.id === 'public') {
      setPasswordFor(ingress.id);
      return;
    }
    if (probes[ingress.id]?.reachable === false) {
      toast(`${ingress.label}现在连不上`, {
        description: ingress.id === 'tailnet' ? '先确认这台设备已连上 Tailscale。' : '先确认电脑上的 Cloudflare Tunnel 正在运行。',
        action: { label: '仍然前往', onClick: () => void handoff(ingress) },
      });
      return;
    }
    void handoff(ingress);
  };

  const cancelPassword = () => {
    setPasswordFor(null);
    setPassword('');
  };

  const currentLabel = info?.ingresses.find(ingress => ingress.id === info.current)?.label;
  const preferredDoor = info?.ingresses.find(ingress => ingress.id === preferred && ingress.origin);
  // Only an earlier deliberate choice that differs from where this page is open earns a hint.
  const showPreference = Boolean(info && preferredDoor && info.current !== 'local' && preferredDoor.id !== info.current);
  const passwordDoor = info?.ingresses.find(ingress => ingress.id === passwordFor);

  return <section className="ios-section studio-network" aria-labelledby="studio-network-heading">
    <div className="ios-section-header">
      <h2 id="studio-network-heading">连接方式</h2>
      <span className="caption">{info ? `当前 · ${currentLabel ?? '本机地址'}` : '同一台电脑 · 两个入口'}</span>
    </div>
    <div className="ios-list" role="radiogroup" aria-labelledby="studio-network-heading" aria-busy={info === null || switching !== null}>
      {info === null && !loadFailed && <div className="ios-row no-icon"><StudioSpinner size={16} /><span className="ios-row-body"><small>读取中</small></span></div>}
      {loadFailed && <button type="button" className="ios-row action left no-icon" onClick={retryLoad}>
        <RefreshCw size={17} aria-hidden="true" />读取失败，点此重试
      </button>}
      {info?.ingresses.map(ingress => {
        const Icon = DOOR_ICONS[ingress.id];
        const isCurrent = ingress.id === info.current;
        const probe = probes[ingress.id];
        return <button type="button" role="radio" key={ingress.id} aria-checked={isCurrent}
          className={`ios-row studio-network-door${isCurrent ? ' is-current' : ''}`}
          disabled={!ingress.origin || (switching !== null && switching !== ingress.id)}
          onClick={() => choose(ingress)}>
          <span className={`home-icon small ${DOOR_TONES[ingress.id]}`} aria-hidden="true"><Icon size={18} strokeWidth={1.7} /></span>
          <span className="ios-row-body">
            <strong>{ingress.label}{ingress.isDefault && <span className="studio-network-tag">默认</span>}</strong>
            <small className="mono">{ingress.origin ?? '未配置'}</small>
          </span>
          {switching === ingress.id ? <StudioSpinner size={16} label="正在切换" />
            : <span className="studio-network-status">
              {ingress.origin && <span className="studio-network-latency">
                {probe === undefined ? <StudioSpinner size={13} label="正在检测" />
                  : probe.reachable ? `${probe.latencyMs} ms` : <span className="studio-network-down">不可达</span>}
              </span>}
              {isCurrent && <span className="status-badge good"><Check size={13} strokeWidth={2.4} aria-hidden="true" />当前</span>}
            </span>}
        </button>;
      })}
      <AnimatePresence initial={false}>
        {passwordDoor && <m.form key="password" className="ios-row-group studio-network-password"
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
          onSubmit={event => { event.preventDefault(); void handoff(passwordDoor, password); }}>
          <div className="ios-field">
            <label htmlFor="studio-network-password">密码</label>
            <input id="studio-network-password" type="password" autoComplete="current-password" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              value={password} onChange={event => setPassword(event.target.value)} placeholder="Studio 账户密码" disabled={switching !== null} autoFocus />
            <button className="ios-button filled" disabled={switching !== null || !password}>
              <KeyRound size={16} aria-hidden="true" />切换
            </button>
          </div>
          <p className="studio-network-note">
            当前是 Tailscale 免密码会话，切到{passwordDoor.label}需要输入一次账户密码。
            <button type="button" className="studio-network-link" onClick={cancelPassword}>取消</button>
          </p>
        </m.form>}
      </AnimatePresence>
    </div>

    {showPreference && preferredDoor && <div className="ios-list studio-network-preference">
      <button type="button" className="ios-row action left no-icon" disabled={switching !== null} onClick={() => choose(preferredDoor)}>
        此设备上次选择了「{preferredDoor.label}」，切换过去
      </button>
    </div>}

    <div className="ios-section-footer studio-network-footer">
      <p>两个入口连到这台电脑上的同一个 Studio 和数据库，数据只有一份。默认走公网域名；在国内或公网不通时选 Tailscale，并在 Tailscale 里使用 AJ 的出口节点。切换会把当前登录一起带过去。</p>
      {info && info.guidance.length > 1 && <ul>{info.guidance.slice(1).map(line => <li key={line}>{line}</li>)}</ul>}
      <div className="studio-network-actions">
        <a className="studio-network-link" href={DOCS_URL} target="_blank" rel="noreferrer">设置说明<ExternalLink size={13} aria-hidden="true" /></a>
        {info && <button type="button" className="studio-network-link" disabled={switching !== null} onClick={reprobe}>
          <RefreshCw size={13} aria-hidden="true" />重新检测
        </button>}
      </div>
    </div>
  </section>;
}
