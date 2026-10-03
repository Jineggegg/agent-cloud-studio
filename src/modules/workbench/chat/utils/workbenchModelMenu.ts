import { createElement } from 'react';

import type {
  ProviderModelOption, WorkbenchMenuSection, WorkbenchModelCatalogs, WorkbenchNewChatChoice, WorkbenchNewProvider,
} from '@/shared/types';
import { resolveModelChoice } from '@/shared/utils';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

// Under the menu of a started conversation: what picking another provider's model does.
const HANDOFF_NOTE = '换成其他服务的模型时，前面的对话会整理成摘要交给它，在这里接着聊。';
// Under the menu when the provider cannot change here (an earlier stretch of a handed-over conversation).
const SWITCH_LOCKED_NOTE = '这段对话已经交给其他模型继续了；要换服务，请打开最新的会话。';
// The model of a started DeepSeek conversation is the one it was created with.
const MODEL_FIXED_NOTE = '这个对话的模型已固定。';

/**
 * The model part of a workbench menu: one row per catalog row (its name, its one-line description, 推荐 on the
 * recommended one, checked when the current model resolves to it, legacy values such as `opus[1m]` included) and,
 * when the current model has a 1M variant, a separate group with the 1M context switch. Picking another family keeps
 * the switch on where that family has a 1M window too. Used by the one model menu below (the provider's own models)
 * and by tests of the menu itself.
 */
export function modelMenuSections(
  options: ProviderModelOption[],
  currentModel: string,
  onSelectModel: (model: string) => void,
  emptyNote?: string,
): WorkbenchMenuSection[] {
  const current = resolveModelChoice(options, currentModel);
  const modelSection: WorkbenchMenuSection = {
    key: 'model',
    title: '模型',
    note: options.length ? undefined : emptyNote,
    items: options.map((option) => ({
      key: option.value,
      label: option.label,
      hint: option.description,
      badge: option.recommended ? '推荐' : undefined,
      checked: option.value === current?.option.value,
      onSelect: () => onSelectModel(current?.longContext && option.longContextValue ? option.longContextValue : option.value),
    })),
  };

  const longContextValue = current?.option.longContextValue;
  if (!current || !longContextValue) return [modelSection];
  return [modelSection, {
    key: 'context',
    items: [{
      key: 'long-context',
      kind: 'toggle',
      label: '1M 上下文',
      hint: '适合超长会话和大型仓库，用量更高',
      checked: current.longContext,
      onSelect: () => onSelectModel(current.longContext ? current.option.value : longContextValue),
    }],
  }];
}

/** One provider's rows in the one model menu, in menu order (Claude Code, Codex, DeepSeek). */
type ModelMenuProvider = {
  provider: WorkbenchNewProvider;
  // The provider's catalog rows; empty while unread (a single 默认模型 row then stands in).
  options: ProviderModelOption[];
  // Why this provider cannot run here (DeepSeek without a Studio project); its section shows the reason, no rows.
  unavailableReason: string | null;
};

/**
 * The providers of the one model menu with their rows: the open chat's own provider with the options it already
 * shows, the others from `catalogs`. `choices` is null when the provider cannot change, and then only the chat's
 * own provider is listed. Used by the agent and DeepSeek views of the workbench chat, so both menus read alike.
 */
export function menuProvidersFor({ choices, current, currentOptions, catalogs }: {
  choices: WorkbenchNewChatChoice[] | null;
  current: WorkbenchNewProvider;
  currentOptions: ProviderModelOption[];
  catalogs: WorkbenchModelCatalogs;
}): ModelMenuProvider[] {
  const optionsOf = (provider: WorkbenchNewProvider): ProviderModelOption[] => {
    if (provider === current) return currentOptions;
    if (provider === 'deepseek') return (catalogs.deepseek?.models ?? []).map((value) => ({ value, label: value }));
    return catalogs[provider] ?? [];
  };
  const listed = choices ?? [{ provider: current, unavailableReason: null }];
  return listed.map((choice) => ({ provider: choice.provider, options: optionsOf(choice.provider), unavailableReason: choice.unavailableReason }));
}

/**
 * How the one model menu treats the other providers: `switch` (before the first message) lists them and a pick
 * switches the chat in place; `handoff` (a started conversation) lists them with a note that a pick hands the
 * conversation over with a summary; `locked` lists only the chat's own provider, with the reason.
 */
type ProviderSwitchMode = 'switch' | 'handoff' | 'locked';

/**
 * The one model menu of a workbench chat (header pill and composer chip): a section per provider, titled with its
 * official mark, listing its models. Picking another provider's model calls `onSwitch` with the model and its label
 * (`mode` says what that means and which note explains it). `onSelectModel` is absent when even the model is fixed
 * (a started DeepSeek conversation).
 */
export function oneModelMenuSections({ providers, current, currentModel, mode, onSelectModel, onSwitch, emptyNote }: {
  providers: ModelMenuProvider[];
  current: WorkbenchNewProvider;
  currentModel: string;
  mode: ProviderSwitchMode;
  onSelectModel?: (model: string) => void;
  onSwitch: (provider: WorkbenchNewProvider, model: string | null, modelLabel: string | null) => void;
  emptyNote?: string;
}): WorkbenchMenuSection[] {
  const locked = mode === 'locked';
  const sections: WorkbenchMenuSection[] = [];
  for (const entry of providers) {
    const title = providerLabel(entry.provider);
    const icon = createElement(WorkbenchProviderMark, { provider: entry.provider, size: 18 });
    if (entry.provider === current) {
      if (!onSelectModel) {
        sections.push({ key: `model-${entry.provider}`, title, icon, note: MODEL_FIXED_NOTE, items: [] });
        continue;
      }
      const [models, ...rest] = modelMenuSections(entry.options, currentModel, onSelectModel, emptyNote);
      sections.push({ ...models, key: `model-${entry.provider}`, title, icon }, ...rest);
      continue;
    }
    if (locked) continue;
    if (entry.unavailableReason) {
      sections.push({ key: `model-${entry.provider}`, title, icon, note: entry.unavailableReason, items: [] });
      continue;
    }
    sections.push({
      key: `model-${entry.provider}`,
      title,
      icon,
      items: entry.options.length
        ? entry.options.map((option) => ({
          key: option.value,
          label: option.label,
          hint: option.description,
          badge: option.recommended ? '推荐' : undefined,
          onSelect: () => onSwitch(entry.provider, option.value, option.label),
        }))
        : [{ key: 'default', label: '默认模型', hint: `改用 ${title}，模型列表还没读到`, onSelect: () => onSwitch(entry.provider, null, null) }],
    });
  }
  if (locked) sections.push({ key: 'locked', note: SWITCH_LOCKED_NOTE, items: [] });
  if (mode === 'handoff' && sections.some((section) => section.key.startsWith('model-') && section.key !== `model-${current}`)) {
    sections.push({ key: 'handoff', note: HANDOFF_NOTE, items: [] });
  }
  return sections;
}
