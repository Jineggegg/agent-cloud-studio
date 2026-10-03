import { createPortal } from 'react-dom';

import { STUDIO_AJ_EXIT_SHORTCUTS } from '@/shared/constants';

// The Tailscale exit node on AJ's server.
const AJ_EXIT_NODE = 'aryan-Lenovo-ideapad-330-15ICH';
// Studio's public address, which keeps working after 关 has disconnected Tailscale.
const PUBLIC_STUDIO_HOST = 'studio.ajarche.com';

/**
 * What AJ 出口 does and how to set it up once (install Tailscale, create the two Shortcuts), shared by the sheet the
 * tile opens and Settings → AJ 出口. `ready` adds what the 已开启 / 未开启 label can and cannot know.
 */
export function AjExitGuide({ ready, supported }: { ready: boolean; supported: boolean }) {
  // A tailnet address stops loading once 关 disconnects Tailscale; say so where it applies.
  const onTailnet = /\.ts\.net$/i.test(window.location.hostname);
  return <>
    <p>轻点图标，这台设备就连上 Tailscale，并把上网流量改走 AJ 的服务器（出口节点 <code>{AJ_EXIT_NODE}</code>）；再点一次，停用出口节点并断开 Tailscale，恢复直连。</p>
    {!supported && <p className="aj-note is-warning" role="note">切换要用 iPad 或 iPhone 上的「快捷指令」来控制 Tailscale，这台设备上用不了。请在 iPad 上打开 Studio 再设置。</p>}
    <p>网页不能直接控制 Tailscale，所以 Studio 会运行你建好的两个快捷指令（会短暂切到「快捷指令」，运行完轻点左上角返回 Studio），只需设置一次：</p>
    <ol className="aj-steps">
      <li>在 iPad 上安装 Tailscale，并登录你的账号。</li>
      <li>打开「快捷指令」，新建快捷指令 <code>{STUDIO_AJ_EXIT_SHORTCUTS.on}</code>：先添加 Tailscale 的「连接 / Connect」，再添加「Use Exit Node」，选 <code>{AJ_EXIT_NODE}</code>。</li>
      <li>再新建 <code>{STUDIO_AJ_EXIT_SHORTCUTS.off}</code>：先添加「Stop Using Exit Node」，再添加「断开连接 / Disconnect」。</li>
    </ol>
    <p className="aj-note">名字要一字不差。快捷指令不用添加到主屏幕，只要在「快捷指令」App 里有这两个就行。</p>
    <p className={`aj-note ${onTailnet ? 'is-warning' : ''}`}>
      「关」会断开 Tailscale VPN，之后用 ts.net 地址打开的 Studio 就连不上了{onTailnet ? '（你现在用的就是 ts.net 地址）' : ''}。在 iPad 上请用 <strong>{PUBLIC_STUDIO_HOST}</strong> 打开 Studio。
    </p>
    {ready && <p className="aj-note">Studio 只记得自己上一次请求的是开还是关。如果你在 Tailscale App 里改过，这里显示的「已开启 / 未开启」可能不准；再点一次图标，会运行与显示相反的那个快捷指令。</p>}
  </>;
}

/**
 * Used by StudioHomeScreen for the AJ 出口 tile: the one-time setup on the first tap, and afterwards its settings
 * (start the setup again). Where there is no Shortcuts app it explains that the tile needs an iPad or iPhone.
 */
export function StudioAjExitSheet({ ready, on, supported, onClose, onFinishSetup, onResetSetup }: {
  // Whether the owner has confirmed the Shortcuts exist on this device.
  ready: boolean;
  // What Studio last asked for on this device.
  on: boolean;
  // Whether this device has the Shortcuts app (iPad, iPhone, Mac).
  supported: boolean;
  onClose: () => void; onFinishSetup: () => void; onResetSetup: () => void;
}) {
  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />
    <div className="library-sheet aj-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-aj-exit-title">
      <div className="library-grabber" aria-hidden="true" />
      <header>
        <h2 id="studio-aj-exit-title">AJ 出口</h2>
        {ready && supported && <span className={`aj-state ${on ? 'is-on' : ''}`}>{on ? '已开启' : '未开启'}</span>}
      </header>
      <AjExitGuide ready={ready} supported={supported} />
      <div className="aj-sheet-actions">
        {!ready && supported && <button type="button" className="ios-button filled" autoFocus onClick={onFinishSetup}>已经建好，开启 AJ 出口</button>}
        {ready && <button type="button" className="ios-button tinted" onClick={onResetSetup}>重新设置</button>}
        <button type="button" className="ios-button" autoFocus={ready || !supported} onClick={onClose}>{ready ? '完成' : supported ? '以后再说' : '知道了'}</button>
      </div>
    </div>
  </div>, document.body);
}
