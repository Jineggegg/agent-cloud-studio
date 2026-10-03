import { useState } from 'react';

import { STUDIO_AJ_EXIT_SHORTCUTS } from '@/shared/constants';
import { AjExitGuide } from '@/modules/studio/StudioAjExitSheet';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { SettingsValueRow } from '@/modules/studio/StudioSettingsRows';
import { resetAjExit, runAjExit, useAjExitState } from '@/modules/studio/hooks/useAjExit';

/**
 * Used by Settings → AJ 出口: what this device last asked Tailscale for, a switch that runs the opposite Shortcut (the
 * same as tapping the home-screen tile), the one-time setup and a way to start it again. A device without the
 * Shortcuts app (Windows, Android …) can only be told that AJ 出口 is switched from an iPhone or iPad, so it gets
 * that one line instead of the setup.
 */
export function StudioSettingsAjExit() {
  const { ready, on, supported } = useAjExitState();
  // Starting the setup again forgets the last request too, so it waits for a confirmation.
  const [confirmReset, setConfirmReset] = useState(false);

  if (!supported) return <section className="ios-section first" aria-labelledby="studio-aj-state-heading">
    <div className="ios-section-header"><h2 id="studio-aj-state-heading">这台设备</h2></div>
    <div className="ios-list">
      <div className="ios-row no-icon">
        <span className="ios-row-body"><strong>AJ 出口</strong></span>
        <span className="status-badge">仅限 iPhone / iPad</span>
      </div>
    </div>
    <p className="ios-section-footer">AJ 出口通过 iPhone / iPad 的快捷指令切换，在这台设备上无法操作。</p>
  </section>;

  return <>
    <section className="ios-section first" aria-labelledby="studio-aj-state-heading">
      <div className="ios-section-header"><h2 id="studio-aj-state-heading">这台设备</h2></div>
      <div className="ios-list">
        <div className="ios-row no-icon">
          <span className="ios-row-body"><strong>AJ 出口</strong></span>
          <span className={`status-badge ${on && ready ? 'good' : ''}`}>{!ready ? '未设置' : on ? '已开启' : '未开启'}</span>
        </div>
        <SettingsValueRow title="开" value={STUDIO_AJ_EXIT_SHORTCUTS.on} />
        <SettingsValueRow title="关" value={STUDIO_AJ_EXIT_SHORTCUTS.off} />
        {ready
          ? <button type="button" className="ios-row action left no-icon" onClick={() => runAjExit(!on)}>{on ? '关闭 AJ 出口' : '开启 AJ 出口'}</button>
          : <button type="button" className="ios-row action left no-icon" onClick={() => runAjExit(true)}>已经建好，开启 AJ 出口</button>}
        {ready && <button type="button" className="ios-row action left destructive no-icon" onClick={() => setConfirmReset(true)}>重新设置</button>}
      </div>
    </section>
    <section className="ios-section settings-prose aj-sheet" aria-labelledby="studio-aj-guide-heading">
      <div className="ios-section-header"><h2 id="studio-aj-guide-heading">设置步骤</h2></div>
      <div className="settings-prose-body"><AjExitGuide ready={ready} supported /></div>
    </section>
    {confirmReset && <StudioConfirmSheet title="重新设置 AJ 出口？" message="Studio 会忘记这台设备上的设置和上次的开关请求；下次轻点图标时会再显示设置步骤。Tailscale 本身不受影响。"
      confirmLabel="重新设置" onCancel={() => setConfirmReset(false)} onConfirm={() => { setConfirmReset(false); resetAjExit(); }} />}
  </>;
}
