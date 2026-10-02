import { chmodSync, lstatSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { Writable } from 'node:stream';

import Database from 'better-sqlite3';

import { BrokerError } from './broker-error.js';
import { inspectIsolation } from './broker-isolation.js';
import { brokerKeyFile, loadBrokerConfig } from './broker.config.js';
import { createBrokerRepository } from './broker.repository.js';
import { createBrokerSocketServer } from './broker.server.js';
import { createBrokerService } from './broker.service.js';
import { createBrokerTrading212Client } from './broker-trading212.client.js';

type Io = {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  pid: number;
  // WSL isolation inspector for `check`; injectable so tests can describe a machine instead of reading this one.
  isolation?: typeof inspectIsolation;
};

const DEFAULT_STATE_DIR = '/var/lib/studio-trader';
const DEFAULT_SOCKET = '/run/studio-trader/broker.sock';
const USAGE = `用法：studio-trader <命令>
  serve [--socket 路径]     运行交易代理（systemd 用；有 LISTEN_FDS 时使用 systemd 传入的 socket）
  enroll-code               生成一次性注册码（10 分钟有效，只能用一次，只显示这一次）
  passkeys                  列出已登记的通行密钥
  revoke-passkey <id>       直接移除一把通行密钥
  audit [--limit N]         查看最近的下单审计记录
  set-key <live|demo>       从标准输入写入下单密钥（TRADING212_API_KEY / TRADING212_API_SECRET）
  check                     检查配置、密钥文件和数据库（不联网）
状态目录：STUDIO_TRADER_STATE_DIR（默认 ${DEFAULT_STATE_DIR}）`;
const KEY_VALUE = /^[^\s=]{8,512}$/;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function openService(stateDir: string) {
  const config = loadBrokerConfig(stateDir);
  const db = new Database(config.databasePath);
  const repository = createBrokerRepository(db);
  const trading212 = createBrokerTrading212Client({ keyFiles: config.keyFiles });
  return { config, db, trading212, service: createBrokerService({ config, repository, trading212 }) };
}
// Reads the key and the secret line by line; on a terminal nothing typed is echoed.
async function readKeyPair(io: Io) {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) io.stderr.write(chunk); done(); } });
  const lines = readline.createInterface({ input: io.stdin, output, terminal: Boolean(io.stdin.isTTY) });
  const iterator = lines[Symbol.asyncIterator]();
  const ask = async (prompt: string) => {
    output.write(prompt);
    muted = Boolean(io.stdin.isTTY);
    const next = await iterator.next();
    muted = false;
    if (io.stdin.isTTY) io.stderr.write('\n');
    return next.done ? '' : String(next.value).trim();
  };
  try {
    return { key: await ask('TRADING212_API_KEY: '), secret: await ask('TRADING212_API_SECRET: ') };
  } finally { lines.close(); }
}
function serve(stateDir: string, args: string[], io: Io) {
  const { config, db, trading212, service } = openService(stateDir);
  const server = createBrokerSocketServer(service);
  const activated = io.env.LISTEN_FDS === '1' && Number(io.env.LISTEN_PID) === io.pid;
  const socketPath = option(args, '--socket') ?? io.env.STUDIO_TRADER_SOCKET ?? DEFAULT_SOCKET;
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    const ready = () => {
      // Without systemd socket activation the socket is ours to restrict: owner and group only.
      if (!activated) chmodSync(socketPath, 0o660);
      io.stdout.write(`[t212-broker] listening on ${activated ? 'systemd socket' : socketPath}; envs [${config.allowedEnvs.join(', ') || 'none'}], `
        + `cap ${config.maxOrderValue}, ${config.origins.length} origin(s), live key ${trading212.keyConfigured('live') ? 'present' : 'missing'}, `
        + `demo key ${trading212.keyConfigured('demo') ? 'present' : 'missing'}, ${service.passkeys().length} passkey(s)\n`);
    };
    if (activated) server.listen({ fd: 3 }, ready);
    else {
      // A socket left by a crashed run is replaced; any other kind of file at that path is not touched.
      try { if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath); } catch { /* nothing there */ }
      server.listen(socketPath, ready);
    }
    const stop = () => { server.close(() => { db.close(); resolve(0); }); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

/**
 * Used by main.ts (the program the systemd unit and the owner run) and the broker tests. Every command runs as
 * the broker's OS user against the 0700 state directory, which is why `enroll-code` and `revoke-passkey` need no
 * further proof: whoever can run them already controls the broker. Files are created with umask 077.
 */
export async function runBrokerCommand(argv: string[], io: Io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env, pid: process.pid }) {
  process.umask(0o077);
  const [command, ...args] = argv;
  const stateDir = io.env.STUDIO_TRADER_STATE_DIR || DEFAULT_STATE_DIR;
  try {
    switch (command) {
      case 'serve':
        return await serve(stateDir, args, io);
      case 'enroll-code': {
        const { db, service } = openService(stateDir);
        try {
          const { code, expiresAt } = service.createEnrollmentCode();
          io.stdout.write(`注册码：${code}\n有效期至 ${new Date(expiresAt).toLocaleString('zh-CN')}（10 分钟），只能使用一次。\n`
            + '在 Studio「设置 → 交易安全」里输入它，再用面容 ID / 触控 ID 完成登记。\n');
        } finally { db.close(); }
        return 0;
      }
      case 'passkeys': {
        const { db, service } = openService(stateDir);
        try {
          const rows = service.passkeys();
          if (!rows.length) io.stdout.write('还没有登记任何通行密钥。\n');
          else io.stdout.write('核对这些是不是你自己的设备。名称（label）由 Studio 传来，被入侵的 Studio 可以伪造，不能作为依据；\n'
            + '要看的是 AAGUID（认证器型号）、凭据 ID 前缀、是否可同步，以及精确到秒的登记时间。\n');
          for (const row of rows) {
            io.stdout.write(`${row.id}  ${row.rpId}\n`
              + `    AAGUID ${row.aaguid || '未知'}  凭据 ${row.credentialIdPrefix}…  ${row.multiDevice ? '可同步(多设备)' : '单设备'}${row.backedUp ? ' 已备份' : ''}\n`
              + `    登记 ${row.createdAt}  最近使用 ${row.lastUsedAt ?? '-'}  名称(不可信) ${row.label ?? '-'}\n`);
          }
        } finally { db.close(); }
        return 0;
      }
      case 'revoke-passkey': {
        const id = args[0];
        if (!id) { io.stderr.write('用法：studio-trader revoke-passkey <id>\n'); return 2; }
        const { db, service } = openService(stateDir);
        try {
          const removed = service.revokePasskey(id);
          io.stdout.write(removed ? `已移除 ${id}\n` : `找不到 ${id}\n`);
          return removed ? 0 : 1;
        } finally { db.close(); }
      }
      case 'audit': {
        const limit = Math.min(500, Math.max(1, Number(option(args, '--limit') ?? 20) || 20));
        const { db, service } = openService(stateDir);
        try {
          for (const row of service.audit(limit)) {
            io.stdout.write(`${new Date(Number(row.created_at)).toISOString()}  ${row.status}  ${row.env} ${row.side} ${row.quantity} ${row.ticker}`
              + `  ≈${row.estimated_value} ${row.currency}  ${row.method}@${row.rp_id}${row.broker_order_id ? `  #${row.broker_order_id}` : ''}${row.error ? `  ${row.error}` : ''}\n`);
          }
        } finally { db.close(); }
        return 0;
      }
      case 'set-key': {
        const env = args[0];
        if (env !== 'live' && env !== 'demo') { io.stderr.write('用法：studio-trader set-key <live|demo>\n'); return 2; }
        const { key, secret } = await readKeyPair(io);
        if (!KEY_VALUE.test(key) || !KEY_VALUE.test(secret)) { io.stderr.write('密钥格式不对：不能为空，不能含空格或 =\n'); return 1; }
        const file = brokerKeyFile(stateDir, env);
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, `TRADING212_API_KEY=${key}\nTRADING212_API_SECRET=${secret}\n`, { mode: 0o600 });
        renameSync(temporary, file);
        io.stdout.write(`已写入 ${file}（0600）。不需要重启交易代理，下一笔订单就会使用新密钥。\n`);
        return 0;
      }
      case 'check': {
        const { config, db, trading212, service } = openService(stateDir);
        try {
          io.stdout.write(`配置：允许 ${config.allowedEnvs.join(', ') || '（无，下单关闭）'}；单笔上限 ${config.maxOrderValue}；每小时最多 ${config.maxOrdersPerHour} 笔；`
            + `每日累计上限 ${config.maxDailyOrderValue || '关'}；实盘冷却 ${config.liveOrderCooldownSeconds ? `${config.liveOrderCooldownSeconds} 秒` : '关'}；`
            + `模拟盘免通行密钥 ${config.demoConfirm ? '开' : '关'}\n来源：${config.origins.join(', ') || '（无）'}\n`
            + `实盘密钥 ${trading212.keyConfigured('live') ? '有' : '无'}；模拟盘密钥 ${trading212.keyConfigured('demo') ? '有' : '无'}；通行密钥 ${service.passkeys().length} 把\n`);
          // The broker protects nothing if the Studio user can reach root or Windows; report the live isolation state.
          const guard = (io.isolation ?? inspectIsolation)();
          const interop = guard.interopActive
            ? `开（危险：${[guard.interopBinfmt ? 'binfmt 处理器' : '', guard.interopSocket ? '/run/WSL socket' : ''].filter(Boolean).join('、')}）`
            : '关';
          io.stdout.write(`隔离：${guard.ok ? '有效' : '!! 无效 !!'}（互操作 ${interop}`
            + `${guard.windowsDrives.length ? `；非 root 可写的 Windows 盘 ${guard.windowsDrives.join('、')}` : ''}）\n`);
          for (const note of guard.notes) io.stderr.write(`隔离警告：${note}\n`);
          let result = 0;
          if (!guard.ok) {
            io.stderr.write('隔离无效：交易代理保护不了下单密钥。按 docs/t212-broker.md 第 0 步修好之前，不要写入下单密钥。\n');
            result = 1;
          }
          const missing = config.allowedEnvs.filter(env => !trading212.keyConfigured(env));
          if (missing.length) { io.stderr.write(`缺少下单密钥：${missing.join(', ')}（studio-trader set-key <env>）\n`); result = 1; }
          if (!config.origins.length) { io.stderr.write('config.json 没有 origins：任何网址都不能下单\n'); result = 1; }
          return result;
        } finally { db.close(); }
      }
      default:
        io.stdout.write(`${USAGE}\n`);
        return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
  } catch (error) {
    io.stderr.write(`${error instanceof BrokerError || error instanceof Error ? error.message : '失败'}\n`);
    return 1;
  }
}
