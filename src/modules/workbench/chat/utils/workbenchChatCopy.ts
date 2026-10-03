import type { PermissionMode, ProviderModelOption } from '@/shared/types';
import { formatModelIdLabel, resolveModelChoice } from '@/shared/utils';

/*
 * The workbench chat column's Chinese wording for providers, permission modes and model names (reasoning effort
 * levels share Studio's words: `reasoningEffortLabel` in shared/utils).
 * One place, because the header pill, the composer chips, the empty state and the permission sheet all name the
 * same things and must use the same words.
 */

/** Product name of a provider as the owner knows it. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case 'codex': return 'Codex';
    case 'cursor': return 'Cursor';
    case 'opencode': return 'OpenCode';
    case 'deepseek': return 'DeepSeek';
    default: return 'Claude Code';
  }
}

/** Short label and one-line explanation of a permission mode, for the composer's mode menu. */
export function permissionModeCopy(mode: PermissionMode | string): { label: string; hint: string } {
  switch (mode) {
    case 'auto': return { label: '自动判断', hint: '低风险操作直接执行，其余再问你' };
    case 'acceptEdits': return { label: '自动改文件', hint: '直接修改文件，运行命令前仍会询问' };
    case 'bypassPermissions': return { label: '全部放行', hint: '不再询问任何操作，只在可信项目里用' };
    case 'plan': return { label: '计划模式', hint: '先只读分析并提交计划，批准后才动手' };
    default: return { label: '每次询问', hint: '修改文件和运行命令前都先问你' };
  }
}

/**
 * A model id as a provider reports it on a reply, in the model menus' names: `claude-opus-5-5` → `Opus 5.5`,
 * `claude-sonnet-4-20250514` → `Sonnet 4`, `gpt-6-sol` → `GPT-6 Sol`. Other ids (DeepSeek) pass through unchanged.
 */
export function modelDisplayName(model: string): string {
  return formatModelIdLabel(model);
}

/**
 * Short model name for pills and chips: the catalogue row's name (legacy values such as `opus[1m]` included) plus
 * ` 1M` when the 1M context window is on, any parenthetical dropped (`Opus (1M context)` → `Opus 1M`), `默认` for a
 * bare provider default, or the id in plain words while the catalogue has not loaded.
 */
export function modelShortLabel(model: string, options: ProviderModelOption[]): string {
  const choice = resolveModelChoice(options, model);
  if (!choice) return model === 'default' ? '默认' : formatModelIdLabel(model);
  const label = choice.option.label;
  if (/^default\b/i.test(label)) return '默认';
  const name = label.replace(/\s*\((\d+[KM])\s*context\)/i, ' $1').replace(/\s*\(.*\)\s*$/, '').trim() || choice.value;
  return choice.longContext ? `${name} 1M` : name;
}
