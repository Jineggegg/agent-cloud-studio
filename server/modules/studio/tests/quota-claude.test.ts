import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { recordClaudeRateLimitEvent } from '@/shared/utils.js';

import { createClaudeUsageReader, readClaudeQuota } from '../quota/claude-quota.adapter.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const seconds = (ms: number) => Math.round(ms / 1000);

function snapshotFile() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'claude-quota-test-'));
  return { directory, file: path.join(directory, 'studio-rate-limits.json') };
}

test('a missing snapshot explains how to enable it and a malformed one is unavailable', async () => {
  const { directory, file } = snapshotFile();
  try {
    const missing = await readClaudeQuota({ snapshotFile: file, now: NOW });
    assert.equal(missing.available, false);
    assert.equal(missing.source, 'unavailable');
    assert.match(missing.note ?? '', /statusLine/);
    writeFileSync(file, '{not json');
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).available, false);
    writeFileSync(file, JSON.stringify({ observedAt: new Date(NOW).toISOString(), source: 'statusline' }));
    const empty = await readClaudeQuota({ snapshotFile: file, now: NOW });
    assert.equal(empty.available, false);
    assert.match(empty.note ?? '', /API 密钥/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('oversized files and anything but a regular file are refused without being read', async () => {
  const { directory, file } = snapshotFile();
  try {
    writeFileSync(file, `{"observedAt":"x","pad":"${'x'.repeat(70 * 1024)}"}`);
    assert.match((await readClaudeQuota({ snapshotFile: file, now: NOW })).note ?? '', /过大/);
    assert.match((await readClaudeQuota({ snapshotFile: directory, now: NOW })).note ?? '', /不是普通文件/);
    // A FIFO or device at the configured path used to hang the read (and the shared cache) forever.
    if (process.platform !== 'win32') {
      const device = await readClaudeQuota({ snapshotFile: '/dev/zero', now: NOW });
      assert.equal(device.available, false);
      assert.match(device.note ?? '', /不是普通文件/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('statusline snapshots map to 5-hour and weekly windows with staleness rules', async () => {
  const { directory, file } = snapshotFile();
  try {
    const fresh = {
      observedAt: new Date(NOW - 60_000).toISOString(), source: 'statusline',
      five_hour: { used_percentage: 42.04, resets_at: seconds(NOW + 3_600_000) },
      seven_day: { used_percentage: 18, resets_at: seconds(NOW + 86_400_000) },
    };
    writeFileSync(file, JSON.stringify(fresh));
    assert.deepEqual(await readClaudeQuota({ snapshotFile: file, now: NOW }), {
      provider: 'claude', available: true, balances: [], source: 'statusline',
      observedAt: new Date(NOW - 60_000).toISOString(), stale: false,
      windows: [
        { id: 'five_hour', label: '5 小时', usedPercent: 42, windowMinutes: 300, resetsAt: new Date(NOW + 3_600_000).toISOString() },
        { id: 'seven_day', label: '每周', usedPercent: 18, windowMinutes: 10080, resetsAt: new Date(NOW + 86_400_000).toISOString() },
      ],
    });

    writeFileSync(file, JSON.stringify({ ...fresh, five_hour: { used_percentage: 90, resets_at: seconds(NOW - 1000) } }));
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).stale, true, 'a passed reset makes the reading stale');

    writeFileSync(file, JSON.stringify({ ...fresh, observedAt: new Date(NOW - 7 * 3_600_000).toISOString() }));
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).stale, true, 'readings older than six hours are stale');

    writeFileSync(file, JSON.stringify({ ...fresh, seven_day: { ...fresh.seven_day, observed_at: new Date(NOW - 2 * 86_400_000).toISOString() } }));
    assert.equal((await readClaudeQuota({ snapshotFile: file, now: NOW })).stale, true, 'an old weekly window is not hidden by a fresh top-level time');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('snapshots written from SDK rate_limit_event are read back as sdk-event windows', async () => {
  const { directory, file } = snapshotFile();
  try {
    await recordClaudeRateLimitEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.25, resetsAt: seconds(NOW + 600_000) }, { filePath: file, now: () => NOW });
    await recordClaudeRateLimitEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.81, resetsAt: seconds(NOW + 86_400_000) }, { filePath: file, now: () => NOW });
    const snapshot = await readClaudeQuota({ snapshotFile: file, now: NOW + 1000 });
    assert.equal(snapshot.source, 'sdk-event');
    assert.equal(snapshot.stale, false);
    assert.deepEqual(snapshot.windows.map(window => [window.id, window.usedPercent]), [['five_hour', 25], ['seven_day', 81]]);

    // An account already over its 5-hour limit reports utilization above 1.
    await recordClaudeRateLimitEvent({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1.04, resetsAt: seconds(NOW + 600_000) }, { filePath: file, now: () => NOW });
    const limited = await readClaudeQuota({ snapshotFile: file, now: NOW + 1000 });
    assert.equal(limited.windows.find(window => window.id === 'five_hour')?.usedPercent, 100);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

// ── Live usage read with the machine's Claude login (createClaudeUsageReader) ──

const TOKEN = 'sk-ant-oat01-NEVER-SHOWN-test-token-7f3a9c';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const VALID_LOGIN = { claudeAiOauth: { accessToken: TOKEN, refreshToken: 'refresh-not-used', expiresAt: NOW + 3_600_000 } };

type UsageCall = { url: string; init: RequestInit | undefined };

// A temp directory with a credentials file (unless `credentials` is null) and a snapshot path.
function loginFixture(credentials: unknown = VALID_LOGIN) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'claude-usage-test-'));
  const credentialsFile = path.join(directory, '.credentials.json');
  const snapshotFile = path.join(directory, 'studio-rate-limits.json');
  if (credentials !== null) writeFileSync(credentialsFile, typeof credentials === 'string' ? credentials : JSON.stringify(credentials));
  return { directory, credentialsFile, snapshotFile };
}

function writeStatuslineSnapshot(file: string) {
  writeFileSync(file, JSON.stringify({
    observedAt: new Date(NOW - 60_000).toISOString(), source: 'statusline',
    five_hour: { used_percentage: 5, resets_at: seconds(NOW + 3_600_000) },
  }));
}

// A fake fetch that records every call and answers with `respond`.
function fakeFetch(respond: (call: UsageCall) => Promise<Response> | Response) {
  const calls: UsageCall[] = [];
  const request = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, request };
}

// Collects everything written through console during `run`, to prove the token never reaches a log.
async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map(name => console[name]);
  const describe = (part: unknown) => part instanceof Error ? `${part.message} ${part.stack ?? ''}` : typeof part === 'string' ? part : JSON.stringify(part);
  for (const name of methods) console[name] = (...parts: unknown[]) => { lines.push(parts.map(describe).join(' ')); };
  try {
    return { result: await run(), output: lines.join('\n') };
  } finally {
    methods.forEach((name, index) => { console[name] = originals[index]; });
  }
}

