import { existsSync, readFileSync } from 'node:fs';

import type { StudioT212Environment } from '@/shared/types.js';

import { BrokerError } from './broker-error.js';

type Environment = StudioT212Environment;
// Exactly the body Trading 212 documents for POST /equity/orders/market and /equity/orders/limit; a negative
// quantity sells.
type OrderBody =
  | { ticker: string; quantity: number }
  | { ticker: string; quantity: number; limitPrice: number; timeValidity: 'DAY' | 'GOOD_TILL_CANCEL' };
type Json = Record<string, unknown>;
type Dependencies = {
  // `.env`-style files holding TRADING212_API_KEY / TRADING212_API_SECRET, inside the broker's state directory.
  keyFiles: Record<Environment, string>;
  request?: typeof fetch;
  now?: () => number;
};

const BASE_URL: Record<Environment, string> = {
  live: 'https://live.trading212.com/api/v0',
  demo: 'https://demo.trading212.com/api/v0',
};
// Short caches keep previews inside Trading 212's rate limits (summary 1/5 s, positions 1/1 s).
const TTL = { summary: 10_000, positions: 5_000 };
// The instrument list allows one call per 50 s and changes rarely, so the ticker → currency map lives a day.
const INSTRUMENTS_TTL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

function fail(message: string, statusCode = 502): never {
  throw new BrokerError(message, statusCode, 'TRADING212_ERROR');
}
function num(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function obj(value: unknown): Json {
  return value && typeof value === 'object' ? value as Json : {};
}
// KEY=value lines; quotes around a value are removed. Nothing else of the file is interpreted.
function parseKeyFile(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
// Validation text such as "InsufficientFreeForStocksBuy" helps the owner; it is reduced to plain characters and
// a short length so nothing unexpected from the response body is echoed.
async function rejectionReason(response: Response) {
  const body = obj(await response.json().catch(() => null));
  const text = [body.clarification, body.message, body.errorMessage, body.code, body.type]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const clean = text?.replace(/[^\p{L}\p{N} .,:;()'%_/-]/gu, '').trim().slice(0, 160);
  return clean ? `：${clean}` : '';
}

/**
 * Used by the broker service: the broker's own Trading 212 access with the order-capable key. It reads the account
 * summary, positions and instrument currencies to value orders itself (Studio's valuation is never trusted), and
 * POSTs an order exactly once. Placement returns an outcome instead of throwing, so the service can audit it:
 * a timeout, 408 or 5xx may still have executed the order and is reported as 'unknown', never retried.
 */
export function createBrokerTrading212Client(deps: Dependencies) {
  const request = deps.request ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: unknown }>();
  const currencies: Partial<Record<Environment, string>> = {};
  const instruments: Partial<Record<Environment, { at: number; byTicker: Map<string, string> }>> = {};
  const instrumentLoads: Partial<Record<Environment, Promise<Map<string, string>>>> = {};

  // Read per request so rotating the key needs no restart; the values never leave this function's callers.
  function credentials(env: Environment) {
    const file = deps.keyFiles[env];
    if (!file || !existsSync(file)) return null;
    const values = parseKeyFile(readFileSync(file, 'utf8'));
    const key = values.TRADING212_API_KEY?.trim();
    const secret = values.TRADING212_API_SECRET;
    return key && secret ? `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` : null;
  }
  function requireCredentials(env: Environment) {
    const auth = credentials(env);
    if (!auth) fail(`交易代理没有${env === 'live' ? '实盘' : '模拟盘'}下单密钥：用 studio-trader set-key ${env} 写入`, 503);
    return auth;
  }
  async function fetchJson<T>(env: Environment, route: string): Promise<T> {
    const authorization = requireCredentials(env);
    let response: Response;
    try {
      response = await request(`${BASE_URL[env]}${route}`, {
        method: 'GET', headers: { Accept: 'application/json', Authorization: authorization },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
      });
    } catch {
      fail('Trading 212 无法连接，请稍后重试');
    }
    if (response.status === 401 || response.status === 403) fail('Trading 212 认证失败：请检查交易代理的下单密钥（需要 account、portfolio、metadata 读取权限）');
    if (response.status === 429) fail('Trading 212 请求过于频繁，请稍后再试', 429);
    if (!response.ok) fail(`Trading 212 暂时不可用（${response.status}）`);
    return await response.json() as T;
  }
  async function cached<T>(env: Environment, route: string, ttl: number): Promise<T> {
    const key = `${env}:${route}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value as T;
    const value = await fetchJson<T>(env, route);
    cache.set(key, { at: now(), value });
    return value;
  }
  function invalidate(env: Environment) {
    for (const key of [...cache.keys()]) if (key.startsWith(`${env}:`)) cache.delete(key);
  }

  return {
    keyConfigured(env: Environment) {
      return Boolean(credentials(env));
    },
    // Account currency from the last summary this process read, or undefined before the first preview.
    lastCurrency(env: Environment) {
      return currencies[env];
    },
    // Only what valuation needs: account currency, free cash and each position's size, price and value.
    async overview(env: Environment) {
      const [summary, positions] = await Promise.all([
        cached<unknown>(env, '/equity/account/summary', TTL.summary).then(obj),
        cached<unknown>(env, '/equity/positions', TTL.positions),
      ]);
      const currency = String(summary.currency ?? '').trim().toUpperCase();
      if (currency) currencies[env] = currency;
      return {
        currency,
        cashAvailable: num(obj(summary.cash).availableToTrade),
        positions: (Array.isArray(positions) ? positions.map(obj) : []).map(position => {
          const instrument = obj(position.instrument);
          return {
            ticker: String(instrument.ticker ?? position.ticker ?? ''),
            currency: String(instrument.currency ?? '').trim().toUpperCase(),
            quantity: num(position.quantity),
            currentPrice: num(position.currentPrice),
            value: num(obj(position.walletImpact).currentValue),
          };
        }),
      };
    },
    // Quote currency of any instrument (USD, EUR, GBX for pence…), or null when Trading 212 does not list it.
    async instrumentCurrency(env: Environment, ticker: string) {
      const hit = instruments[env];
      if (hit && now() - hit.at < INSTRUMENTS_TTL_MS) return hit.byTicker.get(ticker) ?? null;
      let load = instrumentLoads[env];
      if (!load) {
        load = (async () => {
          const list = await fetchJson<unknown>(env, '/equity/metadata/instruments');
          const byTicker = new Map<string, string>();
          for (const item of Array.isArray(list) ? list.map(obj) : []) {
            const code = typeof item.ticker === 'string' ? item.ticker : '';
            const currency = typeof item.currencyCode === 'string' ? item.currencyCode.trim().toUpperCase() : '';
            if (code && currency) byTicker.set(code, currency);
          }
          instruments[env] = { at: now(), byTicker };
          return byTicker;
        })();
        instrumentLoads[env] = load;
        void load.catch(() => {}).finally(() => { if (instrumentLoads[env] === load) delete instrumentLoads[env]; });
      }
      return (await load).get(ticker) ?? null;
    },
    // Trading 212's order endpoints are not idempotent, so this POSTs exactly once and reports what happened.
    async placeOrder(env: Environment, type: 'market' | 'limit', body: OrderBody):
      Promise<{ status: 'placed'; order: Json } | { status: 'rejected' | 'unknown'; message: string }> {
      const authorization = requireCredentials(env);
      let response: Response;
      try {
        response = await request(`${BASE_URL[env]}/equity/orders/${type}`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
          body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
        });
      } catch {
        invalidate(env);
        return { status: 'unknown', message: 'Trading 212 没有响应，订单状态未知：请先在 Trading 212 里确认，交易代理不会自动重试' };
      }
      invalidate(env);
      if (response.status === 408) return { status: 'unknown', message: 'Trading 212 处理超时，订单状态未知：请先在 Trading 212 里确认' };
      if (response.status >= 500) return { status: 'unknown', message: `Trading 212 返回 ${response.status}，订单状态未知：请先在 Trading 212 里确认` };
      if (response.status === 401) return { status: 'rejected', message: 'Trading 212 认证失败：请检查交易代理的下单密钥与实盘或模拟环境' };
      if (response.status === 403) return { status: 'rejected', message: 'Trading 212 拒绝下单：交易代理的密钥需要 orders:execute 权限，或检查 IP 限制' };
      if (response.status === 429) return { status: 'rejected', message: 'Trading 212 下单过于频繁，请稍后再试' };
      // Any other 4xx is a definite refusal: the order was not accepted.
      if (!response.ok) return { status: 'rejected', message: `Trading 212 拒绝了这笔订单（${response.status}）${await rejectionReason(response)}` };
      return { status: 'placed', order: obj(await response.json().catch(() => null)) };
    },
  };
}
