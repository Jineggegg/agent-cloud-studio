import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport, RegistrationResponseJSON } from '@simplewebauthn/server';

import type {
  StudioT212BrokerOrderResult,
  StudioT212BrokerPasskey,
  StudioT212BrokerPreview,
  StudioT212BrokerStatus,
  StudioT212Environment,
  StudioT212OrderInput,
} from '@/shared/types.js';

import { BrokerError } from './broker-error.js';
import type { loadBrokerConfig } from './broker.config.js';
import type { createBrokerRepository } from './broker.repository.js';
import type { createBrokerTrading212Client } from './broker-trading212.client.js';

type Environment = StudioT212Environment;
type WebAuthn = {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
};
type Repository = ReturnType<typeof createBrokerRepository>;
type Trading212 = Pick<ReturnType<typeof createBrokerTrading212Client>, 'overview' | 'instrumentCurrency' | 'placeOrder' | 'keyConfigured' | 'lastCurrency'>;
type Overview = Awaited<ReturnType<Trading212['overview']>>;
type Dependencies = {
  config: ReturnType<typeof loadBrokerConfig>;
  repository: Repository;
  trading212: Trading212;
  // SimpleWebAuthn functions; injectable so tests never need a real authenticator.
  webauthn?: WebAuthn;
  now?: () => number;
  // One line per security-relevant event (journal). Never receives secrets, codes or request bodies.
  log?: (line: string) => void;
};
type PasskeyRow = ReturnType<Repository['passkeys']>[number];
type TrustedOrigin = { origin: string; rpId: string };
// What a stored order challenge is bound to; it never leaves the broker's database.
type PendingOrder = {
  order: StudioT212OrderInput; estimatedValue: number; currency: string;
  requires: 'passkey' | 'confirm'; acknowledgedUnknown: boolean;
};
type OrderProof = { assertion: AuthenticationResponseJSON } | { confirmed: true };
type RemovalProof = { assertion: AuthenticationResponseJSON } | { enrollmentCode: string };

// A reviewed order must be confirmed within a minute, so the estimate it was approved on is still close.
const PREVIEW_TTL_MS = 60_000;
// Registration and removal ceremonies (the browser prompt may wait for the user a little longer).
const CEREMONY_TTL_MS = 5 * 60_000;
const ENROLLMENT_CODE_TTL_MS = 10 * 60_000;
// After an order whose outcome is unknown, an identical order is refused for this long unless acknowledged.
const UNKNOWN_HOLD_MS = 5 * 60_000;
// Failed passkey assertions and wrong enrollment codes: ten in fifteen minutes lock that action for the window.
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
// Unanswered challenges anyone on the socket can create; beyond this new ones are refused until some expire.
const MAX_ACTIVE_CHALLENGES = 50;
const HOUR_MS = 60 * 60_000;
// Crockford base32 without I, L, O, U: 20 symbols carry 100 bits and are easy to type on an iPad.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 20;
const ENV_LABEL: Record<Environment, string> = { live: '实盘', demo: '模拟盘' };
const SIDE_LABEL = { buy: '买入', sell: '卖出' } as const;
const DEFAULT_WEBAUTHN: WebAuthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

