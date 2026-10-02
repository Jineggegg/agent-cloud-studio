import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { AppError, parseEnvText } from '@/shared/utils.js';
import type { StudioT212Environment } from '@/shared/types.js';

type Environment = StudioT212Environment;
type Dependencies = {
  database: Database.Database;
  // `.env` files holding TRADING212_API_KEY / TRADING212_API_SECRET, one per environment. These are read-only
  // keys: orders are placed only by the separate order broker with its own key (docs/t212-broker.md).
  envFiles: Partial<Record<Environment, string>>;
  request?: typeof fetch;
  now?: () => number;
};
type Snapshot = { taken_at: string; total_value: number; cash: number; cost: number; unrealized: number; realized: number; currency: string };
type Json = Record<string, unknown>;

const BASE_URL: Record<Environment, string> = {
  live: 'https://live.trading212.com/api/v0',
  demo: 'https://demo.trading212.com/api/v0',
};
// Response caches stay under Trading 212's per-endpoint rate limits (summary 1/5 s, positions 1/1 s, history 20/min).
const TTL = { summary: 10_000, positions: 5_000, history: 60_000, transactions: 600_000 };
// One stored snapshot per ten minutes is enough for a daily-resolution curve.
const SNAPSHOT_GAP_MS = 10 * 60_000;
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

function fail(message: string, statusCode = 502, code = 'TRADING212_ERROR'): never {
  throw new AppError(message, { statusCode, code });
}
function num(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function maybe(value: unknown) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}
function obj(value: unknown): Json {
  return value && typeof value === 'object' ? value as Json : {};
}
function londonDay(timestamp: number) {
  return DAY_FORMAT.format(new Date(timestamp));
}
/**
 * Used by studio.module for the Trading 212 dashboard (GET reads with caches and balance snapshots) and by
 * trading212-orders.service, which calls `invalidate` after the order broker placed an order and reads
 * `lastCurrency` for Settings. It only ever GETs: Studio cannot place orders (docs/t212-broker.md).
 */
