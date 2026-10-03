import { useState } from 'react';

import { STUDIO_AJ_EXIT_SHORTCUTS } from '@/shared/constants';
import { AjExitGuide } from '@/modules/studio/StudioAjExitSheet';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { SettingsValueRow } from '@/modules/studio/StudioSettingsRows';
import { resetAjExit, runAjExit, useAjExitState } from '@/modules/studio/hooks/useAjExit';

/**
 * Used by Settings → AJ 出口: what this device last asked Tailscale for, a switch that runs the opposite Shortcut (the
 * same as tapping the home-screen tile), the one-time setup and a way to start it again.
 */
export function StudioSettingsAjExit() {
  const { ready, on, supported } = useAjExitState();
  // Starting the setup again forgets the last request too, so it waits for a confirmation.
  const [confirmReset, setConfirmReset] = useState(false);
  const state = !supported ? '这台设备不支持' : !ready ? '未设置' : on ? '已开启' : '未开启';
  return <>
    <section className="ios-section first" aria-labelledby="studio-aj-state-heading">
      <div className="ios-section-header"><h2 id="studio-aj-state-heading">这台设备</h2><span className="caption">只记在本机</span></div>
      <div className="ios-list">
        <div className="ios-row no-icon">
          <span className="ios-row-body"><strong>AJ 出口</strong><small>{ready ? `上次请求：${on ? '开' : '关'}` : '还没有确认快捷指令已建好'}</small></span>
          <span className={`status-badge ${on && ready ? 'good' : ''}`}>{state}</span>
        </div>
        <SettingsValueRow title="开" value={STUDIO_AJ_EXIT_SHORTCUTS.on} />
        <SettingsValueRow title="关" value={STUDIO_AJ_EXIT_SHORTCUTS.off} />
        {supported && (ready
          ? <button type="button" className="ios-row action left no-icon" onClick={() => runAjExit(!on)}>{on ? '关闭 AJ 出口' : '开启 AJ 出口'}</button>
          : <button type="button" className="ios-row action left no-icon" onClick={() => runAjExit(true)}>已经建好，开启 AJ 出口</button>)}
        {ready && <button type="button" className="ios-row action left destructive no-icon" onClick={() => setConfirmReset(true)}>重新设置</button>}
      </div>
    </section>
    <section className="ios-section settings-prose aj-sheet" aria-labelledby="studio-aj-guide-heading">
      <div className="ios-section-header"><h2 id="studio-aj-guide-heading">设置步骤</h2></div>
      <div className="settings-prose-body"><AjExitGuide ready={ready} supported={supported} /></div>
    </section>
    {confirmReset && <StudioConfirmSheet title="重新设置 AJ 出口？" message="Studio 会忘记这台设备上的设置和上次的开关请求；下次轻点图标时会再显示设置步骤。Tailscale 本身不受影响。"
      confirmLabel="重新设置" onCancel={() => setConfirmReset(false)} onConfirm={() => { setConfirmReset(false); resetAjExit(); }} />}
  </>;
}
