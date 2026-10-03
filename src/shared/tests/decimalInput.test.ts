import assert from 'node:assert/strict';

import { test } from 'vitest';

import { decimalInputProblem, parseDecimalInput } from '@/shared/utils';

test('parses positive decimal text with a bounded number of decimals, accepting a comma', () => {
  assert.equal(parseDecimalInput('12.5', 2), 12.5);
  assert.equal(parseDecimalInput(' 12,25 ', 2), 12.25);
  assert.equal(parseDecimalInput('.5', 2), 0.5);
  assert.equal(parseDecimalInput('7.', 2), 7);
  for (const text of ['', '0', '-1', '1e3', '1,000.5', 'abc', '12.345', 'Infinity']) {
    assert.equal(parseDecimalInput(text, 2), null, text);
  }
});

test('explains why text is not a valid amount, and stays quiet while empty or valid', () => {
  assert.equal(decimalInputProblem('', 2, '单笔上限'), '');
  assert.equal(decimalInputProblem('250', 2, '单笔上限'), '');
  assert.equal(decimalInputProblem('250.123', 2, '单笔上限'), '单笔上限最多 2 位小数');
  assert.equal(decimalInputProblem('0', 2, '每日上限'), '每日上限必须是大于 0 的数字');
  assert.equal(decimalInputProblem('abc', 6, '数量'), '数量必须是大于 0 的数字');
});
