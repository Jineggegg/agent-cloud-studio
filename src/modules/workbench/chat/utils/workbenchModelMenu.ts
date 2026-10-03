import type { ProviderModelOption, WorkbenchMenuSection } from '@/shared/types';
import { resolveModelChoice } from '@/shared/utils';

/**
 * The model part of a workbench menu: one row per catalog row (its name, its one-line description, 推荐 on the
 * recommended one, checked when the current model resolves to it, legacy values such as `opus[1m]` included) and,
 * when the current model has a 1M variant, a separate group with the 1M context switch. Picking another family keeps
 * the switch on where that family has a 1M window too. Used by the chat header's pill menu and the composer's model
 * chip.
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
