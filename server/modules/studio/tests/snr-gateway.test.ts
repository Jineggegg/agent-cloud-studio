import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

import { AppError } from '@/shared/utils.js';

import { createSnrGateway } from '../snr-gateway.service.js';

const SESSION = '0f8e2a4c-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
type Call = { url: string; method?: string; headers: Record<string, string> };

// A gateway over a fake SNR that records every forwarded request.
function recordingGateway(options: { authorization?: () => string | null; contentType?: string; body?: string } = {}) {
  const calls: Call[] = [];
  const gateway = createSnrGateway({
    baseUrl: 'http://127.0.0.1:8768', validUser: () => true, authorization: options.authorization ?? (() => null),
    request: (async (input: URL, init: RequestInit) => {
      calls.push({ url: String(input), method: init.method, headers: { ...(init.headers as Record<string, string>) } });
      return new Response(options.body ?? '{"ok":true}', { headers: { 'Content-Type': options.contentType ?? 'application/json' } });
    }) as unknown as typeof fetch,
  });
  return { gateway, calls, signal: new AbortController().signal };
}

test('only fixed loopback services can be connected', () => {
  assert.throws(() => createSnrGateway({ baseUrl: 'https://example.com', validUser: () => true }), /fixed loopback/);
});

test('a grant is short lived, unpredictable and tied to an active user', () => {
  let valid = true;
  const gateway = createSnrGateway({ baseUrl: 'http://127.0.0.1:8768', validUser: () => valid });
  const grant = gateway.grant(1);
  assert.equal(grant.key.length, 64);
  assert.equal(gateway.authorized(undefined), false);
  assert.equal(gateway.authorized('wrong'), false);
  assert.equal(gateway.authorized(grant.key), true);
  gateway.revoke(1);
  assert.equal(gateway.authorized(grant.key), false);
  const second = gateway.grant(1);
  valid = false;
  assert.equal(gateway.authorized(second.key), false);
});

test('proxy does not allow arbitrary destinations or application endpoints', async () => {
  const gateway = createSnrGateway({ baseUrl: 'http://127.0.0.1:8768', validUser: () => true });
  const signal = new AbortController().signal;
  await assert.rejects(gateway.proxy('https://example.com/api/health', 'GET', undefined, undefined, signal), /不可用/);
  await assert.rejects(gateway.proxy('/api/private', 'GET', undefined, undefined, signal), /不可用/);
  await assert.rejects(gateway.proxy('/static/../../secret', 'GET', undefined, undefined, signal), /不可用/);
});

test('annotation edits use PUT on API paths, while non-API writes and unknown verbs stay blocked', async () => {
  const { gateway, calls, signal } = recordingGateway();
  const result = await gateway.proxy('/api/sessions/s1/levels/7', 'PUT', '{"price":1}', 'application/json', signal);
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(({ url, method, headers }) => ({ url, method, origin: headers.Origin })), [
    { url: 'http://127.0.0.1:8768/api/sessions/s1/levels/7', method: 'PUT', origin: 'http://127.0.0.1:8768' },
  ]);
  await assert.rejects(gateway.proxy('/replay', 'PUT', '{}', 'application/json', signal), /不允许/);
  await assert.rejects(gateway.proxy('/api/sessions/s1', 'TRACE', undefined, undefined, signal), /不允许/);
});

test('read-only integration endpoints pass for GET and HEAD with their query intact', async () => {
  const { gateway, calls, signal } = recordingGateway();
  const context = `/api/integration/v1/sessions/${SESSION}/context?expected_as_of=2026-01-02T03:04:00Z&expected_timeframe=M5`;
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await gateway.proxy('/api/integration/v1/manifest', method, undefined, undefined, signal)).status, 200);
    assert.equal((await gateway.proxy(context, method, undefined, undefined, signal)).status, 200);
  }
  assert.deepEqual(calls.map(({ url, method }) => `${method} ${url}`), [
    'GET http://127.0.0.1:8768/api/integration/v1/manifest',
    `GET http://127.0.0.1:8768${context}`,
    'HEAD http://127.0.0.1:8768/api/integration/v1/manifest',
    `HEAD http://127.0.0.1:8768${context}`,
  ]);
});

