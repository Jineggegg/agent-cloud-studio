import { describe, expect, test } from 'vitest';

import { modelDisplayName, modelShortLabel, permissionModeCopy, providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

describe('workbench chat wording', () => {
  test('reported model ids read as plain names; unknown shapes pass through', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelDisplayName('claude-opus-4-1[1m]')).toBe('Opus 4.1');
    expect(modelDisplayName('gpt-5-codex')).toBe('gpt-5-codex');
    expect(modelDisplayName('deepseek-flash')).toBe('deepseek-flash');
  });

  test('pill labels drop the catalogue parenthetical and name the default plainly', () => {
    const options = [{ value: 'opus[1m]', label: 'Opus (1M context)' }, { value: 'sonnet', label: 'Sonnet (fast)' }];
    expect(modelShortLabel('opus[1m]', options)).toBe('Opus 1M');
    expect(modelShortLabel('sonnet', options)).toBe('Sonnet');
    expect(modelShortLabel('default', options)).toBe('默认');
    expect(modelShortLabel('gpt-5', [])).toBe('gpt-5');
  });

  test('providers and permission modes use the same words everywhere', () => {
    expect(providerLabel('claude')).toBe('Claude Code');
    expect(providerLabel('deepseek')).toBe('DeepSeek');
    expect(permissionModeCopy('bypassPermissions').label).toBe('全部放行');
    expect(permissionModeCopy('unknown').label).toBe('每次询问');
  });
});
