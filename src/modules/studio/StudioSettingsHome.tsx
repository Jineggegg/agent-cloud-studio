import { useState } from 'react';

import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { clearHomeNames, useHomeLayout, useHomeNames } from '@/modules/studio/utils/homeLayout';
import { readHarnessOnLaunch, writeHarnessOnLaunch } from '@/modules/studio/utils/harnessLaunch';

/**
 * Used by Settings → 主屏幕: the home screen's look (names, icon size), whether Studio opens in Harness, how many
 * apps are hidden and in folders, and the two resets — typed names (synced across devices) and this device's
 * arrangement (order, folders, hidden apps).
 */
export function StudioSettingsHome() {
  const [layout, updateLayout] = useHomeLayout();
  const names = useHomeNames();
  // Each reset waits for a confirmation in the alert.
  const [confirm, setConfirm] = useState<'names' | 'layout' | null>(null);
  // Whether opening Studio on this device lands in Harness; mirrors localStorage so the switch moves at once.
  const [harnessOnLaunch, setHarnessOnLaunch] = useState(readHarnessOnLaunch);
  const renamed = Object.keys(names).length;
  const foldered = layout.folders.reduce((count, folder) => count + folder.items.length, 0);
  return <>
    <section className="ios-section first" aria-labelledby="studio-home-look-heading">
      <div className="ios-section-header"><h2 id="studio-home-look-heading">外观</h2><span className="caption">这台设备</span></div>
      <div className="ios-list">
        <label className="ios-row no-icon switch-row">
          <span className="ios-row-body"><strong>显示名称</strong><small>图标下面的名字和状态</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label="显示名称" checked={layout.labels} onChange={event => updateLayout({ labels: event.target.checked })} />
        </label>
        <label className="ios-row no-icon switch-row">
          <span className="ios-row-body"><strong>大图标</strong><small>每页放的图标更少</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label="大图标" checked={layout.large} onChange={event => updateLayout({ large: event.target.checked })} />
        </label>
        <label className="ios-row no-icon switch-row">
          <span className="ios-row-body"><strong>打开时进入 Harness</strong><small>打开 Studio 先看 Claude Code 和 Codex 在电脑上跑的任务</small></span>
          <input type="checkbox" role="switch" className="ios-switch" aria-label="打开时进入 Harness" checked={harnessOnLaunch}
            onChange={event => { setHarnessOnLaunch(event.target.checked); writeHarnessOnLaunch(event.target.checked); }} />
        </label>
      </div>
    </section>
    <section className="ios-section" aria-labelledby="studio-home-arrange-heading">
      <div className="ios-section-header"><h2 id="studio-home-arrange-heading">排列</h2></div>
      <div className="ios-list">
        <div className="ios-row no-icon"><span className="ios-row-body"><strong>文件夹</strong></span><span className="ios-row-detail">{layout.folders.length ? `${layout.folders.length} 个 · ${foldered} 个应用` : '无'}</span></div>
        <div className="ios-row no-icon"><span className="ios-row-body"><strong>已隐藏的应用</strong><small>在主屏幕编辑模式的「资源库」里放回</small></span><span className="ios-row-detail">{layout.hidden.length}</span></div>
        <div className="ios-row no-icon"><span className="ios-row-body"><strong>改过的名字</strong><small>所有设备同步</small></span><span className="ios-row-detail">{renamed}</span></div>
        <button type="button" className="ios-row action left no-icon" disabled={!renamed} onClick={() => setConfirm('names')}>恢复默认名称</button>
        <button type="button" className="ios-row action left destructive no-icon" onClick={() => setConfirm('layout')}>重置主屏幕布局</button>
      </div>
      <p className="ios-section-footer">长按图标进入编辑模式：拖动排序，把一个图标拖到另一个上停一下就能建文件夹，轻点名字可以改名。排列只保存在这台设备上，名字在所有设备上同步。</p>
    </section>
    {confirm === 'names' && <StudioConfirmSheet title="恢复默认名称？" message="所有改过的图标名字都会恢复原名，所有设备上一起生效。文件夹名字不受影响。" confirmLabel="恢复"
      onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); clearHomeNames(); }} />}
    {confirm === 'layout' && <StudioConfirmSheet title="重置主屏幕布局？" message="这台设备上的图标顺序、文件夹和隐藏的应用都会恢复默认；名字、小组件和项目本身不受影响。" confirmLabel="重置"
      onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); updateLayout(previous => ({ ...previous, hidden: [], order: undefined, folders: [], pageBreaks: undefined })); }} />}
  </>;
}