test('integration endpoints reject writes, other verbs and loose session ids before reaching SNR', async () => {
  const { gateway, calls, signal } = recordingGateway();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    for (const target of ['/api/integration/v1/manifest', `/api/integration/v1/sessions/${SESSION}/context`]) {
      await assert.rejects(gateway.proxy(target, method, '{}', 'application/json', signal), (error: AppError) => error.statusCode === 405);
    }
  }
  for (const target of [
    `/api/integration/v1/sessions/${SESSION.toUpperCase()}/context`,
    '/api/integration/v1/sessions/not-a-uuid/context',
    `/api/integration/v1/sessions/${SESSION.slice(0, -1)}/context`,
    `/api/integration/v1/sessions/${SESSION}x/context`,
    `/api/integration/v1/sessions/${SESSION}/context/`,
    `/api/integration/v1/sessions/${SESSION}/context/extra`,
    `/api/integration/v1/sessions/${SESSION}`,
    '/api/integration/v1/manifest/',
    '/api/integration/v1/other',
    '/api/integration/v2/manifest',
    '/api/integration',
  ]) {
    await assert.rejects(gateway.proxy(target, 'GET', undefined, undefined, signal), (error: AppError) => error.statusCode === 404, target);
  }
  assert.equal(calls.length, 0);
});

test('existing lab routes keep their rules next to the integration endpoints', async () => {
  const { gateway, calls, signal } = recordingGateway();
  await gateway.proxy('/replay', 'GET', undefined, undefined, signal);
  await gateway.proxy('/static/pcm-capture.js', 'GET', undefined, undefined, signal);
  await gateway.proxy('/api/sessions', 'POST', '{}', 'application/json', signal);
  await gateway.proxy('/api/speech/streams/abc', 'DELETE', undefined, undefined, signal);
  await assert.rejects(gateway.proxy('/static/style.css', 'POST', '{}', 'application/json', signal), (error: AppError) => error.statusCode === 405);
  assert.equal(calls.length, 4);
});

test('HTML keeps lab assets and API traffic inside the protected gateway', async () => {
  const { gateway, signal } = recordingGateway({
    contentType: 'text/html', body: '<html><head><script defer src="/static/replay.js"></script></head><body>Lab</body></html>',
  });
  const body = (await gateway.proxy('/replay', 'GET', undefined, undefined, signal)).body.toString();
  assert.ok(body.includes('src="/api/studio/snr-site/static/replay.js"'));
  assert.ok(body.indexOf('studioFetch') < body.indexOf('defer'));
  assert.ok(body.includes("url.pathname.startsWith('/api/')"));
  assert.ok(body.includes('AudioWorklet.prototype.addModule'));
});

// Runs the injected bridge in a sandbox with recording stand-ins for the browser APIs it wraps.
async function runBridge() {
  const { gateway, signal } = recordingGateway({ contentType: 'text/html; charset=utf-8', body: '<html><head></head><body></body></html>' });
  const html = (await gateway.proxy('/replay', 'GET', undefined, undefined, signal)).body.toString();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'bridge script is injected');
  const seen: Record<'fetch' | 'xhr' | 'beacon' | 'worklet' | 'worker', string[]> = { fetch: [], xhr: [], beacon: [], worklet: [], worker: [] };
  class FakeRequest { constructor(readonly url: string) {} }
  class FakeAudioWorklet { addModule(url: unknown) { seen.worklet.push(String(url)); return Promise.resolve(); } }
  class FakeXMLHttpRequest { open(_method: string, url: unknown) { seen.xhr.push(String(url)); } }
  class FakeWorker { constructor(url: unknown) { seen.worker.push(String(url)); } }
  const window: Record<string, unknown> = {
    fetch: (input: unknown) => { seen.fetch.push(String(input)); return Promise.resolve(); },
    AudioWorklet: FakeAudioWorklet, Worker: FakeWorker,
  };
  const navigator = { sendBeacon: (url: unknown) => { seen.beacon.push(String(url)); return true; } };
  vm.runInNewContext(script, {
    window, navigator, URL, Request: FakeRequest, XMLHttpRequest: FakeXMLHttpRequest, AudioWorklet: FakeAudioWorklet,
    location: { href: 'https://studio.example/api/studio/snr-site/replay?session=s1', origin: 'https://studio.example' },
  });
  return { window, navigator, seen, FakeAudioWorklet, FakeXMLHttpRequest };
}

test('the bridge rebases dictation worklets and runtime lab URLs, and leaves everything else alone', async () => {
  const { window, navigator, seen, FakeAudioWorklet, FakeXMLHttpRequest } = await runBridge();
  // SNR's dictation: context.audioWorklet.addModule("/static/pcm-capture.js").
  await new FakeAudioWorklet().addModule('/static/pcm-capture.js');
  const fetch = window.fetch as (input: unknown) => Promise<unknown>;
  for (const input of ['/api/speech/status', '/static/vendor/charts.js', '/api/studio/snr-site/api/health', 'https://cdn.example/static/x.js', '/assets/app.js']) {
    await fetch(input);
  }
  new FakeXMLHttpRequest().open('GET', '/api/datasets');
  navigator.sendBeacon('/api/speech/streams/abc');
  new (window.Worker as new (url: string) => unknown)('/static/worker.js');
  const origin = 'https://studio.example/api/studio/snr-site';
  assert.deepEqual(seen.worklet, [`${origin}/static/pcm-capture.js`]);
  assert.deepEqual(seen.fetch, [
    `${origin}/api/speech/status`, `${origin}/static/vendor/charts.js`,
    '/api/studio/snr-site/api/health', 'https://cdn.example/static/x.js', '/assets/app.js',
  ]);
  assert.deepEqual(seen.xhr, [`${origin}/api/datasets`]);
  assert.deepEqual(seen.beacon, [`${origin}/api/speech/streams/abc`]);
  assert.deepEqual(seen.worker, [`${origin}/static/worker.js`]);
});

