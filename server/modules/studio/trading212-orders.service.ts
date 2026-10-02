import { randomUUID } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';
import type { StudioT212Environment, StudioT212OrderInput, StudioT212TrustedOrigin } from '@/shared/types.js';

import type { createTrading212Service } from './trading212.service.js';

type WebAuthn = {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
};
type Dependencies = {
  database: Database.Database;
  trading212: Pick<ReturnType<typeof createTrading212Service>, 'overview' | 'placeOrder' | 'lastCurrency'>;
  // STUDIO_T212_TRADING: off (default) | demo | live | both.
  trading?: string;
  // STUDIO_T212_MAX_ORDER_VALUE: hard cap per order in the account currency (default 500).
  maxOrderValue?: string;
  // Exact browser origins that may trade and own passkeys (STUDIO_PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN).
  origins: (string | undefined)[];
  // Development servers also accept http://localhost, 127.0.0.1 and [::1] on any port.
  development?: boolean;
  // SimpleWebAuthn functions; injectable so tests never need a real authenticator.
  webauthn?: WebAuthn;
  now?: () => number;
};
type Proof = { assertion: AuthenticationResponseJSON } | { confirmed: true };
type Method = 'passkey' | 'confirm';
type Preview = StudioT212OrderInput & {
  id: string; userId: number; estimatedValue: number; currency: string;
  origin: string; rpId: string; requires: Method; challenge: string | null; expiresAt: number;
};
type PasskeyRow = {
  id: string; user_id: number; rp_id: string; credential_id: string; public_key: Buffer; counter: number;
  transports: string; label: string | null; created_at: string; last_used_at: string | null;
};
type Attempt = { status: 'placed' | 'failed'; brokerOrderId?: string | null; brokerStatus?: string | null; error?: string };

// A reviewed order must be confirmed within a minute, so the estimate it shows is still close to the market.
const PREVIEW_TTL_MS = 60_000;
const REGISTRATION_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ORDER_VALUE = 500;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ENV_LABEL: Record<StudioT212Environment, string> = { live: '实盘', demo: '模拟盘' };
const DEFAULT_WEBAUTHN: WebAuthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

