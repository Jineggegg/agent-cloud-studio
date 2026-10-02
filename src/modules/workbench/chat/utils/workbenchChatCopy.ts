import type { PermissionMode, ProviderModelOption } from '@/shared/types';

/*
 * The workbench chat column's Chinese wording for providers, permission modes, reasoning effort and model names.
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

/** Reasoning effort in plain words; unknown values pass through. */
export function effortLabel(value: string): string {
  switch (value) {
    case 'default': return '默认';
    case 'none': return '不思考';
    case 'minimal': return '极少';
    case 'low': return '低';
    case 'medium': return '中';
    case 'high': return '高';
    case 'xhigh': return '很高';
    case 'max': return '最高';
    case 'ultra': return 'Ultra';
    case 'ultracode': return 'Ultracode';
    default: return value;
  }
}

/**
 * A model id as a provider reports it on a reply, in plain words: `claude-opus-5-5` → `Opus 5.5`,
 * `claude-sonnet-4-20250514` → `Sonnet 4`. Ids of other shapes (Codex, DeepSeek) pass through unchanged.
 */
export function modelDisplayName(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(model.trim());
  if (!match) return model;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

/**
 * Short model name for pills: the catalogue label without its parenthetical (`Opus (1M context)` → `Opus 1M`),
 * `默认` for the provider default, or the raw id when the catalogue has not loaded.
 */
export function modelShortLabel(model: string, options: ProviderModelOption[]): string {
  const option = options.find((candidate) => candidate.value === model);
  const label = option?.label ?? model;
  if (/^default\b/i.test(label) || model === 'default') return '默认';
  return label.replace(/\s*\((\d+[KM])\s*context\)/i, ' $1').replace(/\s*\(.*\)\s*$/, '').trim() || model;
}
