import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatT212CapAmount, formatT212CapChange } from '@/shared/utils';

test('formats a cap in the account currency, or marks the bare number while the currency is unknown', () => {
  assert.equal(formatT212CapAmount(250, 'GBP'), '£250.00');
  assert.equal(formatT212CapAmount(10_000, 'GBP'), '£10,000.00');
  assert.equal(formatT212CapAmount(1234.5, undefined), '1,234.5（账户货币）');
  // Not a currency Intl knows: the number and the code as they are.
  assert.equal(formatT212CapAmount(12, 'NOT-A-CODE'), '12 NOT-A-CODE');
});

test('shows a cap moving between two values, or just the value when it stays', () => {
  assert.equal(formatT212CapChange(250, 400, 'GBP'), '£250.00 → £400.00');
  assert.equal(formatT212CapChange(1000, 1000, 'GBP'), '£1,000.00');
});
