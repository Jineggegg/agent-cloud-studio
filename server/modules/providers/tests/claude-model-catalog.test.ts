import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { resolveProviderModelSelection } from '@/shared/utils.js';

const resolve = (value: string) => resolveProviderModelSelection(CLAUDE_PREDEFINED_MODELS, value);

test('lists one row per family at its concrete version, newest first', () => {
  assert.deepEqual(
    CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => [option.value, option.label]),
    [
      ['claude-fable-5-1', 'Fable 5.1'],
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5'],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ],
  );
  for (const option of CLAUDE_PREDEFINED_MODELS.OPTIONS) {
    assert.ok(option.description && /[一-鿿]/.test(option.description), `${option.value} has a Chinese description`);
  }
});

test('the default is the recommended row, and only it is recommended', () => {
  const recommended = CLAUDE_PREDEFINED_MODELS.OPTIONS.filter((option) => option.recommended);
  assert.deepEqual(recommended.map((option) => option.value), ['claude-opus-5-5']);
  assert.equal(CLAUDE_PREDEFINED_MODELS.DEFAULT, 'claude-opus-5-5');
});

test('the 1M context window is a variant of each family that has one, not a row', () => {
  assert.deepEqual(
    CLAUDE_PREDEFINED_MODELS.OPTIONS.map((option) => option.longContextValue ?? null),
    ['claude-fable-5-1[1m]', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5[1m]', null],
  );
  assert.ok(!CLAUDE_PREDEFINED_MODELS.OPTIONS.some((option) => option.value.endsWith('[1m]')));
});

test('saved selections from the old alias catalog resolve to the row that replaced them', () => {
  const cases: [string, string, boolean][] = [
    ['default', 'claude-opus-5-5', false],
    ['best', 'claude-fable-5-1', false],
    ['fable', 'claude-fable-5-1', false],
    ['opus', 'claude-opus-5-5', false],
    ['opusplan', 'claude-opus-5-5', false],
    ['opus[1m]', 'claude-opus-5-5[1m]', true],
    ['sonnet', 'claude-sonnet-5-5', false],
    ['sonnet[1m]', 'claude-sonnet-5-5[1m]', true],
    ['haiku', 'claude-haiku-4-5-20251001', false],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', false],
    // The pinned ids the old catalog also listed are the new rows themselves.
    ['claude-opus-5-5', 'claude-opus-5-5', false],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5[1m]', true],
    ['  Opus  ', 'claude-opus-5-5', false],
  ];
  for (const [saved, model, longContext] of cases) {
    const resolved = resolve(saved);
    assert.equal(resolved?.model, model, saved);
    assert.equal(resolved?.longContext, longContext, saved);
  }
});

test('a 1M request on a model without a 1M window runs the plain model', () => {
  const resolved = resolve('haiku[1m]');
  assert.equal(resolved?.model, 'claude-haiku-4-5-20251001');
  assert.equal(resolved?.longContext, false);
});

test('legacy values keep the effort levels of the model they now run as', () => {
  for (const saved of ['opus', 'opus[1m]', 'default', 'best', 'sonnet[1m]']) {
    const efforts = resolve(saved)?.option.effort?.values.map((effort) => effort.value);
    assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], saved);
  }
  assert.equal(resolve('haiku')?.option.effort, undefined);
});

test('ids outside the catalog are left for the caller to pass through', () => {
  assert.equal(resolve('claude-opus-4-8'), null);
  assert.equal(resolve(''), null);
  assert.equal(resolveProviderModelSelection(CLAUDE_PREDEFINED_MODELS, undefined), null);
});