test('usage API figures map to the 5-hour and weekly windows, cached for a minute with one request in flight', async () => {
  const { directory, credentialsFile, snapshotFile } = loginFixture();
  let clock = NOW;
  const { calls, request } = fakeFetch(() => Response.json({
    five_hour: { utilization: 42.04, resets_at: '2026-10-02T13:59:59.943648+00:00' },
    seven_day: { utilization: 18, resets_at: null },
    seven_day_opus: { utilization: 3, resets_at: null },
    seven_day_oauth_apps: null,
    some_future_field: { anything: true },
  }));
  try {
    const usage = createClaudeUsageReader({ credentialsFile, enabled: true, request, now: () => clock });
    const [first, concurrent] = await Promise.all([
      readClaudeQuota({ snapshotFile, now: clock, usage }),
      readClaudeQuota({ snapshotFile, now: clock, usage }),
    ]);
    assert.deepEqual(first, {
      provider: 'claude', available: true, balances: [], source: 'usage-api',
      observedAt: new Date(NOW).toISOString(), stale: false,
      windows: [
        { id: 'five_hour', label: '5 小时', usedPercent: 42, windowMinutes: 300, resetsAt: '2026-10-02T13:59:59.943Z' },
        { id: 'seven_day', label: '每周', usedPercent: 18, windowMinutes: 10080, resetsAt: null },
      ],
    });
    assert.deepEqual(concurrent, first);
    assert.equal(calls.length, 1, 'concurrent readers share one request');
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(calls[0].url, USAGE_URL);
    assert.equal(calls[0].init?.method, 'GET');
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get('anthropic-beta'), 'oauth-2025-04-20');
    assert.ok(calls[0].init?.signal instanceof AbortSignal);

    clock += 59_000;
    await readClaudeQuota({ snapshotFile, now: clock, usage });
    assert.equal(calls.length, 1, 'served from memory within a minute');
    clock += 2_000;
    await readClaudeQuota({ snapshotFile, now: clock, usage });
    assert.equal(calls.length, 2, 'asked again after a minute');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an expired login is not used (and never refreshed): the snapshot is shown instead', async () => {
  const { directory, credentialsFile, snapshotFile } = loginFixture({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'refresh-not-used', expiresAt: NOW - 1000 } });
  const { calls, request } = fakeFetch(() => Response.json({}));
  try {
    const usage = createClaudeUsageReader({ credentialsFile, enabled: true, request, now: () => NOW });
    const missing = await readClaudeQuota({ snapshotFile, now: NOW, usage });
    assert.equal(missing.available, false);
    assert.match(missing.note ?? '', /登录已过期/);
    assert.match(missing.note ?? '', /statusLine/);
    writeStatuslineSnapshot(snapshotFile);
    const fallback = await readClaudeQuota({ snapshotFile, now: NOW, usage });
    assert.equal(fallback.source, 'statusline');
    assert.equal(fallback.windows[0].usedPercent, 5);
    assert.match(fallback.note ?? '', /登录已过期/);
    assert.equal(calls.length, 0, 'no request with an expired token');
    assert.deepEqual(JSON.parse(readFileSync(credentialsFile, 'utf8')).claudeAiOauth.expiresAt, NOW - 1000, 'the credentials file is left as it was');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a missing login, an API-key login or STUDIO_CLAUDE_USAGE_API=off fall back to the snapshot without a request', async () => {
  const { calls, request } = fakeFetch(() => Response.json({}));
  const signedOut = loginFixture(null);
  const apiKeyOnly = loginFixture({ primaryApiKey: 'not-an-oauth-login' });
  const disabled = loginFixture();
  try {
    writeStatuslineSnapshot(signedOut.snapshotFile);
    const reader = (credentialsFile: string, enabled = true) => createClaudeUsageReader({ credentialsFile, enabled, request, now: () => NOW });
    const noLogin = await readClaudeQuota({ snapshotFile: signedOut.snapshotFile, now: NOW, usage: reader(signedOut.credentialsFile) });
    assert.equal(noLogin.source, 'statusline', 'a missing credentials file falls back to the snapshot');
    assert.match(noLogin.note ?? '', /没有 Claude 登录/);

    const apiKey = await readClaudeQuota({ snapshotFile: apiKeyOnly.snapshotFile, now: NOW, usage: reader(apiKeyOnly.credentialsFile) });
    assert.equal(apiKey.available, false);
    assert.match(apiKey.note ?? '', /API 密钥/);

    const off = await readClaudeQuota({ snapshotFile: disabled.snapshotFile, now: NOW, usage: reader(disabled.credentialsFile, false) });
    assert.match(off.note ?? '', /STUDIO_CLAUDE_USAGE_API=off/);
    assert.equal(calls.length, 0);
  } finally {
    for (const fixture of [signedOut, apiKeyOnly, disabled]) rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('a 401 backs off for five minutes, unless the CLI stores a new login meanwhile', async () => {
  const { directory, credentialsFile, snapshotFile } = loginFixture();
  let clock = NOW;
  let status = 401;
  const { calls, request } = fakeFetch(() => status === 200
    ? Response.json({ five_hour: { utilization: 7, resets_at: null }, seven_day: null })
    : new Response('{"error":{"type":"authentication_error"}}', { status }));
  try {
    writeStatuslineSnapshot(snapshotFile);
    const usage = createClaudeUsageReader({ credentialsFile, enabled: true, request, now: () => clock });
    const { result: refused, output } = await captureConsole(() => readClaudeQuota({ snapshotFile, now: clock, usage }));
    assert.equal(refused.source, 'statusline');
    assert.match(refused.note ?? '', /未被接受/);
    assert.match(output, /returned 401/);
    assert.equal(calls.length, 1);

    clock += 4 * 60_000;
    await readClaudeQuota({ snapshotFile, now: clock, usage });
    assert.equal(calls.length, 1, 'no request during the backoff');

    clock += 61_000;
    await captureConsole(() => readClaudeQuota({ snapshotFile, now: clock, usage }));
    assert.equal(calls.length, 2, 'tried again after five minutes');

    // The CLI refreshed the login (new token, new expiry): the earlier refusal no longer applies.
    status = 200;
    writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: `${TOKEN}-renewed`, expiresAt: clock + 7_200_000 } }));
    const renewed = await readClaudeQuota({ snapshotFile, now: clock, usage });
    assert.equal(renewed.source, 'usage-api');
    assert.equal(calls.length, 3);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('429 and 5xx answers back off too, and a 429 may ask for longer', async () => {
  const { directory, credentialsFile, snapshotFile } = loginFixture();
  let clock = NOW;
  let next = () => new Response('busy', { status: 429, headers: { 'retry-after': '900' } });
  const { calls, request } = fakeFetch(() => next());
  try {
    const usage = createClaudeUsageReader({ credentialsFile, enabled: true, request, now: () => clock });
    const limited = (await captureConsole(() => readClaudeQuota({ snapshotFile, now: clock, usage }))).result;
    assert.match(limited.note ?? '', /过于频繁/);
    clock += 6 * 60_000;
    await readClaudeQuota({ snapshotFile, now: clock, usage });
    assert.equal(calls.length, 1, 'a Retry-After of 15 minutes is honoured');

    clock += 10 * 60_000;
    next = () => new Response('down', { status: 503 });
    const down = (await captureConsole(() => readClaudeQuota({ snapshotFile, now: clock, usage }))).result;
    assert.equal(calls.length, 2);
    assert.match(down.note ?? '', /暂时无法访问/);
    clock += 60_000;
    await readClaudeQuota({ snapshotFile, now: clock, usage });
    assert.equal(calls.length, 2, 'a 5xx backs off as well');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a request that hangs times out, is told to stop and falls back to the snapshot', async () => {
  const { directory, credentialsFile, snapshotFile } = loginFixture();
  let clock = NOW;
  // Ignores its abort signal and never answers.
  const { calls, request } = fakeFetch(() => new Promise<Response>(() => {}));
  try {
    writeStatuslineSnapshot(snapshotFile);
    const usage = createClaudeUsageReader({ credentialsFile, enabled: true, request, now: () => clock, timeoutMs: 30 });
    const started = Date.now();
    const { result, output } = await captureConsole(() => readClaudeQuota({ snapshotFile, now: clock, usage }));
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.source, 'statusline');
    assert.match(output, /timed out/);
    assert.equal(calls[0].init?.signal?.aborted, true);
    clock += 60_000;
    await readClaudeQuota({ snapshotFile, now: clock, usage });
    assert.equal(calls.length, 1, 'a timeout backs off');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a malformed answer falls back and backs off; an answer without windows has nothing to show', async () => {
  const malformed = loginFixture();
  const empty = loginFixture();
  let clock = NOW;
  const { calls, request } = fakeFetch(() => new Response('<html>not json', { status: 200 }));
  try {
    writeStatuslineSnapshot(malformed.snapshotFile);
    const usage = createClaudeUsageReader({ credentialsFile: malformed.credentialsFile, enabled: true, request, now: () => clock });
    const { result } = await captureConsole(() => readClaudeQuota({ snapshotFile: malformed.snapshotFile, now: clock, usage }));
    assert.equal(result.source, 'statusline');
    assert.match(result.note ?? '', /暂时无法访问/);
    clock += 60_000;
    await readClaudeQuota({ snapshotFile: malformed.snapshotFile, now: clock, usage });
    assert.equal(calls.length, 1);

    const answered = fakeFetch(() => Response.json({ five_hour: null, seven_day: null }));
    const nothing = await readClaudeQuota({
      snapshotFile: empty.snapshotFile, now: NOW,
      usage: createClaudeUsageReader({ credentialsFile: empty.credentialsFile, enabled: true, request: answered.request, now: () => NOW }),
    });
    assert.equal(nothing.available, false);
    assert.match(nothing.note ?? '', /没有返回 5 小时/);
  } finally {
    for (const fixture of [malformed, empty]) rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('the token never appears in a log, a note or a snapshot, whatever goes wrong', async () => {
  const secret = TOKEN.slice(0, 24);
  const scenarios: { name: string; credentials?: unknown; respond: () => Promise<Response> | Response }[] = [
    { name: 'success', respond: () => Response.json({ five_hour: { utilization: 1, resets_at: null } }) },
    { name: '401 echoing the token', respond: () => new Response(`invalid token ${TOKEN}`, { status: 401 }) },
    { name: '500 echoing the token', respond: () => new Response(TOKEN, { status: 500 }) },
    { name: 'malformed answer echoing the token', respond: () => new Response(`{"broken": "${TOKEN}`, { status: 200 }) },
    { name: 'network error carrying the token', respond: () => { throw new TypeError(`fetch failed for Bearer ${TOKEN}`); } },
    { name: 'hung request', respond: () => new Promise<Response>(() => {}) },
    // A JSON syntax error quotes the text around the failure, which is the token here.
    { name: 'broken credentials file', credentials: `{"claudeAiOauth": {"accessToken": "${TOKEN}", `, respond: () => Response.json({}) },
    { name: 'token with a line break', credentials: { claudeAiOauth: { accessToken: `${TOKEN}\nX-Injected: 1`, expiresAt: NOW + 3_600_000 } }, respond: () => Response.json({}) },
  ];
  for (const scenario of scenarios) {
    const fixture = loginFixture(scenario.credentials ?? VALID_LOGIN);
    try {
      const { request } = fakeFetch(scenario.respond);
      const usage = createClaudeUsageReader({ credentialsFile: fixture.credentialsFile, enabled: true, request, now: () => NOW, timeoutMs: 30 });
      const { result, output } = await captureConsole(() => readClaudeQuota({ snapshotFile: fixture.snapshotFile, now: NOW, usage }));
      assert.ok(!output.includes(secret), `${scenario.name}: no token in logs`);
      assert.ok(!JSON.stringify(result).includes(secret), `${scenario.name}: no token in the snapshot`);
    } finally { rmSync(fixture.directory, { recursive: true, force: true }); }
  }
});
