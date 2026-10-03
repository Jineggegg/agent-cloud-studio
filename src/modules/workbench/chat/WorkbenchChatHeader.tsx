import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import type { WorkbenchChatChrome, WorkbenchMenuSection } from '@/shared/types';
import { WorkbenchMenu } from '@/modules/workbench/chat/WorkbenchMenu';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

type WorkbenchChatHeaderProps = {
  provider: string;
  modelLabel: string;
  title?: string | null;
  // The one model menu (oneModelMenuSections); the pill is static when it offers nothing to pick.
  menuSections: WorkbenchMenuSection[];
  // Trailing status: the token ring, a run indicator.
  end?: ReactNode;
  // The shell's controls and project name, making this the workbench's only title bar.
  chrome?: WorkbenchChatChrome;
};

/**
 * Used by WorkbenchAgentChat and WorkbenchDeepSeekChat as the workbench's glass title bar: the shell's leading
 * controls, the "Claude Code · Opus ▾" pill opening the one model menu (every provider's models before a new chat's
 * first message, its own provider's afterwards), the session title over the project name, trailing status and the
 * shell's inspector tools.
 */
export function WorkbenchChatHeader({ provider, modelLabel, title, menuSections, end, chrome }: WorkbenchChatHeaderProps) {
  const name = providerLabel(provider);
  const pickable = menuSections.reduce((count, section) => count + section.items.length, 0);
  const canSwitch = pickable > 1;
  const projectName = chrome?.projectName;
  // Inside the shell a new chat is still named, so the bar always says where the owner is.
  const heading = title ?? (projectName ? '新会话' : null);
  const pillContent = (
    <>
      <WorkbenchProviderMark provider={provider} size={22} />
      <span className="wbc-pill-provider">{name}</span>
      <span className="wbc-pill-sep" aria-hidden="true">·</span>
      <span className="wbc-pill-model">{modelLabel}</span>
      {canSwitch && <ChevronDown className="wbc-pill-chevron" size={15} strokeWidth={2.4} aria-hidden="true" />}
    </>
  );

  return (
    <header className="wbc-header">
      {chrome?.leading && <div className="wbc-header-leading">{chrome.leading}</div>}
      {canSwitch ? (
        <WorkbenchMenu
          label={`${name} · ${modelLabel}，切换模型`}
          triggerClassName="wbc-pill"
          trigger={pillContent}
          width={320}
          sections={menuSections}
        />
      ) : (
        <div className="wbc-pill is-static" aria-label={`${name} · ${modelLabel}`}>{pillContent}</div>
      )}
      {heading && (
        <span className="wbc-header-title" title={projectName ? `${heading} · ${projectName}` : heading}>
          <strong>{heading}</strong>
          {projectName && <small>{projectName}</small>}
        </span>
      )}
      <div className="wbc-header-end">{end}{chrome?.trailing}</div>
    </header>
  );
}
