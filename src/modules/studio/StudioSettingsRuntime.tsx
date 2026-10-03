import { useEffect, useState } from 'react';

import { IconDevices, IconGitBranch, IconRefresh, IconServer } from '@/modules/studio/icons/tabler';
import { ApiRequestError, api, readApiJson } from '@/shared/api';
import type { StudioBuildInfo, StudioRuntimeInfo } from '@/shared/types';
import { StudioBrandMark } from '@/modules/studio/brandIcons';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-runtime.css';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBuild(value: unknown): value is StudioBuildInfo {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.version === 'string'
    && (value.commit === null || typeof value.commit === 'string' && /^[a-f0-9]{40}$/i.test(value.commit))
    && typeof value.builtAt === 'string' && Number.isFinite(Date.parse(value.builtAt))
    && (value.dirty === null || typeof value.dirty === 'boolean');
}

function isRuntimeInfo(value: unknown): value is StudioRuntimeInfo {
  if (!isRecord(value) || typeof value.checkedAt !== 'string') return false;
  for (const key of ['frontend', 'backend']) {
    const build = value[key];
    if (!isRecord(build) || !['recorded', 'unknown'].includes(String(build.state))
      || !(build.build === null || isBuild(build.build)) || !(build.reason === null || typeof build.reason === 'string')) return false;
  }
  const { checkout, github, host } = value;
  return isRecord(checkout) && ['available', 'unavailable'].includes(String(checkout.state))
    && (checkout.commit === null || typeof checkout.commit === 'string')
    && (checkout.branch === null || typeof checkout.branch === 'string')
    && (checkout.dirty === null || typeof checkout.dirty === 'boolean')
    && (checkout.reason === null || typeof checkout.reason === 'string')
    && isRecord(github) && ['available', 'unavailable', 'unconfigured'].includes(String(github.state))
    && ['repository', 'defaultBranch', 'commit', 'checkedAt', 'reason'].every(key => github[key] === null || typeof github[key] === 'string')
    && isRecord(host) && ['hostname', 'platform', 'bootedAt', 'processStartedAt'].every(key => typeof host[key] === 'string')
    && typeof host.uptimeSeconds === 'number';
}

function dateLabel(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
}

function buildLabel(build: StudioBuildInfo | null) {
  if (!build) return '未记录';
  return `v${build.version} · ${build.commit?.slice(0, 8) ?? '提交未记录'}${build.dirty === true ? ' · 含未提交改动' : build.dirty === null ? ' · 改动状态未知' : ''}`;
}

function BuildRow({ title, build, note }: { title: string; build: StudioBuildInfo | null; note: string }) {
  return <div className="ios-row studio-runtime-row">
    <span className="home-icon small tone-slate" aria-hidden="true"><IconDevices size={20} /></span>
    <span className="ios-row-body"><strong>{title}</strong><span className="mono studio-runtime-value">{buildLabel(build)}</span>
      <small>{build ? `构建于 ${dateLabel(build.builtAt)} · ${note}` : note}</small></span>
  </div>;
}

/**
 * Used by Settings → 关于本机 → 版本与运行状态 to distinguish loaded, deployed and source versions without changing
 * code. `onOpenNetwork` opens Settings → 网络与远程主机.
 */