export function createTrading212Service(deps: Dependencies) {
  const db = deps.database;
  const request = deps.request ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  // Bumped by `invalidate`; reads that began under an older generation are not cached.
  const generation: Record<Environment, number> = { live: 0, demo: 0 };
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_t212_snapshots (
      env TEXT NOT NULL, taken_at TEXT NOT NULL, currency TEXT NOT NULL, total_value REAL NOT NULL,
      cash REAL NOT NULL, cost REAL NOT NULL, unrealized REAL NOT NULL, realized REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_t212_snapshots_env_time ON studio_t212_snapshots (env, taken_at);
  `);

  // Credentials are read from disk per request so rotating the key needs no restart, and are never returned.
  function credentials(env: Environment) {
    const file = deps.envFiles[env];
    if (!file || !existsSync(file)) return null;
    const values = parseEnvText(readFileSync(file, 'utf8'));
    const key = values.TRADING212_API_KEY?.trim();
    const secret = values.TRADING212_API_SECRET;
    return key && secret ? { key, secret } : null;
  }
  // One authenticated GET with the shared error mapping; callers decide how the result is cached.
  async function fetchJson<T>(env: Environment, route: string): Promise<T> {
    const auth = credentials(env);
    if (!auth) fail(`未配置 Trading 212 ${env === 'live' ? '实盘' : '模拟盘'}密钥文件`, 503);
    let response: Response;
    try {
      response = await request(`${BASE_URL[env]}${route}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: basicAuth(auth) },
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch {
      fail('Trading 212 无法连接，请稍后重试');
    }
    if (response.status === 401 || response.status === 403) fail('Trading 212 认证失败：请检查 API Key / Secret、实盘或模拟环境以及 IP 限制');
    if (response.status === 429) fail('Trading 212 请求过于频繁，请稍后再试', 429);
    if (!response.ok) fail(`Trading 212 暂时不可用（${response.status}）`);
    return await response.json() as T;
  }
  async function get<T>(env: Environment, route: string, ttl: number): Promise<T> {
    const cacheKey = `${env}:${route}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.at < ttl) return hit.value as T;
    const running = inflight.get(cacheKey);
    if (running) return running as Promise<T>;
    const startedIn = generation[env];
    const task = (async () => {
      const value = await fetchJson<T>(env, route);
      // A read that started before an order was placed must not repopulate the cache with pre-order data.
      if (generation[env] === startedIn) cache.set(cacheKey, { at: now(), value });
      return value;
    })();
    inflight.set(cacheKey, task);
    try { return await task; } finally { if (inflight.get(cacheKey) === task) inflight.delete(cacheKey); }
  }
  function basicAuth(auth: { key: string; secret: string }) {
    return `Basic ${Buffer.from(`${auth.key}:${auth.secret}`).toString('base64')}`;
  }
  // Drops every cached read of one account so balances and positions are fetched fresh after an order.
  function invalidate(env: Environment) {
    generation[env] += 1;
    for (const key of [...cache.keys(), ...inflight.keys()]) {
      if (key.startsWith(`${env}:`)) { cache.delete(key); inflight.delete(key); }
    }
  }

  function record(env: Environment, summary: Json) {
    const last = db.prepare('SELECT taken_at FROM studio_t212_snapshots WHERE env = ? ORDER BY taken_at DESC LIMIT 1').get(env) as { taken_at: string } | undefined;
    if (last && now() - Date.parse(last.taken_at) < SNAPSHOT_GAP_MS) return;
    const cash = obj(summary.cash);
    const investments = obj(summary.investments);
    db.prepare('INSERT INTO studio_t212_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      env, new Date(now()).toISOString(), String(summary.currency ?? ''), num(summary.totalValue),
      num(cash.availableToTrade), num(investments.totalCost), num(investments.unrealizedProfitLoss), num(investments.realizedProfitLoss),
    );
  }
  function snapshots(env: Environment, since = 0) {
    return db.prepare('SELECT * FROM studio_t212_snapshots WHERE env = ? AND taken_at >= ? ORDER BY taken_at').all(env, new Date(since).toISOString()) as Snapshot[];
  }
  // Deposits and withdrawals change the balance without being profit, so they are subtracted from day changes.
  async function flows(env: Environment) {
    try {
      const page = obj(await get<Json>(env, '/equity/history/transactions?limit=50', TTL.transactions));
      const items = Array.isArray(page.items) ? page.items.map(obj) : [];
      return (from: number, to: number) => items.reduce((sum, item) => {
        const at = Date.parse(String(item.dateTime ?? ''));
        if (!(at > from && at <= to)) return sum;
        if (item.type === 'DEPOSIT') return sum + Math.abs(num(item.amount));
        if (item.type === 'WITHDRAW') return sum - Math.abs(num(item.amount));
        return sum;
      }, 0);
    } catch { return null; }
  }
  function change(end: Snapshot | undefined, start: Snapshot | undefined, netFlow: ((from: number, to: number) => number) | null) {
    if (!end || !start || start.total_value <= 0) return null;
    const flow = netFlow ? netFlow(Date.parse(start.taken_at), Date.parse(end.taken_at)) : 0;
    const amount = end.total_value - start.total_value - flow;
    return { amount, percent: amount / start.total_value * 100, since: start.taken_at, flowAdjusted: Boolean(netFlow) };
  }

  async function overview(env: Environment) {
    const [summary, positions] = await Promise.all([
      get<Json>(env, '/equity/account/summary', TTL.summary).then(obj),
      get<unknown[]>(env, '/equity/positions', TTL.positions),
    ]);
    record(env, summary);
    const rows = snapshots(env);
    const today = londonDay(now());
    const yesterday = londonDay(now() - 86_400_000);
    const lastBefore = (day: string) => [...rows].reverse().find(row => londonDay(Date.parse(row.taken_at)) < day);
    const lastOn = (day: string) => [...rows].reverse().find(row => londonDay(Date.parse(row.taken_at)) <= day);
    const netFlow = await flows(env);
    const cash = obj(summary.cash);
    const investments = obj(summary.investments);
    return {
      env, currency: String(summary.currency ?? ''), totalValue: num(summary.totalValue), fetchedAt: new Date(now()).toISOString(),
      cash: { available: num(cash.availableToTrade), reserved: num(cash.reservedForOrders), inPies: num(cash.inPies) },
      investments: { value: num(investments.currentValue), cost: num(investments.totalCost), unrealized: num(investments.unrealizedProfitLoss), realized: num(investments.realizedProfitLoss) },
      changes: {
        today: change(rows.at(-1), lastBefore(today), netFlow),
        yesterday: change(lastOn(yesterday), lastBefore(yesterday), netFlow),
      },
      recordedSince: rows[0]?.taken_at ?? null,
      positions: (Array.isArray(positions) ? positions.map(obj) : []).map(position => {
        const instrument = obj(position.instrument);
        const wallet = obj(position.walletImpact);
        const ticker = String(instrument.ticker ?? position.ticker ?? '');
        return {
          ticker, name: String(instrument.name ?? ticker), currency: String(instrument.currency ?? ''),
          quantity: num(position.quantity), averagePrice: num(position.averagePricePaid ?? position.averagePrice), currentPrice: num(position.currentPrice),
          value: num(wallet.currentValue), cost: num(wallet.totalCost), pnl: num(wallet.unrealizedProfitLoss ?? position.ppl),
          fx: maybe(wallet.fxImpact ?? position.fxPpl), openedAt: String(position.createdAt ?? position.initialFillDate ?? ''),
        };
      }).sort((a, b) => b.value - a.value),
    };
  }

  return {
    status() {
      return (['live', 'demo'] as Environment[]).map(env => ({
        env, configured: Boolean(credentials(env)),
        // Only the folder name is shown, never the file content.
        source: deps.envFiles[env] ? path.basename(path.dirname(deps.envFiles[env]!)) : null,
      }));
    },
    overview,
    // Called after the order broker placed (or may have placed) an order, so the next read is fresh.
    invalidate,
    // Account currency from the latest stored snapshot, so Settings can show the cap before the broker read it.
    lastCurrency(env: Environment) {
      const row = db.prepare('SELECT currency FROM studio_t212_snapshots WHERE env = ? ORDER BY taken_at DESC LIMIT 1').get(env) as { currency: string } | undefined;
      return row?.currency || null;
    },
    history(env: Environment, days: number) {
      const rows = snapshots(env, days > 0 ? now() - days * 86_400_000 : 0);
      // Keep charts light: at most ~400 evenly spaced points.
      const step = Math.max(1, Math.ceil(rows.length / 400));
      return rows.filter((_, index) => index % step === 0 || index === rows.length - 1)
        .map(row => ({ at: row.taken_at, value: row.total_value, unrealized: row.unrealized }));
    },
    async activity(env: Environment) {
      const [orders, dividends] = await Promise.all([
        get<Json>(env, '/equity/history/orders?limit=20', TTL.history).then(obj),
        get<Json>(env, '/equity/history/dividends?limit=10', TTL.history).then(obj).catch(() => ({ items: [] }) as Json),
      ]);
      const trades = (Array.isArray(orders.items) ? orders.items.map(obj) : []).map(item => {
        const order = obj(item.order);
        const fill = obj(item.fill);
        const wallet = obj(fill.walletImpact);
        const instrument = obj(order.instrument);
        return {
          id: String(order.id ?? fill.id ?? ''), kind: String(order.side ?? '').toUpperCase() === 'SELL' ? 'sell' : 'buy',
          ticker: String(order.ticker ?? instrument.ticker ?? ''), name: String(instrument.name ?? order.ticker ?? ''),
          quantity: num(fill.quantity ?? order.filledQuantity ?? order.quantity), price: maybe(fill.price),
          value: maybe(wallet.netValue ?? order.filledValue ?? order.value), realized: maybe(wallet.realisedProfitLoss),
          currency: String(wallet.currency ?? order.currency ?? ''), at: String(fill.filledAt ?? order.createdAt ?? ''), status: String(order.status ?? ''),
        };
      });
      const payouts = (Array.isArray(dividends.items) ? dividends.items.map(obj) : []).map(item => ({
        id: String(item.reference ?? `${item.ticker}-${item.paidOn}`), kind: 'dividend', ticker: String(item.ticker ?? ''),
        name: String(obj(item.instrument).name ?? item.ticker ?? ''), quantity: num(item.quantity), price: null,
        value: maybe(item.amount), realized: null, currency: String(item.currency ?? ''), at: String(item.paidOn ?? ''), status: 'PAID',
      }));
      return [...trades, ...payouts].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
    },
    // Records a snapshot on an interval so the equity curve keeps growing while Studio runs.
    startSnapshots(minutes: number) {
      if (!(minutes > 0)) return () => {};
      const timer = setInterval(() => {
        for (const env of ['live', 'demo'] as Environment[]) if (credentials(env)) void overview(env).catch(() => {});
      }, minutes * 60_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
