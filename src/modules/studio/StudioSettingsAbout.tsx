import { IconGitBranch, IconInfoCircle, IconShieldCheck } from '@/modules/studio/icons/tabler';
import { browserBuild } from '@/modules/studio/settingsPages';
import { SettingsExternalRow, SettingsLinkRow, SettingsValueRow } from '@/modules/studio/StudioSettingsRows';
import { LaunchMark } from '@/shared/ui/LaunchScreen';

function dateLabel(value: string) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Europe/London' }) : '未记录';
}

/**
 * Used by Settings → 关于本机, like iOS's About: the logo and name, the plain facts of the build in front of the owner, then rows one
 * level further in — the full version and runtime check (StudioSettingsRuntime), the source and the upstream licence.
 */
export function StudioSettingsAbout({ onOpenRuntime }: { onOpenRuntime: () => void }) {
  const build = browserBuild();
  return <>
    {/* The platform logo heads the page, as iOS's About shows the device. */}
    <header className="settings-about-head">
      <span className="settings-about-logo" aria-hidden="true"><LaunchMark /></span>
      <strong>Agent Cloud Studio</strong>
      <span>{build ? `v${build.version}` : '开发模式'}</span>
    </header>
    <section className="ios-section first" aria-label="本机信息">
      <div className="ios-list">
        <SettingsValueRow title="名称" value="Agent Cloud Studio" />
        <SettingsValueRow title="版本" value={build ? `v${build.version}` : '开发模式'} />
        <SettingsValueRow title="构建" value={build?.commit ? `${build.commit.slice(0, 8)}${build.dirty ? ' · 含未提交改动' : ''}` : '未记录'} mono />
        {build && <SettingsValueRow title="构建时间" value={dateLabel(build.builtAt)} />}
      </div>
    </section>
    <section className="ios-section" aria-label="更多">
      <div className="ios-list">
        <SettingsLinkRow icon={<IconGitBranch size={18} />} title="版本与运行状态" subtitle="已部署前端、后台、代码目录与 GitHub" onClick={onOpenRuntime} />
      </div>
    </section>
    <section className="ios-section" aria-label="源代码与许可">
      <div className="ios-list">
        <SettingsExternalRow icon={<IconInfoCircle size={18} />} title="Agent Cloud Studio" subtitle="修改版源码" href="https://github.com/Jineggegg/agent-cloud-studio" />
        <SettingsExternalRow icon={<IconShieldCheck size={18} />} title="CloudCLI UI" subtitle="上游项目 · AGPL-3.0-or-later" href="https://github.com/siteboon/claudecodeui" />
      </div>
    </section>
  </>;
}
