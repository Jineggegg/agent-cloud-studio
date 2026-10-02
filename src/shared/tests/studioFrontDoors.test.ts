import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { buildHandoffUrl, readIngressPreference, takeHandoffCodeFromUrl, writeIngressPreference } from '@/shared/utils';

/**
 * Helpers for switching between Studio's two front doors (docs/network.md): the handoff code
 * travels in a query parameter that the target page removes before anything else reads the URL,
 * and the preferred door is remembered per origin.
 */

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('buildHandoffUrl keeps the current path and query on the target origin', () => {
  assert.equal(
    buildHandoffUrl('https://studio.ajarche.com', 'abc_DEF-123', { pathname: '/apps/connections', search: '?tab=1' }),
    'https://studio.ajarche.com/apps/connections?tab=1&handoff=abc_DEF-123',
  );
  // A stale code in the current address is replaced, not duplicated.
  assert.equal(
    buildHandoffUrl('https://laptop.tail6e45f0.ts.net:8443', 'new', { pathname: '/', search: '?handoff=old' }),
    'https://laptop.tail6e45f0.ts.net:8443/?handoff=new',
  );
});

test('takeHandoffCodeFromUrl returns the code once and leaves the rest of the address intact', () => {
  window.history.replaceState({ keep: true }, '', '/projects/p1?view=mail&handoff=code-1#top');

  assert.equal(takeHandoffCodeFromUrl(), 'code-1');
  assert.equal(`${window.location.pathname}${window.location.search}${window.location.hash}`, '/projects/p1?view=mail#top');
  assert.deepEqual(window.history.state, { keep: true });
  assert.equal(takeHandoffCodeFromUrl(), null);

  window.history.replaceState(null, '', '/?handoff=');
  assert.equal(takeHandoffCodeFromUrl(), null);
  assert.equal(window.location.search, '');
});

test('the ingress preference round-trips and ignores unknown values', () => {
  assert.equal(readIngressPreference(), null);
  writeIngressPreference('tailnet');
  assert.equal(localStorage.getItem('studio-ingress-v1'), 'tailnet');
  assert.equal(readIngressPreference(), 'tailnet');
  localStorage.setItem('studio-ingress-v1', 'elsewhere');
  assert.equal(readIngressPreference(), null);
});

test('an unavailable localStorage never breaks the preference helpers', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  assert.equal(readIngressPreference(), null);
  assert.doesNotThrow(() => writeIngressPreference('public'));
});
