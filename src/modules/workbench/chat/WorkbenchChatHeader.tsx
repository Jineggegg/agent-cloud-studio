import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import type { ProviderModelOption, WorkbenchChatChrome, WorkbenchNewChatChoice, WorkbenchNewProvider } from '@/shared/types';
import { WorkbenchMenu } from '@/modules/workbench/chat/WorkbenchMenu';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import { modelMenuSections } from '@/modules/workbench/chat/utils/workbenchModelMenu';

type WorkbenchChatHeaderProps = {
  provider: string;
  modelLabel: string;
  title?: string | null;
  // Agents a new chat may still switch to before its first send; null once the provider is fixed.
  providerChoices: WorkbenchNewChatChoice[] | null;
  onSelectProvider: (provider: WorkbenchNewProvider) => void;
  models: ProviderModelOption[];
  currentModel: string;
  // Absent when the model is fixed for this conversation (a started DeepSeek conversation keeps its model).
  onSelectModel?: (model: string) => void;
  // Trailing status: the token ring, a run indicator.
  end?: ReactNode;
  // The shell's controls and project name, making this the workbench's only title bar.
  chrome?: WorkbenchChatChrome;
};

/**
 * Used by WorkbenchAgentChat and WorkbenchDeepSeekChat as the workbench's glass title bar: the shell's leading
 * controls, the "Claude Code · Opus ▾" pill that switches provider (only before a new chat's first message) and
 * model (per session), the session title over the project name, trailing status and the shell's inspector tools.
 */
export function WorkbenchChatHeader({
  provider,
  modelLabel,
  title,
  providerChoices,
  onSelectProvider,
  models,
  currentModel,
  onSelectModel,
  end,
  chrome,
}: WorkbenchChatHeaderProps) {
  const name = providerLabel(provider);
  const canSwitch = Boolean(providerChoices?.length) || (Boolean(onSelectModel) && models.length > 1);
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
          label={`${name} · ${modelLabel}，切换服务或模型`}
          triggerClassName="wbc-pill"
          trigger={pillContent}
          sections={[
            {
              key: 'provider',
              title: '服务',
              note: providerChoices ? undefined : '对话开始后不能更换服务，可以新建一个对话。',
              items: (providerChoices ?? []).map((choice) => ({
                key: choice.provider,
                label: providerLabel(choice.provider),
                hint: choice.unavailableReason ?? undefined,
                icon: <WorkbenchProviderMark provider={choice.provider} size={22} />,
                checked: choice.provider === provider,
                disabled: Boolean(choice.unavailableReason),
                onSelect: () => onSelectProvider(choice.provider),
              })),
            },
            ...(onSelectModel
              ? modelMenuSections(models, currentModel, onSelectModel)
              : [{ key: 'model', title: '模型', note: '这个对话的模型已固定。', items: [] }]),
          ]}
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
