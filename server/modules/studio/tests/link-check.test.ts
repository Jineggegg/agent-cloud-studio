import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLinkChecker } from '../link-check.service.js';

test('link checks report status and frameability without reading bodies, and cache results', async () => {
  const calls: string[] = [];
  const checker = createLinkChecker({
    request: (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (url.includes('denied')) return new Response(null, { status: 200, headers: { 'X-Frame-Options': 'DENY' } });
      if (url.includes('csp')) return new Response(null, { status: 200, headers: { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" } });
      if (url.includes('nohead')) return new Response(null, { status: init.method === 'HEAD' ? 405 : 200 });
      if (url.includes('down')) throw new Error('ECONNREFUSED');
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  });
  const result = await checker.check([
    { label: 'a', url: 'https://open.test/' }, { label: 'b', url: 'https://denied.test/' },
    { label: 'c', url: 'https://csp.test/' }, { label: 'd', url: 'https://nohead.test/' }, { label: 'e', url: 'https://down.test/' },
  ]);
  assert.deepEqual(result.map(item => [item.ok, item.status, item.frameable]), [
    [true, 200, true], [true, 200, false], [true, 200, false], [true, 200, true], [false, null, false],
  ]);
  assert.ok(calls.includes('GET https://nohead.test/'));
  const before = calls.length;
  await checker.check([{ label: 'a', url: 'https://open.test/' }]);
  assert.equal(calls.length, before);
});