function fail(message: string, statusCode: number, code = 'T212_ORDER_REFUSED'): never {
  throw new AppError(message, { statusCode, code });
}
// Anything other than demo|live|both keeps trading off instead of guessing what was meant.
function allowedEnvironments(value: string | undefined): StudioT212Environment[] {
  const setting = (value ?? '').trim().toLowerCase();
  if (setting === 'both') return ['live', 'demo'];
  if (setting === 'live' || setting === 'demo') return [setting];
  if (setting && setting !== 'off') console.warn(`[studio] STUDIO_T212_TRADING="${setting}" is not off|demo|live|both; trading stays off`);
  return [];
}
function orderCap(value: string | undefined) {
  if (value === undefined || value.trim() === '') return DEFAULT_MAX_ORDER_VALUE;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`[studio] STUDIO_T212_MAX_ORDER_VALUE is not a positive number; using ${DEFAULT_MAX_ORDER_VALUE}`);
  return DEFAULT_MAX_ORDER_VALUE;
}
function configuredOrigins(values: (string | undefined)[]) {
  return [...new Set(values.flatMap(value => {
    const raw = value?.trim();
    if (!raw) return [];
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') return [url.origin];
    } catch { /* reported below */ }
    console.warn(`[studio] ignoring trading origin "${raw}": not an http(s) origin`);
    return [];
  }))];
}
function money(value: number, currency: string) {
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`.trim(); }
}
// A rough device name so two passkeys on the same domain can be told apart; iPadOS Safari reports itself as a Mac.
function deviceLabel(userAgent: string | undefined) {
  const agent = userAgent ?? '';
  if (/iPad/.test(agent)) return 'iPad';
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/Android/.test(agent)) return 'Android';
  if (/Windows/.test(agent)) return 'Windows';
  if (/Macintosh/.test(agent)) return 'Mac / iPad';
  return null;
}
function text(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}
function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Used by studio.module (through trading212-orders.routes) to place Trading 212 orders safely: environment
 * gating, a hard per-order cap, single-use 60-second previews, and either a Face ID / Touch ID passkey for the
 * request's domain or an explicit double confirmation when that domain has no passkey. Every confirmation
 * attempt is recorded in studio_t212_orders without secrets.
 */
export function createTrading212OrdersService(deps: Dependencies) {
  const db = deps.database;
  const now = deps.now ?? Date.now;
  const webauthn = deps.webauthn ?? DEFAULT_WEBAUTHN;
  const allowedEnvs = allowedEnvironments(deps.trading);
  const maxOrderValue = orderCap(deps.maxOrderValue);
  const origins = configuredOrigins(deps.origins);
  const previews = new Map<string, Preview>();
  // Registration challenges per user and RP ID, waiting for the browser's attestation.
  const registrations = new Map<string, { challenge: string; origin: string; expiresAt: number }>();
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_t212_passkeys (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, rp_id TEXT NOT NULL, credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '[]',
      label TEXT, created_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_t212_passkeys_user_rp ON studio_t212_passkeys (user_id, rp_id);
    CREATE TABLE IF NOT EXISTS studio_t212_orders (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, preview_id TEXT NOT NULL, user_id INTEGER NOT NULL, env TEXT NOT NULL,
      ticker TEXT NOT NULL, side TEXT NOT NULL, type TEXT NOT NULL, quantity REAL NOT NULL, limit_price REAL,
      estimated_value REAL NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL, rp_id TEXT NOT NULL,
      status TEXT NOT NULL, broker_order_id TEXT, broker_status TEXT, error TEXT, created_at TEXT NOT NULL
    );
  `);

  const isoNow = () => new Date(now()).toISOString();
  function passkeys(userId: number, rpId?: string) {
    return (rpId
      ? db.prepare('SELECT * FROM studio_t212_passkeys WHERE user_id = ? AND rp_id = ? ORDER BY created_at').all(userId, rpId)
      : db.prepare('SELECT * FROM studio_t212_passkeys WHERE user_id = ? ORDER BY rp_id, created_at').all(userId)) as PasskeyRow[];
  }
  function transports(row: PasskeyRow) {
    try {
      const value: unknown = JSON.parse(row.transports);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch { return []; }
  }
  function summary(row: PasskeyRow) {
    return { id: row.id, rpId: row.rp_id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at };
  }
  function prune() {
    const time = now();
    for (const [id, preview] of previews) if (preview.expiresAt <= time) previews.delete(id);
    for (const [key, pending] of registrations) if (pending.expiresAt <= time) registrations.delete(key);
  }
  function assertAllowed(env: StudioT212Environment) {
    if (!allowedEnvs.includes(env)) {
      fail(`${ENV_LABEL[env]}下单未开启：在服务器 .env 设置 STUDIO_T212_TRADING=${env}（或 both）后重启 Studio`, 403, 'T212_TRADING_DISABLED');
    }
  }
  function record(preview: Preview, method: Method, attempt: Attempt) {
    db.prepare(`INSERT INTO studio_t212_orders (preview_id, user_id, env, ticker, side, type, quantity, limit_price, estimated_value,
      currency, method, rp_id, status, broker_order_id, broker_status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      preview.id, preview.userId, preview.env, preview.ticker, preview.side, preview.type, preview.quantity, preview.limitPrice ?? null,
      preview.estimatedValue, preview.currency, method, preview.rpId, attempt.status, attempt.brokerOrderId ?? null,
      attempt.brokerStatus ?? null, attempt.error?.slice(0, 300) ?? null, isoNow(),
    );
  }

  return {
    // Matches the browser's Origin header against the configured origins; its hostname becomes the RP ID.
    trustedOrigin(header: string | undefined): StudioT212TrustedOrigin {
      let url: URL | null = null;
      try { url = header ? new URL(header) : null; } catch { url = null; }
      // An Origin header is exactly scheme://host[:port]; anything else, including "null", is refused.
      if (url && url.origin === header) {
        if (origins.includes(url.origin)) return { origin: url.origin, rpId: url.hostname };
        if (deps.development && url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)) return { origin: url.origin, rpId: url.hostname };
      }
      fail('当前网址不在下单白名单：请在服务器 .env 把 STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN 设为你打开 Studio 的地址', 403, 'T212_UNTRUSTED_ORIGIN');
    },

    config(userId: number) {
      const currency = [...allowedEnvs, 'live', 'demo'].map(env => deps.trading212.lastCurrency(env as StudioT212Environment)).find(Boolean);
      return {
        allowedEnvs, maxOrderValue, ...(currency ? { currency } : {}),
        passkeys: passkeys(userId).map(summary),
        trustedOrigins: origins, allowLocalhost: Boolean(deps.development),
      };
    },

    async preview(userId: number, origin: StudioT212TrustedOrigin, input: StudioT212OrderInput) {
      assertAllowed(input.env);
      prune();
      const overview = await deps.trading212.overview(input.env);
      const currency = overview.currency;
      const position = overview.positions.find(item => item.ticker === input.ticker && item.quantity > 0);
      if (input.side === 'sell') {
        if (!position) fail(`没有持有 ${input.ticker}，不能卖出`, 400);
        if (input.quantity > position.quantity + 1e-9) fail(`卖出数量超过持仓：只持有 ${position.quantity} 股`, 400);
      }
      if (input.type === 'market' && !position) fail('未持有的标的无法按市价估算金额，请改用限价单', 400);

      const warnings: string[] = [];
      if (input.env === 'live') warnings.push('实盘账户：这笔订单会用真实资金成交');
      // Value of one share in the account currency; with the instrument-currency price it also gives the FX rate.
      const perShare = position && position.quantity > 0 ? position.value / position.quantity : 0;
      let estimate: number;
      if (input.type === 'market') {
        estimate = input.quantity * perShare;
        warnings.push('市价单按当前价估算，实际成交价可能不同；休市时会在开盘后成交');
      } else if (position && position.currentPrice > 0 && perShare > 0) {
        estimate = input.quantity * (input.limitPrice ?? 0) * (perShare / position.currentPrice);
      } else {
        estimate = input.quantity * (input.limitPrice ?? 0);
        warnings.push('未持有该标的：金额按 数量 × 限价 估算，没有换算汇率');
      }
      if (input.type === 'limit' && input.timeValidity === 'GOOD_TILL_CANCEL') warnings.push('撤单前有效：未成交前订单会一直挂着，可以在 Trading 212 里撤单');
      const estimatedValue = round2(estimate);
      if (!(estimatedValue > 0)) fail('无法估算这笔订单的金额，请改用限价单', 400);
      if (estimatedValue > maxOrderValue) {
        fail(`预计金额 ${money(estimatedValue, currency)} 超过单笔上限 ${money(maxOrderValue, currency)}（STUDIO_T212_MAX_ORDER_VALUE）`, 400, 'T212_ORDER_CAP');
      }
      if (input.side === 'buy' && estimatedValue > overview.cash.available) warnings.push(`可用现金 ${money(overview.cash.available, currency)}，可能不足以成交`);

      const keys = passkeys(userId, origin.rpId);
      const authentication = keys.length ? await webauthn.generateAuthenticationOptions({
        rpID: origin.rpId, userVerification: 'required', timeout: PREVIEW_TTL_MS,
        allowCredentials: keys.map(row => ({ id: row.credential_id, transports: transports(row) })),
      }) : undefined;
      const preview: Preview = {
        ...input, id: randomUUID(), userId, estimatedValue, currency, origin: origin.origin, rpId: origin.rpId,
        requires: authentication ? 'passkey' : 'confirm', challenge: authentication?.challenge ?? null, expiresAt: now() + PREVIEW_TTL_MS,
      };
      previews.set(preview.id, preview);
      return {
        id: preview.id, env: preview.env, ticker: preview.ticker, side: preview.side, type: preview.type, quantity: preview.quantity,
        ...(preview.type === 'limit' ? { limitPrice: preview.limitPrice, timeValidity: preview.timeValidity } : {}),
        estimatedValue, currency, maxOrderValue, warnings, expiresAt: new Date(preview.expiresAt).toISOString(),
        requires: preview.requires, ...(authentication ? { authentication } : {}),
      };
    },

    async confirm(userId: number, origin: StudioT212TrustedOrigin, id: string, proof: Proof) {
      const found = previews.get(id);
      if (!found || found.userId !== userId) fail('这笔订单预览不存在、已使用或已过期，请重新预览', 404, 'T212_PREVIEW_GONE');
      const preview: Preview = found;
      // Single use: the preview is gone after the first confirmation attempt, whatever its outcome.
      previews.delete(id);
      const method: Method = 'assertion' in proof ? 'passkey' : 'confirm';
      function refuse(message: string, statusCode: number, code?: string): never {
        record(preview, method, { status: 'failed', error: message });
        fail(message, statusCode, code);
      }
      if (now() >= preview.expiresAt) refuse('订单预览已超过 60 秒，请重新预览', 410, 'T212_PREVIEW_EXPIRED');
      if (origin.origin !== preview.origin) refuse('请在发起预览的同一个网址确认订单', 403);
      if (!allowedEnvs.includes(preview.env)) refuse(`${ENV_LABEL[preview.env]}下单未开启`, 403, 'T212_TRADING_DISABLED');

      if (preview.requires === 'passkey') {
        if (!('assertion' in proof)) refuse('这个域名已启用面容 ID / 触控 ID，请用通行密钥确认', 400);
        const row = passkeys(userId, preview.rpId).find(item => item.credential_id === proof.assertion.id);
        if (!row) refuse('通行密钥验证失败：这把通行密钥不属于当前域名', 403, 'T212_PASSKEY_FAILED');
        let verified: Awaited<ReturnType<WebAuthn['verifyAuthenticationResponse']>> | null = null;
        try {
          verified = await webauthn.verifyAuthenticationResponse({
            response: proof.assertion, expectedChallenge: preview.challenge ?? '', expectedOrigin: preview.origin, expectedRPID: preview.rpId,
            credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transports(row) },
            requireUserVerification: true,
          });
        } catch { verified = null; }
        if (!verified?.verified) refuse('通行密钥验证失败，订单没有提交', 403, 'T212_PASSKEY_FAILED');
        db.prepare('UPDATE studio_t212_passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(verified.authenticationInfo.newCounter, isoNow(), row.id);
      } else {
        if (!('confirmed' in proof) || proof.confirmed !== true) refuse('请先在二次确认里确认这笔订单', 400);
        // A passkey enabled after the preview raises the bar: the double confirmation no longer suffices.
        if (passkeys(userId, preview.rpId).length) refuse('这个域名刚启用了面容 ID / 触控 ID，请重新预览', 409);
      }

      const quantity = preview.side === 'sell' ? -preview.quantity : preview.quantity;
      const body = preview.type === 'market'
        ? { ticker: preview.ticker, quantity }
        : { ticker: preview.ticker, quantity, limitPrice: preview.limitPrice ?? 0, timeValidity: preview.timeValidity };
      let placed: Record<string, unknown>;
      try {
        placed = await deps.trading212.placeOrder(preview.env, preview.type, body);
      } catch (error) {
        record(preview, method, { status: 'failed', error: error instanceof Error ? error.message : '下单失败' });
        throw error;
      }
      const order = {
        id: text(placed.id), status: text(placed.status), ticker: text(placed.ticker) ?? preview.ticker,
        side: text(placed.side), type: text(placed.type), quantity: numberOrNull(placed.quantity),
        filledQuantity: numberOrNull(placed.filledQuantity), limitPrice: numberOrNull(placed.limitPrice), createdAt: text(placed.createdAt),
      };
      record(preview, method, { status: 'placed', brokerOrderId: order.id, brokerStatus: order.status });
      return { order, method, env: preview.env, estimatedValue: preview.estimatedValue, currency: preview.currency };
    },

    async passkeyOptions(userId: number, userName: string | undefined, origin: StudioT212TrustedOrigin) {
      prune();
      const options = await webauthn.generateRegistrationOptions({
        rpName: 'Agent Cloud Studio', rpID: origin.rpId,
        userName: userName?.trim() || `studio-${userId}`, userDisplayName: 'Studio 交易确认',
        // Stable per user, so re-registering on the same device replaces that device's passkey instead of adding one.
        userID: new Uint8Array(Buffer.from(`studio-user-${userId}`)),
        attestationType: 'none', timeout: 120_000,
        excludeCredentials: passkeys(userId, origin.rpId).map(row => ({ id: row.credential_id, transports: transports(row) })),
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      });
      registrations.set(`${userId}:${origin.rpId}`, { challenge: options.challenge, origin: origin.origin, expiresAt: now() + REGISTRATION_TTL_MS });
      return options;
    },

    async registerPasskey(userId: number, origin: StudioT212TrustedOrigin, response: RegistrationResponseJSON, userAgent?: string) {
      const key = `${userId}:${origin.rpId}`;
      const pending = registrations.get(key);
      registrations.delete(key);
      if (!pending || pending.expiresAt <= now() || pending.origin !== origin.origin) fail('通行密钥注册已过期，请重新开始', 400, 'T212_PASSKEY_FAILED');
      let verified: Awaited<ReturnType<WebAuthn['verifyRegistrationResponse']>> | null = null;
      try {
        verified = await webauthn.verifyRegistrationResponse({
          response, expectedChallenge: pending.challenge, expectedOrigin: origin.origin, expectedRPID: origin.rpId, requireUserVerification: true,
        });
      } catch { verified = null; }
      if (!verified?.verified) fail('通行密钥注册失败：设备没有通过验证', 400, 'T212_PASSKEY_FAILED');
      const { credential } = verified.registrationInfo;
      if (db.prepare('SELECT 1 FROM studio_t212_passkeys WHERE credential_id = ?').get(credential.id)) fail('这把通行密钥已经登记过了', 409);
      const row: PasskeyRow = {
        id: randomUUID(), user_id: userId, rp_id: origin.rpId, credential_id: credential.id, public_key: Buffer.from(credential.publicKey),
        counter: credential.counter, transports: JSON.stringify(credential.transports ?? []), label: deviceLabel(userAgent),
        created_at: isoNow(), last_used_at: null,
      };
      db.prepare(`INSERT INTO studio_t212_passkeys (id, user_id, rp_id, credential_id, public_key, counter, transports, label, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.user_id, row.rp_id, row.credential_id, row.public_key, row.counter, row.transports, row.label, row.created_at, row.last_used_at);
      return summary(row);
    },

    removePasskey(userId: number, id: string) {
      const result = db.prepare('DELETE FROM studio_t212_passkeys WHERE id = ? AND user_id = ?').run(id, userId);
      if (!result.changes) fail('找不到这把通行密钥', 404);
      return { removed: true };
    },
  };
}
