import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { runBrokerCommand } from '../index.js';
import { parseBrokerConfig } from '../broker.config.js';

const MODULE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sink() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', chunk => { text += String(chunk); });
  return { stream, text: () => text };
}
const HEALTHY_ISOLATION = { ok: true, interopActive: false, interopBinfmt: false, interopSocket: false, windowsDrives: [] as string[], notes: [] as string[] };

// `check` inspects the machine's isolation; the tests describe a healthy one unless they pass their own.
async function run(stateDir: string, argv: string[], input = '', isolation = HEALTHY_ISOLATION) {
  const stdout = sink();
  const stderr = sink();
  const code = await runBrokerCommand(argv, {
    stdout: stdout.stream, stderr: stderr.stream, stdin: Readable.from([input]), env: { STUDIO_TRADER_STATE_DIR: stateDir }, pid: process.pid,
    isolation: () => isolation,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
function stateDirectory(config: Record<string, unknown> = { allowedEnvs: ['demo'], origins: ['https://studio.ajarche.com'] }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't212-broker-cli-'));
  writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config));
  return directory;
}

test('enroll-code prints a code once and stores only its hash in the broker database', async () => {
  const directory = stateDirectory();
  try {
    const result = await run(directory, ['enroll-code']);
    assert.equal(result.code, 0);
    const code = result.stdout.match(/注册码：(\S+)/)?.[1] ?? '';
    assert.match(code, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    const database = new Database(path.join(directory, 'broker.db'), { readonly: true });
    const rows = database.prepare('SELECT * FROM enrollment_codes').all() as { code_hash: string }[];
    database.close();
    assert.equal(rows.length, 1);
    assert.match(rows[0].code_hash, /^[0-9a-f]{64}$/);
    assert.ok(!readFileSync(path.join(directory, 'broker.db')).includes(code.replace(/-/g, '')), 'the plain code is not in the file');
    // umask 077: the database is private to the broker's OS user.
    assert.equal(statSync(path.join(directory, 'broker.db')).mode & 0o077, 0);
    assert.match((await run(directory, ['passkeys'])).stdout, /还没有登记/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('set-key writes the order key file with mode 0600 and check reports what is missing', async () => {
  const directory = stateDirectory();
  try {
    const before = await run(directory, ['check']);
    assert.equal(before.code, 1);
    assert.match(before.stderr, /缺少下单密钥：demo/);
    assert.equal((await run(directory, ['set-key', 'demo'], 'short\n')).code, 1);
    const written = await run(directory, ['set-key', 'demo'], 'fake-demo-key-123\nfake-demo-secret-456\n');
    assert.equal(written.code, 0);
    assert.ok(!written.stdout.includes('fake-demo'), 'the key is not echoed');
    const file = path.join(directory, 'demo.env');
    assert.equal(readFileSync(file, 'utf8'), 'TRADING212_API_KEY=fake-demo-key-123\nTRADING212_API_SECRET=fake-demo-secret-456\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const after = await run(directory, ['check']);
    assert.equal(after.code, 0);
    assert.match(after.stdout, /模拟盘密钥 有/);
    assert.ok(!after.stdout.includes('fake-demo'));
    assert.equal((await run(directory, ['set-key', 'paper'])).code, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('check fails while the isolation is invalid, even with keys and origins in place', async () => {
  const directory = stateDirectory();
  try {
    writeFileSync(path.join(directory, 'demo.env'), 'TRADING212_API_KEY=fake-demo-key-123\nTRADING212_API_SECRET=fake-demo-secret-456\n');
    assert.equal((await run(directory, ['check'])).code, 0);
    const broken = await run(directory, ['check'], '', {
      ok: false, interopActive: true, interopBinfmt: false, interopSocket: true, windowsDrives: ['/mnt/c'], notes: ['socket note'],
    });
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /隔离：!! 无效 !!（互操作 开（危险：\/run\/WSL socket）；非 root 可写的 Windows 盘 \/mnt\/c）/);
    assert.match(broken.stderr, /隔离警告：socket note/);
    assert.match(broken.stderr, /不要写入下单密钥/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('config defaults: daily cap 2000 and live cooldown 60 s unless set, and an explicit 0 turns either off', () => {
  const defaults = parseBrokerConfig('{}', '/x');
  assert.deepEqual(
    [defaults.allowedEnvs, defaults.origins, defaults.maxOrderValue, defaults.maxOrdersPerHour, defaults.maxDailyOrderValue, defaults.liveOrderCooldownSeconds, defaults.demoConfirm],
    [[], [], 500, 10, 2000, 60, false],
  );
  const off = parseBrokerConfig(JSON.stringify({ maxDailyOrderValue: 0, liveOrderCooldownSeconds: 0 }), '/x');
  assert.deepEqual([off.maxDailyOrderValue, off.liveOrderCooldownSeconds], [0, 0]);
  assert.throws(() => parseBrokerConfig(JSON.stringify({ maxDailyOrderValue: -1 }), '/x'), /maxDailyOrderValue/);
  assert.throws(() => parseBrokerConfig(JSON.stringify({ liveOrderCooldownSeconds: 86_401 }), '/x'), /liveOrderCooldownSeconds/);
});

test('an invalid config is refused instead of falling back to looser settings', async () => {
  const directory = stateDirectory({ allowedEnvs: ['live'], maxOrderValu: 100000 });
  try {
    const result = await run(directory, ['check']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /不认识的字段 maxOrderValu/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => parseBrokerConfig(JSON.stringify({ origins: ['http://studio.ajarche.com'] }), '/x'), /HTTPS/);
  assert.throws(() => parseBrokerConfig(JSON.stringify({ origins: ['https://studio.ajarche.com/'] }), '/x'), /网址来源/);
  assert.throws(() => parseBrokerConfig(JSON.stringify({ maxOrderValue: 0 }), '/x'), /maxOrderValue/);
  assert.throws(() => parseBrokerConfig(JSON.stringify({ allowedEnvs: ['paper'] }), '/x'), /allowedEnvs/);
  assert.throws(() => parseBrokerConfig(JSON.stringify({ demoConfirmWithoutPasskey: 'yes' }), '/x'), /demoConfirmWithoutPasskey/);
  const local = parseBrokerConfig(JSON.stringify({ origins: ['http://localhost:5174'] }), '/x');
  assert.deepEqual([local.origins, local.allowedEnvs, local.maxOrderValue, local.demoConfirm], [['http://localhost:5174'], [], 500, false]);
});

test('the broker imports only Node built-ins, better-sqlite3 and @simplewebauthn/server at runtime', () => {
  const allowed = (specifier: string) => specifier.startsWith('node:') || specifier.startsWith('./')
    || specifier === 'better-sqlite3' || specifier === '@simplewebauthn/server';
  const files = readdirSync(MODULE_DIR).filter(name => name.endsWith('.ts'));
  assert.ok(files.includes('main.ts') && files.includes('broker.service.ts'));
  for (const file of files) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    // Type-only imports are erased by the compiler; every other import must stay inside the allowlist.
    for (const match of source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gms)) {
      assert.ok(allowed(match[1]), `${file} imports ${match[1]} at runtime`);
    }
    assert.ok(!/\bimport\(/.test(source), `${file} uses a dynamic import`);
  }
});
