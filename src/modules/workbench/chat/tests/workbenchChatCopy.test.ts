import { describe, expect, test } from 'vitest';

import { modelDisplayName, modelShortLabel, permissionModeCopy, providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

const CLAUDE = [
  { value: 'claude-fable-5-1', label: 'Fable 5.1', aliases: ['fable', 'best'], longContextValue: 'claude-fable-5-1[1m]' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', aliases: ['opus', 'default'], longContextValue: 'claude-opus-5-5[1m]' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', aliases: ['haiku'] },
];

describe('workbench chat wording', () => {
  test('reported model ids read as the menus name them; unknown shapes pass through', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelDisplayName('claude-opus-4-1[1m]')).toBe('Opus 4.1 1M');
    expect(modelDisplayName('gpt-6-sol')).toBe('GPT-6 Sol');
    expect(modelDisplayName('gpt-5-codex')).toBe('GPT-5 Codex');
    expect(modelDisplayName('deepseek-flash')).toBe('deepseek-flash');
  });

  test('pill labels drop the catalogue parenthetical and name the default plainly', () => {
    const options = [{ value: 'opus[1m]', label: 'Opus (1M context)' }, { value: 'sonnet', label: 'Sonnet (fast)' }];
    expect(modelShortLabel('opus[1m]', options)).toBe('Opus 1M');
    expect(modelShortLabel('sonnet', options)).toBe('Sonnet');
    expect(modelShortLabel('default', options)).toBe('默认');
    expect(modelShortLabel('gpt-5.5', [])).toBe('GPT-5.5');
  });

  test('pill labels name the row a legacy value now means, with the 1M window when it is on', () => {
    expect(modelShortLabel('claude-opus-5-5', CLAUDE)).toBe('Opus 5.5');
    expect(modelShortLabel('claude-opus-5-5[1m]', CLAUDE)).toBe('Opus 5.5 1M');
    expect(modelShortLabel('opus[1m]', CLAUDE)).toBe('Opus 5.5 1M');
    expect(modelShortLabel('default', CLAUDE)).toBe('Opus 5.5');
    expect(modelShortLabel('best', CLAUDE)).toBe('Fable 5.1');
    // Haiku has no 1M window: the suffix is dropped rather than promised.
    expect(modelShortLabel('haiku[1m]', CLAUDE)).toBe('Haiku 4.5');
  });

  test('providers and permission modes use the same words everywhere', () => {
    expect(providerLabel('claude')).toBe('Claude Code');
    expect(providerLabel('deepseek')).toBe('DeepSeek');
    expect(permissionModeCopy('bypassPermissions').label).toBe('全部放行');
    expect(permissionModeCopy('unknown').label).toBe('每次询问');
  });
});
