import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import type { ProviderModelOption, WorkbenchChatProps } from '@/shared/types';
import { WorkbenchMenu } from '@/modules/workbench/chat/WorkbenchMenu';
import { WorkbenchProviderMark } from '@/modules/workbench/chat/WorkbenchProviderMark';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

type WorkbenchChatHeaderProps = {
  provider: string;
  modelLabel: string;
  title?: string | null;
  // Providers a new chat may still switch to before its first send; null once the provider is fixed.
  providerChoices: WorkbenchChatProps['provider'][] | null;
  onSelectProvider: (provider: WorkbenchChatProps['provider']) => void;
  models: ProviderModelOption[];
  currentModel: string;
  // Absent when the model is fixed for this conversation (a started DeepSeek conversation keeps its model).
  onSelectModel?: (model: string) => void;
  // Trailing status: the token ring, a run indicator.
  end?: ReactNode;
};

/**
 * Used by WorkbenchAgentChat and WorkbenchDeepSeekChat as the column's glass header: the "Claude Code · Opus ▾"
 * pill that switches provider (only before a new chat's first message) and model (per session), the session title,
 * and trailing status.
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
}: WorkbenchChatHeaderProps) {
  const name = providerLabel(provider);
  const canSwitch = Boolean(providerChoices?.length) || (Boolean(onSelectModel) && models.length > 1);
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
                key: choice,
                label: providerLabel(choice),
                icon: <WorkbenchProviderMark provider={choice} size={22} />,
                checked: choice === provider,
                onSelect: () => onSelectProvider(choice),
              })),
            },
            {
              key: 'model',
              title: '模型',
              note: onSelectModel ? undefined : '这个对话的模型已固定。',
              items: onSelectModel
                ? models.map((option) => ({
                  key: option.value,
                  label: option.label,
                  hint: option.description,
                  checked: option.value === currentModel,
                  onSelect: () => onSelectModel(option.value),
                }))
                : [],
            },
          ]}
        />
      ) : (
        <div className="wbc-pill is-static" aria-label={`${name} · ${modelLabel}`}>{pillContent}</div>
      )}
      {title && <span className="wbc-header-title" title={title}>{title}</span>}
      <div className="wbc-header-end">{end}</div>
    </header>
  );
}
