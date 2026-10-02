import { randomUUID } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type Database from 'better-sqlite3';

import { AppError, describePasskeyDevice } from '@/shared/utils.js';
import type { StudioT212Environment, StudioT212OrderInput, StudioT212TrustedOrigin } from '@/shared/types.js';

import type { createTrading212Service } from './trading212.service.js';

type WebAuthn = {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
};
type Trading212 = ReturnType<typeof createTrading212Service>;
type Dependencies = {
  database: Database.Database;
  trading212: Pick<Trading212, 'overview' | 'placeOrder' | 'lastCurrency' | 'instrumentCurrency'>;
  // STUDIO_T212_TRADING: off (default) | demo | live | both.
  trading?: string;
  // STUDIO_T212_MAX_ORDER_VALUE: hard cap per order in the account currency (default 500).
  maxOrderValue?: string;
  // STUDIO_T212_REQUIRE_PASSKEY: "1" removes the double confirmation entirely, so every order needs a passkey.
  requirePasskey?: string;
  // STUDIO_T212_ALLOW_LOCALHOST: "1" also trusts http://localhost, 127.0.0.1 and [::1] on any port (default off).
  allowLocalhost?: string;
  // Exact browser origins that may trade and own passkeys (STUDIO_PUBLIC_ORIGIN, STUDIO_TAILNET_ORIGIN).
  origins: (string | undefined)[];
  // Checks the user's Studio account password: adding or removing a passkey always needs this step-up.
  verifyPassword: (userId: number, password: string) => Promise<boolean>;
  // SimpleWebAuthn functions; injectable so tests never need a real authenticator.
  webauthn?: WebAuthn;
  now?: () => number;
};
type Proof = { assertion: AuthenticationResponseJSON } | { confirmed: true };
// Step-up for passkey changes: the Studio password, or (removal only) an assertion from the passkey being removed.
type StepUp = { password: string } | { assertion: AuthenticationResponseJSON };
type Method = 'passkey' | 'confirm';
type Preview = StudioT212OrderInput & {
  id: string; userId: number; estimatedValue: number; currency: string;
  origin: string; rpId: string; requires: Method; challenge: string | null; expiresAt: number;
  // The user explicitly confirmed that an identical order with an unknown outcome did not go through.
  acknowledgedUnknown: boolean;
};
type Overview = Awaited<ReturnType<Trading212['overview']>>;
type PasskeyRow = {
  id: string; user_id: number; rp_id: string; credential_id: string; public_key: Buffer; counter: number;
  transports: string; label: string | null; created_at: string; last_used_at: string | null;
};
type Attempt = { status: 'placed' | 'failed' | 'unknown'; brokerOrderId?: string | null; brokerStatus?: string | null; error?: string };
// A WebAuthn ceremony waiting for the browser: its challenge and the origin that started it.
type Pending = { challenge: string; origin: string; expiresAt: number };