test('stylesheets served through the gateway point their lab assets at the gateway', async () => {
  const css = [
    '@font-face { src: url(/static/fonts/a.woff2) format("woff2"); }',
    '.b { background: url("/static/b.png"); }',
    ".c { mask: url( '/static/c.svg' ); }",
    '@import "/static/d.css";',
    '.e { background: url(data:image/png;base64,AAAA); }',
    '.f { background: url(https://cdn.example/static/f.png); }',
  ].join('\n');
  const { gateway, signal } = recordingGateway({ contentType: 'text/css; charset=utf-8', body: css });
  const body = (await gateway.proxy('/static/style.css', 'GET', undefined, undefined, signal)).body.toString();
  assert.ok(body.includes('url(/api/studio/snr-site/static/fonts/a.woff2)'));
  assert.ok(body.includes('url("/api/studio/snr-site/static/b.png")'));
  assert.ok(body.includes("url( '/api/studio/snr-site/static/c.svg' )"));
  assert.ok(body.includes('@import "/api/studio/snr-site/static/d.css";'));
  assert.ok(body.includes('url(data:image/png;base64,AAAA)'));
  assert.ok(body.includes('url(https://cdn.example/static/f.png)'));
  // Scripts are passed through byte for byte.
  const script = recordingGateway({ contentType: 'text/javascript', body: 'fetch("/static/x")' });
  assert.equal((await script.gateway.proxy('/static/app.js', 'GET', undefined, undefined, script.signal)).body.toString(), 'fetch("/static/x")');
});

test('a configured SNR credential is attached to every forwarded request', async () => {
  const credential = 'Basic dW5pdC10ZXN0OmZha2UtcGFzc3dvcmQ=';
  const { gateway, calls, signal } = recordingGateway({ authorization: () => credential });
  await gateway.proxy('/api/integration/v1/manifest', 'GET', undefined, undefined, signal);
  await gateway.proxy('/api/sessions/s1/levels/7', 'PUT', '{}', 'application/json', signal);
  assert.deepEqual(calls.map(call => call.headers.Authorization), [credential, credential]);
  const open = recordingGateway();
  await open.gateway.proxy('/api/health', 'GET', undefined, undefined, open.signal);
  assert.equal('Authorization' in open.calls[0].headers, false);
});

test('an unusable SNR credential fails closed without contacting SNR', async () => {
  const { gateway, calls, signal } = recordingGateway({
    authorization: () => { throw new AppError('SNR 认证配置不可用', { statusCode: 503 }); },
  });
  await assert.rejects(gateway.proxy('/api/health', 'GET', undefined, undefined, signal), (error: AppError) => error.statusCode === 503);
  assert.equal(calls.length, 0);
});

test('by default the credential comes from STUDIO_SNR_USER and the password file, read per request', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'snr-auth-'));
  const passwordFile = path.join(directory, 'password');
  const previous = { user: process.env.STUDIO_SNR_USER, file: process.env.STUDIO_SNR_PASSWORD_FILE };
  const headers: (string | undefined)[] = [];
  const gateway = createSnrGateway({
    baseUrl: 'http://127.0.0.1:8768', validUser: () => true,
    request: (async (_input: URL, init: RequestInit) => {
      headers.push((init.headers as Record<string, string>).Authorization);
      return Response.json({ status: 'ok' });
    }) as unknown as typeof fetch,
  });
  const signal = new AbortController().signal;
  try {
    process.env.STUDIO_SNR_USER = 'unit-test';
    process.env.STUDIO_SNR_PASSWORD_FILE = passwordFile;
    writeFileSync(passwordFile, 'first-fake-password\n');
    await gateway.proxy('/api/health', 'GET', undefined, undefined, signal);
    writeFileSync(passwordFile, 'second-fake-password\n');
    await gateway.proxy('/api/health', 'GET', undefined, undefined, signal);
    assert.deepEqual(headers, [
      `Basic ${Buffer.from('unit-test:first-fake-password').toString('base64')}`,
      `Basic ${Buffer.from('unit-test:second-fake-password').toString('base64')}`,
    ]);
  } finally {
    for (const [key, value] of [['STUDIO_SNR_USER', previous.user], ['STUDIO_SNR_PASSWORD_FILE', previous.file]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true });
  }
});