export function StudioSettingsRuntime({ onOpenNetwork }: { onOpenNetwork?: () => void } = {}) {
  // Keep the last good snapshot visible if a later refresh fails.
  const [info, setInfo] = useState<StudioRuntimeInfo | null>(null);
  // A request locks refresh and provides an explicit loading state.
  const [busy, setBusy] = useState(true);
  // Failed loads remain actionable instead of leaving a permanent spinner.
  const [error, setError] = useState('');
  // A manual refresh starts a new effect and cancels the previous request on cleanup.
  const [refreshIndex, setRefreshIndex] = useState(0);
  const browserBuild = typeof __STUDIO_BUILD_INFO__ !== 'undefined' && isBuild(__STUDIO_BUILD_INFO__) ? __STUDIO_BUILD_INFO__ : null;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    void api.studio.runtime(controller.signal).then(readApiJson<unknown>).then(value => {
      if (!isRuntimeInfo(value)) throw new Error('invalid runtime response');
      if (active) setInfo(value);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof ApiRequestError && failure.status === 401
        ? '登录已失效，请重新登录后再试。' : '暂时无法读取运行状态。请检查连接后重试；旧版后台可能尚未支持此页面。');
    }).finally(() => { window.clearTimeout(timer); if (active) setBusy(false); });
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [refreshIndex]);
  const refresh = () => { setBusy(true); setError(''); setRefreshIndex(previous => previous + 1); };
  const deployed = info?.frontend.build;
  const browserDiffers = browserBuild && deployed && (browserBuild.commit !== deployed.commit
    || browserBuild.builtAt !== deployed.builtAt || browserBuild.dirty !== deployed.dirty || browserBuild.version !== deployed.version);
  const backendDiffers = deployed?.commit && info?.backend.build?.commit && deployed.commit !== info.backend.build.commit;

  return <section className="ios-section first studio-runtime" aria-labelledby="studio-runtime-heading">
    <div className="ios-section-header">
      <h2 id="studio-runtime-heading">版本与运行状态</h2>
      <button type="button" className="studio-runtime-action" disabled={busy} onClick={() => void refresh()}>
        {busy ? <StudioSpinner size={16} /> : <IconRefresh size={16} aria-hidden="true" />}刷新状态
      </button>
    </div>
    <div className="ios-list" aria-busy={busy}>
      <BuildRow title="这个浏览器" build={browserBuild} note={browserBuild ? '当前页面实际载入的构建' : '未记录构建信息，可能正在开发模式运行'} />
      {info && <>
        <BuildRow title="已部署前端" build={info.frontend.build} note={info.frontend.reason ?? '服务器磁盘上的构建'} />
        <BuildRow title="正在运行的后台" build={info.backend.build} note={info.backend.reason ?? '后台启动时载入的构建'} />
        <div className="ios-row studio-runtime-row">
          <span className="home-icon small tone-stone" aria-hidden="true"><IconGitBranch size={20} /></span>
          <span className="ios-row-body"><strong>当前代码目录</strong>
            <span className="mono studio-runtime-value">{info.checkout.commit ? `${info.checkout.branch ?? '分支未记录'} · ${info.checkout.commit.slice(0, 8)}` : '无法检查'}</span>
            <small>{info.checkout.reason ?? (info.checkout.dirty === true ? '有未提交改动' : info.checkout.dirty === false ? '没有未提交改动' : '改动状态未知')} · 源码状态不代表运行版本</small></span>
        </div>
        <div className="ios-row studio-runtime-row">
          <span className="home-icon small tone-graphite" aria-hidden="true"><StudioBrandMark brand="github" size={20} /></span>
          <span className="ios-row-body"><strong>GitHub 最新提交</strong>
            <span className="mono studio-runtime-value">{info.github.commit ? `${info.github.defaultBranch} · ${info.github.commit.slice(0, 8)}` : '无法检查'}</span>
            <small>{info.github.reason ?? info.github.repository} · {info.github.checkedAt ? `检查于 ${dateLabel(info.github.checkedAt)}` : '尚未检查'}</small></span>
        </div>
        <div className="ios-row studio-runtime-row">
          <span className="home-icon small tone-sage" aria-hidden="true"><IconServer size={20} /></span>
          <span className="ios-row-body"><strong>运行主机</strong><span className="studio-runtime-value">{info.host.hostname} · {info.host.platform}</span>
            <small>主机启动 {dateLabel(info.host.bootedAt)}</small><small>后台启动 {dateLabel(info.host.processStartedAt)}</small></span>
        </div>
      </>}
      {!info && busy && <div className="ios-row no-icon"><span className="ios-row-body"><small role="status">正在检查服务器与 GitHub…</small></span></div>}
    </div>
    {error && <p className="studio-feedback error" role="alert">{error}{info ? ' 当前保留上次成功读取的结果。' : ''}</p>}
    {browserDiffers && <div className="studio-runtime-notice" role="status">
      <span>服务器已有不同的前端构建。保存草稿后重新载入，即可使用它。</span>
      <button type="button" className="studio-runtime-action" onClick={() => window.location.reload()}>重新载入页面</button>
    </div>}
    {backendDiffers && <p className="studio-runtime-notice" role="status">前端与后台来自不同提交，请核对部署版本。</p>}
    <div className="ios-section-footer">
      <p>{info ? `本次读取 ${dateLabel(info.checkedAt)}。` : ''}GitHub 显示 origin 仓库默认分支，检查结果最多缓存 1 分钟。</p>
      {onOpenNetwork && <div className="studio-runtime-links"><button type="button" className="studio-runtime-action" onClick={onOpenNetwork}>查看连接方式与远程主机</button></div>}
    </div>
  </section>;
}