// A reviewed order must be confirmed within a minute, so the estimate it shows is still close to the market.
const PREVIEW_TTL_MS = 60_000;
const CEREMONY_TTL_MS = 5 * 60_000;
// After an order whose outcome is unknown, an identical order is refused for this long unless acknowledged.
const UNKNOWN_HOLD_MS = 5 * 60_000;
// Password step-up: five wrong passwords in a row lock passkey changes for fifteen minutes.
const MAX_PASSWORD_FAILURES = 5;
const PASSWORD_LOCK_MS = 15 * 60_000;
const MAX_PASSWORD_LENGTH = 1024;
const DEFAULT_MAX_ORDER_VALUE = 500;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ENV_LABEL: Record<StudioT212Environment, string> = { live: '实盘', demo: '模拟盘' };
const SIDE_LABEL = { buy: '买入', sell: '卖出' } as const;
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
// Boolean env switches are on only for an explicit 1 / true / yes / on.
function enabledFlag(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
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
// Trading 212 quotes London listings in pence (GBX); one GBX is a hundredth of a pound.
function quoteUnit(code: string) {
  const upper = code.trim().toUpperCase();
  return upper === 'GBX' ? { currency: 'GBP', scale: 0.01 } : { currency: upper, scale: 1 };
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
 * gating, a hard per-order cap in the account currency, single-use 60-second previews, and a Face ID / Touch ID
 * passkey for the request's domain. A double confirmation is accepted only while the user has no passkey at all
 * (and never with STUDIO_T212_REQUIRE_PASSKEY=1). Adding or removing a passkey needs the Studio password (removal
 * also accepts that passkey's own assertion). Every confirmation attempt is recorded in studio_t212_orders
 * without secrets; an unknown broker outcome holds back an identical order for a few minutes.
 */
export function createTrading212OrdersService(deps: Dependencies) {
  const db = deps.database;
  const now = deps.now ?? Date.now;
  const webauthn = deps.webauthn ?? DEFAULT_WEBAUTHN;
  const allowedEnvs = allowedEnvironments(deps.trading);
  const maxOrderValue = orderCap(deps.maxOrderValue);
  const requirePasskey = enabledFlag(deps.requirePasskey);
  const allowLocalhost = enabledFlag(deps.allowLocalhost);
  const origins = configuredOrigins(deps.origins);
  const previews = new Map<string, Preview>();
  // Registration challenges per user and RP ID, issued only after the password step-up.
  const registrations = new Map<string, Pending>();
  // Removal challenges per user and passkey id, for removals authorised by that passkey.
  const removals = new Map<string, Pending>();
  // Consecutive wrong step-up passwords per user, and when a lock after too many of them ends.
  const passwordFailures = new Map<number, { count: number; lockedUntil: number }>();
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
    CREATE INDEX IF NOT EXISTS studio_t212_orders_user_time ON studio_t212_orders (user_id, created_at);
  `);

  const isoNow = () => new Date(now()).toISOString();
  function passkeys(userId: number, rpId?: string) {
    return (rpId
      ? db.prepare('SELECT * FROM studio_t212_passkeys WHERE user_id = ? AND rp_id = ? ORDER BY created_at').all(userId, rpId)
      : db.prepare('SELECT * FROM studio_t212_passkeys WHERE user_id = ? ORDER BY rp_id, created_at').all(userId)) as PasskeyRow[];
  }
  function findPasskey(userId: number, id: string) {
    const row = db.prepare('SELECT * FROM studio_t212_passkeys WHERE id = ? AND user_id = ?').get(id, userId) as PasskeyRow | undefined;
    if (!row) fail('找不到这把通行密钥', 404);
    return row;
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
    for (const pending of [registrations, removals]) {
      for (const [key, item] of pending) if (item.expiresAt <= time) pending.delete(key);
    }
  }
  function assertAllowed(env: StudioT212Environment) {
    if (!allowedEnvs.includes(env)) {
      fail(`${ENV_LABEL[env]}下单未开启：在服务器 .env 设置 STUDIO_T212_TRADING=${env}（或 both）后重启 Studio`, 403, 'T212_TRADING_DISABLED');
    }
  }
  // The double confirmation is only a fallback for users without any passkey: once Face ID is enabled anywhere, a
  // domain without its own passkey must not become the weaker way in. STUDIO_T212_REQUIRE_PASSKEY removes it.
  function doubleConfirmationRefusal(userId: number, rpId: string) {
    if (requirePasskey) return `服务器要求用面容 ID / 触控 ID 确认订单（STUDIO_T212_REQUIRE_PASSKEY=1）：请先在「设置 → 交易安全」为 ${rpId} 启用`;
    const elsewhere = [...new Set(passkeys(userId).map(row => row.rp_id))];
    if (elsewhere.length) return `你已在 ${elsewhere.join('、')} 启用面容 ID / 触控 ID，二次确认不再可用：请先为 ${rpId} 启用面容 ID / 触控 ID`;
    return null;
  }
  // Latest order with the same account, ticker, side and quantity whose outcome was unknown, within the hold.
  function unresolvedOrder(userId: number, order: Pick<StudioT212OrderInput, 'env' | 'ticker' | 'side' | 'quantity'>) {
    const row = db.prepare(`SELECT created_at FROM studio_t212_orders WHERE user_id = ? AND env = ? AND ticker = ? AND side = ?
      AND quantity = ? AND status = 'unknown' AND created_at > ? ORDER BY row_id DESC LIMIT 1`)
      .get(userId, order.env, order.ticker, order.side, order.quantity, new Date(now() - UNKNOWN_HOLD_MS).toISOString()) as { created_at: string } | undefined;
    if (!row) return null;
    const minutes = Math.max(1, Math.round((now() - Date.parse(row.created_at)) / 60_000));
    return `约 ${minutes} 分钟前一笔相同的订单（${SIDE_LABEL[order.side]} ${order.quantity} 股 ${order.ticker}）状态未知：请先在 Trading 212 核对它是否已经成交；确认没有成交后，再明确确认重新下单`;
  }
  async function assertPassword(userId: number, password: string) {
    const time = now();
    const state = passwordFailures.get(userId);
    if (state && state.lockedUntil > time) fail('Studio 密码错误次数过多，请 15 分钟后再试', 429, 'T212_STEP_UP_LOCKED');
    // The attempt is counted before the (slow) password check, so concurrent guesses cannot all slip under
    // the limit; a correct password clears the count. A lock that has run out starts a fresh count.
    const count = (state && state.lockedUntil && state.lockedUntil <= time ? 0 : state?.count ?? 0) + 1;
    passwordFailures.set(userId, { count, lockedUntil: count >= MAX_PASSWORD_FAILURES ? time + PASSWORD_LOCK_MS : 0 });
    let correct = false;
    try { correct = password.length > 0 && password.length <= MAX_PASSWORD_LENGTH && await deps.verifyPassword(userId, password); }
    catch { correct = false; }
    if (correct) { passwordFailures.delete(userId); return; }
    fail('Studio 密码不正确', 403, 'T212_STEP_UP_FAILED');
  }
  // Verifies an assertion against one stored credential with user verification required, then advances its counter.
  async function verifyAssertion(row: PasskeyRow, assertion: AuthenticationResponseJSON, challenge: string, origin: string) {
    if (assertion.id !== row.credential_id) return false;
    let verified: Awaited<ReturnType<WebAuthn['verifyAuthenticationResponse']>> | null = null;
    try {
      verified = await webauthn.verifyAuthenticationResponse({
        response: assertion, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: row.rp_id,
        credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transports(row) },
        requireUserVerification: true,
      });
    } catch { verified = null; }
    if (!verified?.verified) return false;
    db.prepare('UPDATE studio_t212_passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(verified.authenticationInfo.newCounter, isoNow(), row.id);
    return true;
  }
  // Account-currency value of one unit of an instrument's quote currency (one dollar, or one penny for GBX). The
  // account's own currency needs no rate; otherwise it comes from a held position quoted in the same currency
  // (value ÷ quantity ÷ current price). Without one the order is refused instead of being valued 1:1.
  async function quoteRate(env: StudioT212Environment, ticker: string, overview: Overview) {
    const quoted = await deps.trading212.instrumentCurrency(env, ticker);
    if (!quoted) fail(`Trading 212 没有 ${ticker} 这个代码：请检查代码，例如 AAPL_US_EQ`, 400, 'T212_UNKNOWN_INSTRUMENT');
    const unit = quoteUnit(quoted);
    const account = overview.currency.trim().toUpperCase();
    if (account && unit.currency === account) {
      return { rate: unit.scale, note: unit.scale === 1 ? null : `${ticker} 以便士（GBX）计价：限价按便士填写，金额按 100 便士 = 1 英镑换算` };
    }
    for (const held of overview.positions) {
      if (!held.currency || !(held.quantity > 0) || !(held.currentPrice > 0) || !(held.value > 0)) continue;
      const heldUnit = quoteUnit(held.currency);
      if (heldUnit.currency !== unit.currency) continue;
      const perMajorUnit = held.value / held.quantity / held.currentPrice / heldUnit.scale;
      return { rate: perMajorUnit * unit.scale, note: `${ticker} 以 ${quoted} 计价：按 ${held.ticker} 持仓推算的汇率换算成 ${overview.currency}，仅为估算` };
    }
    fail(`${ticker} 以 ${quoted} 计价，账户货币是 ${overview.currency || '未知'}：账户里没有同币种的持仓可以推算汇率，Studio 不会按 1:1 估算，订单没有生成。可以直接在 Trading 212 里下这笔单`, 400, 'T212_FX_UNKNOWN');
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
        if (allowLocalhost && url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname)) return { origin: url.origin, rpId: url.hostname };
      }
      fail('当前网址不在下单白名单：请在服务器 .env 把 STUDIO_PUBLIC_ORIGIN 或 STUDIO_TAILNET_ORIGIN 设为你打开 Studio 的地址', 403, 'T212_UNTRUSTED_ORIGIN');
    },

    config(userId: number) {
      const currency = [...allowedEnvs, 'live', 'demo'].map(env => deps.trading212.lastCurrency(env as StudioT212Environment)).find(Boolean);
      return {
        allowedEnvs, maxOrderValue, ...(currency ? { currency } : {}),
        passkeys: passkeys(userId).map(summary),
        trustedOrigins: origins, allowLocalhost, requirePasskey,
      };
    },

    async preview(userId: number, origin: StudioT212TrustedOrigin, input: StudioT212OrderInput, options: { acknowledgeUnknown?: boolean } = {}) {
      assertAllowed(input.env);
      prune();
      const keys = passkeys(userId, origin.rpId);
      if (!keys.length) {
        const refusal = doubleConfirmationRefusal(userId, origin.rpId);
        if (refusal) fail(refusal, 403, 'T212_PASSKEY_REQUIRED');
      }
      const acknowledgedUnknown = options.acknowledgeUnknown === true;
      const unresolved = acknowledgedUnknown ? null : unresolvedOrder(userId, input);
      if (unresolved) fail(unresolved, 409, 'T212_ORDER_UNKNOWN_PENDING');

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
      // Value of one share in the account currency.
      const perShare = position && position.quantity > 0 ? position.value / position.quantity : 0;
      let estimate: number;
      if (input.type === 'market') {
        estimate = input.quantity * perShare;
        warnings.push('市价单按当前价估算，实际成交价可能不同；休市时会在开盘后成交');
      } else {
        // A held position's value per quote unit is the most direct FX rate; anything else needs its quote currency.
        const conversion = position && position.currentPrice > 0 && perShare > 0
          ? { rate: perShare / position.currentPrice, note: null }
          : await quoteRate(input.env, input.ticker, overview);
        if (conversion.note) warnings.push(conversion.note);
        const atLimit = input.quantity * (input.limitPrice ?? 0) * conversion.rate;
        // A limit sell fills at its limit or better, i.e. at least near the market price, so a low limit must not
        // shrink the estimate below what the shares are worth and slip past the cap.
        estimate = input.side === 'sell' ? Math.max(atLimit, input.quantity * perShare) : atLimit;
      }
      if (input.type === 'limit' && input.timeValidity === 'GOOD_TILL_CANCEL') warnings.push('撤单前有效：未成交前订单会一直挂着，可以在 Trading 212 里撤单');
      const estimatedValue = round2(estimate);
      if (!(estimatedValue > 0)) fail('无法估算这笔订单的金额，请改用限价单', 400);
      if (estimatedValue > maxOrderValue) {
        fail(`预计金额 ${money(estimatedValue, currency)} 超过单笔上限 ${money(maxOrderValue, currency)}（STUDIO_T212_MAX_ORDER_VALUE）`, 400, 'T212_ORDER_CAP');
      }
      if (input.side === 'buy' && estimatedValue > overview.cash.available) warnings.push(`可用现金 ${money(overview.cash.available, currency)}，可能不足以成交`);
      if (acknowledgedUnknown) warnings.push('你已确认之前状态未知的相同订单没有成交');

      const authentication = keys.length ? await webauthn.generateAuthenticationOptions({
        rpID: origin.rpId, userVerification: 'required', timeout: PREVIEW_TTL_MS,
        allowCredentials: keys.map(row => ({ id: row.credential_id, transports: transports(row) })),
      }) : undefined;
      const preview: Preview = {
        ...input, id: randomUUID(), userId, estimatedValue, currency, origin: origin.origin, rpId: origin.rpId,
        requires: authentication ? 'passkey' : 'confirm', challenge: authentication?.challenge ?? null, expiresAt: now() + PREVIEW_TTL_MS,
        acknowledgedUnknown,
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
      // A parallel preview of the same order must not slip through after the first one ended unknown.
      const unresolved = preview.acknowledgedUnknown ? null : unresolvedOrder(userId, preview);
      if (unresolved) refuse(unresolved, 409, 'T212_ORDER_UNKNOWN_PENDING');

      if (preview.requires === 'passkey') {
        if (!('assertion' in proof)) refuse('这个域名已启用面容 ID / 触控 ID，请用通行密钥确认', 400);
        const row = passkeys(userId, preview.rpId).find(item => item.credential_id === proof.assertion.id);
        if (!row) refuse('通行密钥验证失败：这把通行密钥不属于当前域名', 403, 'T212_PASSKEY_FAILED');
        if (!await verifyAssertion(row, proof.assertion, preview.challenge ?? '', preview.origin)) refuse('通行密钥验证失败，订单没有提交', 403, 'T212_PASSKEY_FAILED');
      } else {
        if (!('confirmed' in proof) || proof.confirmed !== true) refuse('请先在二次确认里确认这笔订单', 400);
        // A passkey enabled after the preview raises the bar: the double confirmation no longer suffices.
        if (passkeys(userId, preview.rpId).length) refuse('这个域名刚启用了面容 ID / 触控 ID，请重新预览', 409);
        const refusal = doubleConfirmationRefusal(userId, preview.rpId);
        if (refusal) refuse(refusal, 403, 'T212_PASSKEY_REQUIRED');
      }

      const quantity = preview.side === 'sell' ? -preview.quantity : preview.quantity;
      const body = preview.type === 'market'
        ? { ticker: preview.ticker, quantity }
        : { ticker: preview.ticker, quantity, limitPrice: preview.limitPrice ?? 0, timeValidity: preview.timeValidity };
      let placed: Record<string, unknown>;
      try {
        placed = await deps.trading212.placeOrder(preview.env, preview.type, body);
      } catch (error) {
        // A timeout, 408 or 5xx may still have executed the order, so it is not recorded as a refusal.
        const unknown = error instanceof AppError && error.code === 'T212_ORDER_UNKNOWN';
        record(preview, method, { status: unknown ? 'unknown' : 'failed', error: error instanceof Error ? error.message : '下单失败' });
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

    // Starts adding a passkey for the request's domain; the password step-up comes before any challenge is issued.
    async passkeyOptions(userId: number, userName: string | undefined, origin: StudioT212TrustedOrigin, password: string) {
      prune();
      await assertPassword(userId, password);
      const options = await webauthn.generateRegistrationOptions({
        rpName: 'Agent Cloud Studio', rpID: origin.rpId,
        userName: userName?.trim() || `studio-${userId}`, userDisplayName: 'Studio 交易确认',
        // Stable per user, so re-registering on the same device replaces that device's passkey instead of adding one.
        userID: new Uint8Array(Buffer.from(`studio-user-${userId}`)),
        attestationType: 'none', timeout: 120_000,
        excludeCredentials: passkeys(userId, origin.rpId).map(row => ({ id: row.credential_id, transports: transports(row) })),
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      });
      registrations.set(`${userId}:${origin.rpId}`, { challenge: options.challenge, origin: origin.origin, expiresAt: now() + CEREMONY_TTL_MS });
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
        counter: credential.counter, transports: JSON.stringify(credential.transports ?? []), label: describePasskeyDevice(userAgent),
        created_at: isoNow(), last_used_at: null,
      };
      db.prepare(`INSERT INTO studio_t212_passkeys (id, user_id, rp_id, credential_id, public_key, counter, transports, label, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.user_id, row.rp_id, row.credential_id, row.public_key, row.counter, row.transports, row.label, row.created_at, row.last_used_at);
      return summary(row);
    },

    // Challenge for removing a passkey with that same passkey, which only works on the passkey's own domain.
    async removalOptions(userId: number, origin: StudioT212TrustedOrigin, id: string) {
      prune();
      const row = findPasskey(userId, id);
      if (row.rp_id !== origin.rpId) fail(`这把通行密钥属于 ${row.rp_id}，只能在那个网址用它授权移除；在这里请输入 Studio 密码`, 400, 'T212_STEP_UP_FAILED');
      const options = await webauthn.generateAuthenticationOptions({
        rpID: row.rp_id, userVerification: 'required', timeout: 120_000,
        allowCredentials: [{ id: row.credential_id, transports: transports(row) }],
      });
      removals.set(`${userId}:${id}`, { challenge: options.challenge, origin: origin.origin, expiresAt: now() + CEREMONY_TTL_MS });
      return options;
    },

    async removePasskey(userId: number, origin: StudioT212TrustedOrigin, id: string, stepUp: StepUp) {
      const row = findPasskey(userId, id);
      if ('password' in stepUp) {
        await assertPassword(userId, stepUp.password);
      } else {
        const key = `${userId}:${id}`;
        const pending = removals.get(key);
        removals.delete(key);
        if (!pending || pending.expiresAt <= now() || pending.origin !== origin.origin || row.rp_id !== origin.rpId) {
          fail('通行密钥授权已过期或不属于当前网址，请重新开始', 400, 'T212_STEP_UP_FAILED');
        }
        if (!await verifyAssertion(row, stepUp.assertion, pending.challenge, pending.origin)) fail('通行密钥验证失败，没有移除', 403, 'T212_STEP_UP_FAILED');
      }
      db.prepare('DELETE FROM studio_t212_passkeys WHERE id = ? AND user_id = ?').run(id, userId);
      return { removed: true };
    },
  };
}