function fail(message: string, statusCode: number, code = 'T212_ORDER_REFUSED'): never {
  throw new BrokerError(message, statusCode, code);
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
// Typed codes may contain spaces, dashes, lower case and the look-alikes O / I / L; anything else is invalid.
function normalizeCode(value: string) {
  const code = value.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === CODE_LENGTH && [...code].every(char => CODE_ALPHABET.includes(char)) ? code : null;
}
function hashCode(code: string) {
  return createHash('sha256').update(`studio-trader-enrollment:${code}`).digest('hex');
}
// The challenge a WebAuthn response answers, read from its clientDataJSON; the signature check comes later.
function answeredChallenge(response: { response?: { clientDataJSON?: unknown } }) {
  const raw = response.response?.clientDataJSON;
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof data.challenge === 'string' && data.challenge.length <= 512 ? data.challenge : null;
  } catch { return null; }
}
function transports(row: PasskeyRow) {
  try {
    const value: unknown = JSON.parse(row.transports);
    return (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []) as AuthenticatorTransport[];
  } catch { return []; }
}
function summary(row: PasskeyRow): StudioT212BrokerPasskey {
  return { id: row.id, rpId: row.rp_id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

/**
 * Used by the broker socket server and CLI. This is the only code that can place Trading 212 orders with the
 * order key, so it trusts nothing its caller says: it checks the origin against its own allowlist, values the
 * order with its own Trading 212 reads, stores a single-use challenge bound to the exact order, RP ID and a
 * 60-second expiry, and places the order once only after a passkey assertion verified against its own records
 * (user verification required, counter advanced). Passkeys are enrolled only with a one-time enrollment code
 * that the owner prints with the CLI as the broker's OS user; Studio's OS user cannot produce one.
 */
export function createBrokerService(deps: Dependencies) {
  const { config, repository: repo, trading212 } = deps;
  const now = deps.now ?? Date.now;
  const webauthn = deps.webauthn ?? DEFAULT_WEBAUTHN;
  const log = deps.log ?? ((line: string) => console.log(`[t212-broker] ${line}`));
  const iso = () => new Date(now()).toISOString();

  function trusted(origin: string): TrustedOrigin {
    if (!config.origins.includes(origin)) {
      fail(`当前网址 ${origin.slice(0, 120)} 不在交易代理的白名单：在 /var/lib/studio-trader/config.json 的 origins 里加入后重启交易代理`, 403, 'T212_UNTRUSTED_ORIGIN');
    }
    return { origin, rpId: new URL(origin).hostname };
  }
  function prune() {
    const time = now();
    repo.pruneChallenges(time);
    repo.pruneEnrollmentCodes(time);
    repo.pruneFailures(time - FAILURE_WINDOW_MS);
  }
  function assertNotLocked(bucket: 'assertion' | 'enroll') {
    if (repo.failuresSince(bucket, now() - FAILURE_WINDOW_MS) >= MAX_FAILURES) {
      fail(bucket === 'assertion' ? '通行密钥验证失败次数过多，请 15 分钟后再试' : '注册码错误次数过多，请 15 分钟后再试', 429, 'T212_LOCKED');
    }
  }
  function assertRoomForChallenge() {
    if (repo.activeChallenges(now()) >= MAX_ACTIVE_CHALLENGES) fail('未完成的确认请求太多，请稍后再试', 429, 'T212_TOO_MANY_PENDING');
  }
  function assertAllowed(env: Environment) {
    if (!config.allowedEnvs.includes(env)) fail(`${ENV_LABEL[env]}下单未开启：在交易代理的 config.json 的 allowedEnvs 里加入 "${env}" 后重启交易代理`, 403, 'T212_TRADING_DISABLED');
  }
  function hourlyRefusal() {
    const count = repo.submittedSince(now() - HOUR_MS);
    return count >= config.maxOrdersPerHour ? `一小时内已经提交了 ${count} 笔订单，达到交易代理的上限（maxOrdersPerHour = ${config.maxOrdersPerHour}）` : null;
  }
  function unknownRefusal(order: StudioT212OrderInput) {
    const at = repo.unknownSince(order, now() - UNKNOWN_HOLD_MS);
    if (at === null) return null;
    const minutes = Math.max(1, Math.round((now() - at) / 60_000));
    return `约 ${minutes} 分钟前一笔相同的订单（${SIDE_LABEL[order.side]} ${order.quantity} 股 ${order.ticker}）状态未知：请先在 Trading 212 核对它是否已经成交；确认没有成交后，再明确确认重新下单`;
  }
  // Checks a typed enrollment code and, only when `consume` is set, deletes it. Wrong codes count as failures.
  function checkEnrollmentCode(value: string, consume: boolean) {
    assertNotLocked('enroll');
    const code = normalizeCode(value);
    const hash = code ? hashCode(code) : null;
    const valid = hash !== null && (consume ? repo.takeEnrollmentCode(hash, now()) : repo.enrollmentCodeValid(hash, now()));
    if (!valid || !hash) {
      repo.recordFailure('enroll', now());
      log('refused an invalid enrollment code');
      fail('注册码无效、已用过或已过期：请在服务器上用 studio-trader enroll-code 重新生成', 403, 'T212_ENROLL_CODE_INVALID');
    }
    return hash;
  }
  // Verifies one assertion against one stored credential with user verification required, then advances its counter.
  async function verifyAssertion(row: PasskeyRow, assertion: AuthenticationResponseJSON, challenge: { challenge: string; origin: string; rp_id: string }) {
    if (assertion.id !== row.credential_id || row.rp_id !== challenge.rp_id) return false;
    let verified: Awaited<ReturnType<WebAuthn['verifyAuthenticationResponse']>> | null = null;
    try {
      verified = await webauthn.verifyAuthenticationResponse({
        response: assertion, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rp_id,
        credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: transports(row) },
        requireUserVerification: true,
      });
    } catch { verified = null; }
    if (!verified?.verified) return false;
    const next = verified.authenticationInfo.newCounter;
    // A counter that did not move forwards suggests a cloned authenticator. Authenticators that never count
    // (always 0, like iCloud Keychain passkeys) stay valid.
    if ((row.counter > 0 || next > 0) && next <= row.counter) {
      log(`passkey ${row.id} presented a counter that did not increase (stored ${row.counter}, got ${next})`);
      return false;
    }
    repo.recordPasskeyUse(row.id, next, iso());
    return true;
  }
  // Account-currency value of one unit of an instrument's quote currency (one dollar, or one penny for GBX). The
  // account's own currency needs no rate; otherwise a held position quoted in the same currency gives it
  // (value ÷ quantity ÷ current price). Without one the order is refused instead of being valued 1:1.
  async function quoteRate(env: Environment, ticker: string, overview: Overview) {
    const quoted = await trading212.instrumentCurrency(env, ticker);
    if (!quoted) fail(`Trading 212 没有 ${ticker} 这个代码：请检查代码，例如 AAPL_US_EQ`, 400, 'T212_UNKNOWN_INSTRUMENT');
    const unit = quoteUnit(quoted);
    if (overview.currency && unit.currency === overview.currency) {
      return { rate: unit.scale, note: unit.scale === 1 ? null : `${ticker} 以便士（GBX）计价：限价按便士填写，金额按 100 便士 = 1 英镑换算` };
    }
    for (const held of overview.positions) {
      if (!held.currency || !(held.quantity > 0) || !(held.currentPrice > 0) || !(held.value > 0)) continue;
      const heldUnit = quoteUnit(held.currency);
      if (heldUnit.currency !== unit.currency) continue;
      const perMajorUnit = held.value / held.quantity / held.currentPrice / heldUnit.scale;
      return { rate: perMajorUnit * unit.scale, note: `${ticker} 以 ${quoted} 计价：按 ${held.ticker} 持仓推算的汇率换算成 ${overview.currency}，仅为估算` };
    }
    fail(`${ticker} 以 ${quoted} 计价，账户货币是 ${overview.currency || '未知'}：账户里没有同币种的持仓可以推算汇率，交易代理不会按 1:1 估算，订单没有生成。可以直接在 Trading 212 里下这笔单`, 400, 'T212_FX_UNKNOWN');
  }
  async function valuation(order: StudioT212OrderInput, overview: Overview) {
    const position = overview.positions.find(item => item.ticker === order.ticker && item.quantity > 0);
    if (order.side === 'sell') {
      if (!position) fail(`没有持有 ${order.ticker}，不能卖出`, 400);
      if (order.quantity > position.quantity + 1e-9) fail(`卖出数量超过持仓：只持有 ${position.quantity} 股`, 400);
    }
    if (order.type === 'market' && !position) fail('未持有的标的无法按市价估算金额，请改用限价单', 400);
    const warnings: string[] = [];
    if (order.env === 'live') warnings.push('实盘账户：这笔订单会用真实资金成交');
    // Value of one share in the account currency.
    const perShare = position && position.quantity > 0 ? position.value / position.quantity : 0;
    let estimate: number;
    if (order.type === 'market') {
      estimate = order.quantity * perShare;
      warnings.push('市价单按当前价估算，实际成交价可能不同；休市时会在开盘后成交');
    } else {
      // A held position's value per quote unit is the most direct FX rate; anything else needs its quote currency.
      const conversion = position && position.currentPrice > 0 && perShare > 0
        ? { rate: perShare / position.currentPrice, note: null }
        : await quoteRate(order.env, order.ticker, overview);
      if (conversion.note) warnings.push(conversion.note);
      const atLimit = order.quantity * (order.limitPrice ?? 0) * conversion.rate;
      // A limit sell fills at its limit or better, i.e. near the market, so a token limit must not shrink the
      // estimate below what the shares are worth and slip past the cap.
      estimate = order.side === 'sell' ? Math.max(atLimit, order.quantity * perShare) : atLimit;
      if (order.timeValidity === 'GOOD_TILL_CANCEL') warnings.push('撤单前有效：未成交前订单会一直挂着，可以在 Trading 212 里撤单');
    }
    const estimatedValue = round2(estimate);
    if (!(estimatedValue > 0)) fail('无法估算这笔订单的金额，请改用限价单', 400);
    if (estimatedValue > config.maxOrderValue) {
      fail(`预计金额 ${money(estimatedValue, overview.currency)} 超过交易代理的单笔上限 ${money(config.maxOrderValue, overview.currency)}`, 400, 'T212_ORDER_CAP');
    }
    if (order.side === 'buy' && estimatedValue > overview.cashAvailable) warnings.push(`可用现金 ${money(overview.cashAvailable, overview.currency)}，可能不足以成交`);
    return { estimatedValue, warnings };
  }

  return {
    status(): StudioT212BrokerStatus {
      const currencies: Partial<Record<Environment, string>> = {};
      for (const env of ['live', 'demo'] as Environment[]) {
        const currency = trading212.lastCurrency(env);
        if (currency) currencies[env] = currency;
      }
      return {
        version: 1, allowedEnvs: config.allowedEnvs, maxOrderValue: config.maxOrderValue, maxOrdersPerHour: config.maxOrdersPerHour,
        origins: config.origins, demoConfirm: config.demoConfirm,
        keys: { live: trading212.keyConfigured('live'), demo: trading212.keyConfigured('demo') },
        currencies, passkeys: repo.passkeys().map(summary),
      };
    },

    async preview(input: { origin: string; order: StudioT212OrderInput; acknowledgeUnknown: boolean }): Promise<StudioT212BrokerPreview> {
      const origin = trusted(input.origin);
      const { order } = input;
      assertAllowed(order.env);
      prune();
      const hourly = hourlyRefusal();
      if (hourly) fail(hourly, 429, 'T212_HOURLY_LIMIT');
      const keys = repo.passkeys(origin.rpId);
      // Live orders always need a passkey; demo orders may use a plain confirmation only if the owner allowed it.
      const requires = keys.length ? 'passkey' : order.env === 'demo' && config.demoConfirm ? 'confirm' : null;
      if (!requires) fail(`先为 ${origin.rpId} 启用通行密钥：交易代理只接受通行密钥确认的订单，启用需要服务器上生成的注册码`, 403, 'T212_PASSKEY_REQUIRED');
      const unknown = input.acknowledgeUnknown ? null : unknownRefusal(order);
      if (unknown) fail(unknown, 409, 'T212_ORDER_UNKNOWN_PENDING');
      assertRoomForChallenge();

      const overview = await trading212.overview(order.env);
      const { estimatedValue, warnings } = await valuation(order, overview);
      if (input.acknowledgeUnknown) warnings.push('你已确认之前状态未知的相同订单没有成交');
      const authentication = requires === 'passkey' ? await webauthn.generateAuthenticationOptions({
        rpID: origin.rpId, userVerification: 'required', timeout: PREVIEW_TTL_MS,
        allowCredentials: keys.map(row => ({ id: row.credential_id, transports: transports(row) })),
      }) : undefined;
      const id = randomUUID();
      const expiresAt = now() + PREVIEW_TTL_MS;
      const pending: PendingOrder = { order, estimatedValue, currency: overview.currency, requires, acknowledgedUnknown: input.acknowledgeUnknown };
      repo.insertChallenge({
        id, kind: 'order', challenge: authentication?.challenge ?? randomBytes(32).toString('base64url'),
        rp_id: origin.rpId, origin: origin.origin, payload: JSON.stringify(pending), expires_at: expiresAt,
      });
      return {
        id, env: order.env, ticker: order.ticker, side: order.side, type: order.type, quantity: order.quantity,
        ...(order.type === 'limit' ? { limitPrice: order.limitPrice, timeValidity: order.timeValidity } : {}),
        estimatedValue, currency: overview.currency, maxOrderValue: config.maxOrderValue, warnings,
        expiresAt: new Date(expiresAt).toISOString(), requires,
        ...(authentication ? { authentication: authentication as unknown as Record<string, unknown> } : {}),
      };
    },

    async confirm(input: { origin: string; id: string; proof: OrderProof }): Promise<StudioT212BrokerOrderResult> {
      const origin = trusted(input.origin);
      assertNotLocked('assertion');
      // Single use: the challenge is deleted by the first attempt, whatever its outcome.
      const row = repo.takeChallengeById(input.id, 'order');
      if (!row) fail('这笔订单预览不存在、已使用或已过期，请重新预览', 404, 'T212_PREVIEW_GONE');
      const pending = JSON.parse(row.payload) as PendingOrder;
      const { order } = pending;
      const method = 'assertion' in input.proof ? 'passkey' : 'confirm';
      let passkeyId: string | null = null;
      function audit(status: 'placed' | 'rejected' | 'unknown' | 'refused', extra: { brokerOrderId?: string | null; brokerStatus?: string | null; error?: string } = {}) {
        repo.recordAudit({
          previewId: row!.id, env: order.env, ticker: order.ticker, side: order.side, type: order.type, quantity: order.quantity,
          limitPrice: order.limitPrice ?? null, estimatedValue: pending.estimatedValue, currency: pending.currency, method,
          rpId: row!.rp_id, passkeyId, status, ...extra,
        }, now());
      }
      function refuse(message: string, statusCode: number, code: string): never {
        audit('refused', { error: message });
        fail(message, statusCode, code);
      }
      if (row.expires_at <= now()) refuse('订单预览已超过 60 秒，请重新预览', 410, 'T212_PREVIEW_EXPIRED');
      if (row.origin !== origin.origin) refuse('请在发起预览的同一个网址确认订单', 403, 'T212_UNTRUSTED_ORIGIN');
      if (!config.allowedEnvs.includes(order.env)) refuse(`${ENV_LABEL[order.env]}下单未开启`, 403, 'T212_TRADING_DISABLED');
      const hourly = hourlyRefusal();
      if (hourly) refuse(hourly, 429, 'T212_HOURLY_LIMIT');
      // A parallel preview of the same order must not slip through after the first one ended unknown.
      const unknown = pending.acknowledgedUnknown ? null : unknownRefusal(order);
      if (unknown) refuse(unknown, 409, 'T212_ORDER_UNKNOWN_PENDING');

      if (pending.requires === 'passkey') {
        const proof = input.proof;
        if (!('assertion' in proof)) refuse('请用通行密钥确认这笔订单', 400, 'T212_PASSKEY_REQUIRED');
        const key = repo.passkeys(row.rp_id).find(item => item.credential_id === proof.assertion.id);
        if (!key || !await verifyAssertion(key, proof.assertion, row)) {
          repo.recordFailure('assertion', now());
          log(`refused an order confirmation: passkey verification failed (rpId ${row.rp_id})`);
          refuse('通行密钥验证失败，订单没有提交', 403, 'T212_PASSKEY_FAILED');
        }
        passkeyId = key.id;
      } else {
        // Without a passkey only demo orders, and only while the owner still allows it.
        if (order.env !== 'demo' || !config.demoConfirm) refuse('这笔订单需要通行密钥确认', 403, 'T212_PASSKEY_REQUIRED');
        if (!('confirmed' in input.proof) || input.proof.confirmed !== true) refuse('请先确认这笔订单', 400, 'T212_CONFIRM_REQUIRED');
      }

      const quantity = order.side === 'sell' ? -order.quantity : order.quantity;
      const body = order.type === 'market'
        ? { ticker: order.ticker, quantity }
        : { ticker: order.ticker, quantity, limitPrice: order.limitPrice ?? 0, timeValidity: order.timeValidity };
      let result: Awaited<ReturnType<Trading212['placeOrder']>>;
      try {
        result = await trading212.placeOrder(order.env, order.type, body);
      } catch (error) {
        // Only a missing key throws here, before anything was sent.
        refuse(error instanceof Error ? error.message : '下单失败', 503, 'TRADING212_ERROR');
      }
      const label = `${order.env} ${order.side} ${order.quantity} ${order.ticker}`;
      if (result.status !== 'placed') {
        audit(result.status, { error: result.message });
        log(`order ${result.status}: ${label}`);
        if (result.status === 'unknown') fail(result.message, 502, 'T212_ORDER_UNKNOWN');
        fail(result.message, 400, 'TRADING212_REJECTED');
      }
      const placed = result.order;
      const brokerOrder = {
        id: text(placed.id), status: text(placed.status), ticker: text(placed.ticker) ?? order.ticker,
        side: text(placed.side), type: text(placed.type), quantity: numberOrNull(placed.quantity),
        filledQuantity: numberOrNull(placed.filledQuantity), limitPrice: numberOrNull(placed.limitPrice), createdAt: text(placed.createdAt),
      };
      audit('placed', { brokerOrderId: brokerOrder.id, brokerStatus: brokerOrder.status });
      log(`order placed: ${label} (Trading 212 order ${brokerOrder.id ?? '?'}, ${method})`);
      return { order: brokerOrder, method, env: order.env, estimatedValue: pending.estimatedValue, currency: pending.currency };
    },

    // Registration options only for a valid enrollment code; the code is consumed when a passkey is stored.
    async registrationOptions(input: { origin: string; enrollmentCode: string }) {
      const origin = trusted(input.origin);
      prune();
      const codeHash = checkEnrollmentCode(input.enrollmentCode, false);
      assertRoomForChallenge();
      const options = await webauthn.generateRegistrationOptions({
        rpName: 'Agent Cloud Studio 交易代理', rpID: origin.rpId,
        userName: 'studio-owner', userDisplayName: 'Studio 交易确认',
        // One owner: re-registering on the same device replaces that device's passkey instead of adding one.
        userID: new Uint8Array(Buffer.from('studio-trader-owner')),
        attestationType: 'none', timeout: 120_000,
        excludeCredentials: repo.passkeys(origin.rpId).map(row => ({ id: row.credential_id, transports: transports(row) })),
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      });
      repo.insertChallenge({
        id: randomUUID(), kind: 'register', challenge: options.challenge, rp_id: origin.rpId, origin: origin.origin,
        payload: JSON.stringify({ codeHash }), expires_at: now() + CEREMONY_TTL_MS,
      });
      return options;
    },

    async register(input: { origin: string; response: RegistrationResponseJSON; label: string | null }) {
      const origin = trusted(input.origin);
      const challenge = answeredChallenge(input.response);
      const row = challenge ? repo.takeChallengeByValue(challenge, 'register') : undefined;
      if (!row || row.expires_at <= now() || row.origin !== origin.origin) fail('通行密钥注册已过期，请重新开始', 400, 'T212_PASSKEY_FAILED');
      let verified: Awaited<ReturnType<WebAuthn['verifyRegistrationResponse']>> | null = null;
      try {
        verified = await webauthn.verifyRegistrationResponse({
          response: input.response, expectedChallenge: row.challenge, expectedOrigin: row.origin, expectedRPID: row.rp_id, requireUserVerification: true,
        });
      } catch { verified = null; }
      if (!verified?.verified) fail('通行密钥注册失败：设备没有通过验证', 400, 'T212_PASSKEY_FAILED');
      const { credential } = verified.registrationInfo;
      if (repo.credentialExists(credential.id)) fail('这把通行密钥已经登记过了', 409, 'T212_PASSKEY_EXISTS');
      // The code is consumed only now, so a cancelled Face ID prompt does not waste it; it enrols one passkey.
      const { codeHash } = JSON.parse(row.payload) as { codeHash: string };
      if (!repo.takeEnrollmentCode(codeHash, now())) fail('注册码已用过或已过期：请在服务器上重新生成', 403, 'T212_ENROLL_CODE_INVALID');
      const passkey: PasskeyRow = {
        id: randomUUID(), rp_id: row.rp_id, credential_id: credential.id, public_key: Buffer.from(credential.publicKey),
        counter: credential.counter, transports: JSON.stringify(credential.transports ?? []), label: input.label,
        created_at: iso(), last_used_at: null,
      };
      repo.insertPasskey(passkey);
      log(`passkey ${passkey.id} enrolled for ${passkey.rp_id}${passkey.label ? ` (${passkey.label})` : ''}`);
      return summary(passkey);
    },

    // Removal is authorised by any passkey of the current RP ID, so a lost device can be removed from another one.
    async removalOptions(input: { origin: string; id: string }) {
      const origin = trusted(input.origin);
      prune();
      if (!repo.passkey(input.id)) fail('找不到这把通行密钥', 404, 'T212_PASSKEY_NOT_FOUND');
      const keys = repo.passkeys(origin.rpId);
      if (!keys.length) fail(`${origin.rpId} 没有通行密钥可以授权移除：请改用注册码`, 400, 'T212_STEP_UP_REQUIRED');
      assertRoomForChallenge();
      const options = await webauthn.generateAuthenticationOptions({
        rpID: origin.rpId, userVerification: 'required', timeout: 120_000,
        allowCredentials: keys.map(row => ({ id: row.credential_id, transports: transports(row) })),
      });
      repo.insertChallenge({
        id: randomUUID(), kind: 'remove', challenge: options.challenge, rp_id: origin.rpId, origin: origin.origin,
        payload: JSON.stringify({ target: input.id }), expires_at: now() + CEREMONY_TTL_MS,
      });
      return options;
    },

    async removePasskey(input: { origin: string; id: string; proof: RemovalProof }) {
      const origin = trusted(input.origin);
      if (!repo.passkey(input.id)) fail('找不到这把通行密钥', 404, 'T212_PASSKEY_NOT_FOUND');
      if ('enrollmentCode' in input.proof) {
        checkEnrollmentCode(input.proof.enrollmentCode, true);
      } else {
        assertNotLocked('assertion');
        const { assertion } = input.proof;
        const challenge = answeredChallenge(assertion);
        const row = challenge ? repo.takeChallengeByValue(challenge, 'remove') : undefined;
        const target = row ? (JSON.parse(row.payload) as { target?: string }).target : undefined;
        if (!row || row.expires_at <= now() || row.origin !== origin.origin || target !== input.id) {
          fail('通行密钥授权已过期或不属于当前网址，请重新开始', 400, 'T212_STEP_UP_FAILED');
        }
        const key = repo.passkeys(row.rp_id).find(item => item.credential_id === assertion.id);
        if (!key || !await verifyAssertion(key, assertion, row)) {
          repo.recordFailure('assertion', now());
          log(`refused a passkey removal: passkey verification failed (rpId ${row.rp_id})`);
          fail('通行密钥验证失败，没有移除', 403, 'T212_STEP_UP_FAILED');
        }
      }
      repo.deletePasskey(input.id);
      log(`passkey ${input.id} removed`);
      return { removed: true as const };
    },

    // CLI only (run as the broker's OS user): prints once; only its hash is stored.
    createEnrollmentCode() {
      prune();
      const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const expiresAt = now() + ENROLLMENT_CODE_TTL_MS;
      repo.insertEnrollmentCode(hashCode(code), expiresAt, iso());
      log('enrollment code created');
      return { code: code.match(/.{5}/g)!.join('-'), expiresAt: new Date(expiresAt).toISOString() };
    },
    // CLI only: passkeys for review, and removal without any proof (the CLI already runs as the broker's user).
    passkeys() {
      return repo.passkeys().map(summary);
    },
    revokePasskey(id: string) {
      const removed = repo.deletePasskey(id);
      if (removed) log(`passkey ${id} revoked from the CLI`);
      return removed;
    },
    audit(limit: number) {
      return repo.audit(limit);
    },
  };
}
