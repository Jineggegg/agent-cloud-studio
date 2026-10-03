import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';
import type {
  StudioT212CapsInput, StudioT212CapsRequest, StudioT212Environment, StudioT212PasskeyGate, StudioT212Requester,
  StudioT212StepUpProblem, StudioT212TrustedOrigin,
} from '@/shared/types.js';

import { createTrading212StepUp } from './trading212-step-up.service.js';

type Dependencies = {
  database: Database.Database;
  // STUDIO_T212_MAX_ORDER_VALUE: default per-order cap until the user saves their own (default 500).
  maxOrderValue?: string;
  // STUDIO_T212_MAX_DAILY_VALUE: default rolling-24-hour cap (default four times the per-order default).
  maxDailyValue?: string;
  // STUDIO_T212_CAP_CEILING: no default and no edit may exceed this (default 10000).
  ceiling?: string;
  passkeys: StudioT212PasskeyGate;
  now: () => number;
};
type Limits = { maxOrderValue: number; dailyLimit: number };
// What a raise's Face ID approves: the account, the caps the review showed, and the exact new caps.
type RaiseBinding = { env: StudioT212Environment; from: Limits; to: Limits };
type Direction = 'raise' | 'lower';
type Method = 'passkey' | 'session';
// applied: a saved change. refused: a raise attempt that was turned down. issued: a raise challenge handed out.
type AuditStatus = 'applied' | 'refused' | 'issued';
type Refusal = { message: string; statusCode: number; code: string };
type CapRow = { max_order_value: number; daily_limit: number; updated_at: string };
// Account and values are null only for a malformed raise attempt that named no challenge of this user; the session,
// client, code and outcome are null on rows written before they were recorded.
type ChangeRow = {
  row_id: number; env: StudioT212Environment | null; old_max_order_value: number | null; old_daily_limit: number | null;
  new_max_order_value: number | null; new_daily_limit: number | null; direction: Direction; method: Method;
  status: AuditStatus; reason: string | null; origin: string | null; created_at: string;
  session_id: string | null; client: string | null; code: string | null; outcome: string | null;
};
type AuditEntry = {
  env: StudioT212Environment | null; from: Limits | null; to: Limits | null; direction: Direction; method: Method;
  status: AuditStatus; reason?: string; code?: string; origin: string | null; passkeyId?: string | null;
};

// Per session, client and rolling hour: raise challenges issued (used or still open), real Face ID failures, and
// refused raise attempts audited; beyond any of them, 429 for that session only.
const MAX_CHALLENGES_PER_WINDOW = 10;
const MAX_FAILURES_PER_WINDOW = 10;
const MAX_REFUSALS_PER_WINDOW = 10;
const HISTORY_LIMIT = 20;
const DEFAULT_MAX_ORDER_VALUE = 500;
const DAILY_DEFAULT_MULTIPLIER = 4;
const DEFAULT_CEILING = 10_000;
const ENV_LABEL: Record<StudioT212Environment, string> = { live: '实盘', demo: '模拟盘' };
// How a failed Face ID / Touch ID step-up is reported for a raise: message, status and code.
const RAISE_PROBLEMS: Record<StudioT212StepUpProblem, [string, number, string]> = {
  'untrusted-origin': ['当前网址不在下单白名单，不能提高上限；降低上限不受影响', 403, 'T212_UNTRUSTED_ORIGIN'],
  expired: ['面容 ID / 触控 ID 验证超过 60 秒，上限没有改变，请重新提交', 410, 'T212_CAPS_CHALLENGE_EXPIRED'],
  'wrong-origin': ['请在发起验证的同一个网址完成提高上限', 403, 'T212_CAPS_WRONG_ORIGIN'],
  stale: ['核对之后上限已经改过，这次验证作废，上限没有改变：请重新核对', 409, 'T212_CAPS_STALE'],
  tampered: ['提交的上限和面容 ID 验证时的不一致，没有保存', 403, 'T212_CAPS_TAMPERED'],
  'passkey-failed': ['面容 ID / 触控 ID 验证失败，上限没有改变', 403, 'T212_CAPS_PASSKEY_FAILED'],
};
// Expired or stale reviews are the owner's own timing, never counted; only these real failures gate new challenges.
const BENIGN_CODES = ['T212_CAPS_CHALLENGE_EXPIRED', 'T212_CAPS_STALE'];
const FAILURE_CODES = ['T212_CAPS_PASSKEY_FAILED', 'T212_CAPS_TAMPERED'];
// For callers without a request (tests): one anonymous session.
const NO_REQUESTER: StudioT212Requester = { sessionId: '', client: 'unknown' };

function fail(message: string, statusCode: number, code: string): never {
  throw new AppError(message, { statusCode, code });
}
// A positive number from the environment, or the fallback (with a warning when the value was set but unusable).
function positiveSetting(value: string | undefined, name: string, fallback: number) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`[studio] ${name} is not a positive number; using ${fallback}`);
  return fallback;
}
function amount(value: number) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function pair(input: Limits): Limits {
  return { maxOrderValue: input.maxOrderValue, dailyLimit: input.dailyLimit };
}
function sameLimits(a: Limits, b: Limits) {
  return a.maxOrderValue === b.maxOrderValue && a.dailyLimit === b.dailyLimit;
}
function limitsOf(max: number | null, daily: number | null): Limits | null {
  return max === null || daily === null ? null : { maxOrderValue: max, dailyLimit: daily };
}

/**
 * Used by the Trading 212 orders service (and through it trading212-orders.routes) to keep each user's order caps
 * per account: a per-order cap and a rolling-24-hour cap, defaulting to the environment values and never above
 * STUDIO_T212_CAP_CEILING. Lowering needs only the session; raising needs a Face ID / Touch ID assertion over a
 * single-use, 60-second challenge (trading212-step-up) bound to the account, the caps the review showed, the exact
 * new values, the user, the requesting session and the origin, from a domain where the user has a passkey; the
 * challenge reply carries the server's current caps so the review is built from them. A named challenge is spent
 * before anything else is checked. Applied changes, issued challenges and refused raise attempts are audited with
 * the session and masked client; budgets are per session and client (429), so another session cannot lock the
 * owner out.
 */
export function createTrading212CapsService(deps: Dependencies) {
  const db = deps.database;
  const now = deps.now;
  const ceiling = positiveSetting(deps.ceiling, 'STUDIO_T212_CAP_CEILING', DEFAULT_CEILING);
  const envOrderCap = positiveSetting(deps.maxOrderValue, 'STUDIO_T212_MAX_ORDER_VALUE', DEFAULT_MAX_ORDER_VALUE);
  const envDailyCap = positiveSetting(deps.maxDailyValue, 'STUDIO_T212_MAX_DAILY_VALUE', envOrderCap * DAILY_DEFAULT_MULTIPLIER);
  if (envOrderCap > ceiling || envDailyCap > ceiling) console.warn(`[studio] Trading 212 cap defaults exceed STUDIO_T212_CAP_CEILING; using ${ceiling}`);
  const defaults: Limits = { maxOrderValue: Math.min(envOrderCap, ceiling), dailyLimit: Math.min(envDailyCap, ceiling) };
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_t212_caps (
      user_id INTEGER NOT NULL, env TEXT NOT NULL, max_order_value REAL NOT NULL, daily_limit REAL NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (user_id, env)
    );
    CREATE TABLE IF NOT EXISTS studio_t212_cap_changes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, env TEXT,
      old_max_order_value REAL, old_daily_limit REAL, new_max_order_value REAL, new_daily_limit REAL,
      direction TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, origin TEXT, passkey_id TEXT, created_at TEXT NOT NULL,
      session_id TEXT, client TEXT, code TEXT, outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_t212_cap_changes_user_status ON studio_t212_cap_changes (user_id, status, row_id);
  `);
  // A raise is bound to the account, the caps it was reviewed against and both exact new values.
  const stepUp = createTrading212StepUp<RaiseBinding>({
    database: db, auditTable: 'studio_t212_cap_changes', tag: 'studio-t212-caps-v2', passkeys: deps.passkeys, now,
    encode: raise => [raise.env, String(raise.from.maxOrderValue), String(raise.from.dailyLimit), String(raise.to.maxOrderValue), String(raise.to.dailyLimit)],
    isStale: (issued, submitted) => issued.env === submitted.env && sameLimits(issued.to, submitted.to) && !sameLimits(issued.from, submitted.from),
    benignCodes: BENIGN_CODES, failureCodes: FAILURE_CODES,
  });

  const isoNow = () => new Date(now()).toISOString();
  // The caps in force: the user's saved values or the defaults, and never above the ceiling (which may have been lowered).
  function limits(userId: number, env: StudioT212Environment) {
    const row = db.prepare('SELECT max_order_value, daily_limit, updated_at FROM studio_t212_caps WHERE user_id = ? AND env = ?')
      .get(userId, env) as CapRow | undefined;
    const base = row ? { maxOrderValue: row.max_order_value, dailyLimit: row.daily_limit } : defaults;
    return {
      maxOrderValue: Math.min(base.maxOrderValue, ceiling), dailyLimit: Math.min(base.dailyLimit, ceiling),
      custom: Boolean(row), updatedAt: row?.updated_at ?? null,
    };
  }
  // Why these values cannot be saved, or null. The router already checked the shape; this repeats the number checks
  // so no caller can store NaN, a negative or a sub-penny cap, and enforces the ceiling on every write.
  function problem(input: StudioT212CapsInput): Refusal | null {
    for (const value of [input.maxOrderValue, input.dailyLimit]) {
      if (!Number.isFinite(value) || value <= 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        return { message: '上限必须是大于 0 的数字，最多 2 位小数', statusCode: 400, code: 'T212_CAPS_INVALID' };
      }
    }
    if (input.maxOrderValue > ceiling || input.dailyLimit > ceiling) {
      return { message: `上限不能超过 ${amount(ceiling)}（服务器的 STUDIO_T212_CAP_CEILING）`, statusCode: 400, code: 'T212_CAP_CEILING' };
    }
    if (input.maxOrderValue > input.dailyLimit) return { message: '单笔上限不能超过每日上限', statusCode: 400, code: 'T212_CAPS_INVALID' };
    return null;
  }
  // Raising either cap is a raise, even when the other one goes down at the same time; null when nothing changes.
  function direction(current: Limits, next: Limits): Direction | null {
    if (next.maxOrderValue > current.maxOrderValue || next.dailyLimit > current.dailyLimit) return 'raise';
    if (next.maxOrderValue < current.maxOrderValue || next.dailyLimit < current.dailyLimit) return 'lower';
    return null;
  }
  function assertPasskeyFor(userId: number, rpId: string) {
    const { domains, here } = stepUp.passkeyDomains(userId, rpId);
    if (!domains.length) fail('提高上限需要面容 ID / 触控 ID：请先在「设置 → 交易安全」启用；降低上限不需要', 403, 'T212_CAPS_PASSKEY_REQUIRED');
    if (!here) {
      fail(`${rpId} 还没有启用面容 ID / 触控 ID：请在 ${domains.join('、')} 提高上限，或先为这个网址启用`, 403, 'T212_CAPS_PASSKEY_REQUIRED');
    }
  }
  // Refuses with 429 once this session and client used up a budget in the last hour (see trading212-step-up).
  function assertUnderLimit(userId: number, requester: StudioT212Requester, budget: 'issued' | 'refused' | 'failed', max: number, message: string) {
    stepUp.assertUnderLimit(userId, requester, budget, max, 'T212_CAPS_RATE_LIMITED', minutes => `${message}，请约 ${minutes} 分钟后再试；降低上限不受影响`);
  }
  // Inserts one audit row (with who asked) and returns its id.
  function audit(userId: number, requester: StudioT212Requester, entry: AuditEntry) {
    const rowId = Number(db.prepare(`INSERT INTO studio_t212_cap_changes (user_id, env, old_max_order_value, old_daily_limit,
      new_max_order_value, new_daily_limit, direction, method, status, reason, origin, passkey_id, created_at, session_id, client, code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, entry.env, entry.from?.maxOrderValue ?? null, entry.from?.dailyLimit ?? null, entry.to?.maxOrderValue ?? null,
      entry.to?.dailyLimit ?? null, entry.direction, entry.method, entry.status, entry.reason?.slice(0, 300) ?? null,
      entry.origin, entry.passkeyId ?? null, isoNow(), requester.sessionId, requester.client, entry.code ?? null,
    ).lastInsertRowid);
    // Refused and issued rows are bounded per session and client.
    if (entry.status !== 'applied') stepUp.trimAudit(userId, requester, entry.status);
    return rowId;
  }
  // Saves the caps and their audit row together, or neither.
  const saveAudited = db.transaction((userId: number, requester: StudioT212Requester, input: StudioT212CapsInput, entry: AuditEntry) => {
    db.prepare(`INSERT INTO studio_t212_caps (user_id, env, max_order_value, daily_limit, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, env) DO UPDATE SET max_order_value = excluded.max_order_value, daily_limit = excluded.daily_limit,
      updated_at = excluded.updated_at`).run(userId, input.env, input.maxOrderValue, input.dailyLimit, isoNow());
    audit(userId, requester, entry);
  });
  // Who asked, as Settings shows it: a short session fragment (and whether it is the viewer's own) and the masked client.
  function who(row: ChangeRow, viewer: StudioT212Requester | undefined) {
    return {
      session: row.session_id ? row.session_id.slice(0, 8) : null,
      currentSession: Boolean(viewer && row.session_id && row.session_id === viewer.sessionId),
      client: row.client && row.client !== NO_REQUESTER.client ? row.client : null,
    };
  }
  function rowsOf(userId: number, status: AuditStatus) {
    return db.prepare('SELECT * FROM studio_t212_cap_changes WHERE user_id = ? AND status = ? ORDER BY row_id DESC LIMIT ?')
      .all(userId, status, HISTORY_LIMIT) as ChangeRow[];
  }
  function historyOf(userId: number, status: 'applied' | 'refused', viewer: StudioT212Requester | undefined) {
    return rowsOf(userId, status).map(row => ({
      id: row.row_id, env: row.env, direction: row.direction, method: row.method, status: row.status as 'applied' | 'refused',
      from: limitsOf(row.old_max_order_value, row.old_daily_limit), to: limitsOf(row.new_max_order_value, row.new_daily_limit),
      reason: row.reason, origin: row.origin, createdAt: row.created_at, ...who(row, viewer),
    }));
  }

  return {
    ceiling,
    defaults,
    limits,

    // Newest first, applied changes and refused raises listed apart, so a burst of refusals never hides a change.
    // `viewer` marks the entries that came from the session reading them.
    history(userId: number, viewer?: StudioT212Requester) {
      return { applied: historyOf(userId, 'applied', viewer), refused: historyOf(userId, 'refused', viewer) };
    },

    // The raise challenges handed out, newest first, with who asked and what became of each, so the owner can see
    // which session is asking for Face ID.
    issued(userId: number, viewer?: StudioT212Requester) {
      return rowsOf(userId, 'issued').map(row => ({
        id: `caps-${row.row_id}`, kind: 'caps' as const, env: row.env, to: limitsOf(row.new_max_order_value, row.new_daily_limit),
        outcome: stepUp.outcome(row), origin: row.origin, createdAt: row.created_at, ...who(row, viewer),
      }));
    },

    // Starts a raise: checks the values, that this domain has a passkey and this session's hourly limits (issued
    // challenges and real Face ID failures, never other refusals), then issues (and audits, in the same synchronous
    // step as the limit check) the bound, single-use challenge. The reply carries the server's current caps and the
    // new ones, which the review shows and the challenge is bound to.
    async challenge(userId: number, origin: StudioT212TrustedOrigin, input: StudioT212CapsInput, requester = NO_REQUESTER) {
      const invalid = problem(input);
      if (invalid) fail(invalid.message, invalid.statusCode, invalid.code);
      const current = pair(limits(userId, input.env));
      const change = direction(current, input);
      if (!change) fail(`${ENV_LABEL[input.env]}的上限没有变化`, 400, 'T212_CAPS_UNCHANGED');
      if (change === 'lower') fail('降低上限不需要面容 ID / 触控 ID，直接保存即可', 400, 'T212_CAPS_NOT_RAISE');
      assertPasskeyFor(userId, origin.rpId);
      assertUnderLimit(userId, requester, 'failed', MAX_FAILURES_PER_WINDOW, '面容 ID / 触控 ID 验证失败的次数过多');
      assertUnderLimit(userId, requester, 'issued', MAX_CHALLENGES_PER_WINDOW, '一小时内发起提高上限的次数过多');
      const binding: RaiseBinding = { env: input.env, from: current, to: pair(input) };
      const rowId = audit(userId, requester, { env: input.env, from: current, to: binding.to, direction: 'raise', method: 'passkey', status: 'issued', origin: origin.origin });
      const issued = await stepUp.issue(userId, requester, origin, binding, rowId);
      return { ...issued, env: input.env, from: current, to: binding.to };
    },

    // Saves new caps. Lowering needs only the session (origin may be null when the page is not on the trading allowlist);
    // raising needs the assertion for a challenge issued to this session for exactly these values, from the caps
    // still in force, on this origin.
    async update(userId: number, origin: StudioT212TrustedOrigin | null, request: StudioT212CapsRequest, requester = NO_REQUESTER) {
      // A named challenge of this session is spent before anything else is checked, whatever happens next (malformed
      // body, invalid values, failed signature), and synchronously so a parallel attempt with the same id finds it
      // gone. Another user's or session's id is ignored rather than spent, so it cannot be used to burn theirs.
      const named = request.challengeId !== undefined;
      const raise = stepUp.take(userId, requester, request.challengeId);
      const input = 'input' in request ? request.input : null;
      // What the attempt was about: the submitted values, or else the values its challenge was issued for.
      const env = input?.env ?? raise?.binding.env ?? null;
      const current = env ? pair(limits(userId, env)) : null;
      const target = input ?? raise?.binding.to ?? null;

      // A refused raise attempt (one that named a challenge, or asked to raise without one) is audited until this
      // session's hourly limit; beyond it the attempt gets a 429 and no further row.
      function refuseRaise(reason: string, statusCode: number, code: string): never {
        assertUnderLimit(userId, requester, 'refused', MAX_REFUSALS_PER_WINDOW, '提高上限被拒绝的次数过多');
        audit(userId, requester, {
          env, from: current, to: target && pair(target), direction: 'raise', method: named ? 'passkey' : 'session',
          status: 'refused', reason, code, origin: origin?.origin ?? null,
        });
        return fail(reason, statusCode, code);
      }

      if (!input) {
        const reason = 'invalid' in request ? request.invalid : '请求格式无效';
        return named ? refuseRaise(reason, 400, 'T212_CAPS_INVALID') : fail(reason, 400, 'T212_CAPS_INVALID');
      }
      const before = current ?? pair(limits(userId, input.env));
      const change = direction(before, input);
      const invalid = problem(input) ?? (change ? null : { message: `${ENV_LABEL[input.env]}的上限没有变化`, statusCode: 400, code: 'T212_CAPS_UNCHANGED' });
      if (invalid) {
        return named || change === 'raise' ? refuseRaise(invalid.message, invalid.statusCode, invalid.code) : fail(invalid.message, invalid.statusCode, invalid.code);
      }
      if (change === 'lower') {
        saveAudited(userId, requester, input, { env: input.env, from: before, to: pair(input), direction: 'lower', method: 'session', status: 'applied', origin: origin?.origin ?? null });
        return { env: input.env, direction: change, method: 'session' as const };
      }

      if (!named) refuseRaise('提高上限需要面容 ID / 触控 ID 验证', 403, 'T212_CAPS_PASSKEY_REQUIRED');
      if (!raise) refuseRaise('这次面容 ID 验证不存在或已经用过，请重新提交', 410, 'T212_CAPS_CHALLENGE_GONE');
      // Bound to the caps in force now: if they changed since the review, the approval no longer fits.
      const submitted: RaiseBinding = { env: input.env, from: before, to: pair(input) };
      const verdict = await stepUp.verify(raise, userId, requester, origin, submitted, 'assertion' in request ? request.assertion : undefined);
      if ('problem' in verdict) {
        const [reason, statusCode, code] = RAISE_PROBLEMS[verdict.problem];
        refuseRaise(reason, statusCode, code);
      }
      // The verification awaited, so the audit records the caps as they were at the moment of saving.
      saveAudited(userId, requester, input, {
        env: input.env, from: pair(limits(userId, input.env)), to: pair(input), direction: 'raise', method: 'passkey',
        status: 'applied', origin: verdict.origin.origin, passkeyId: verdict.passkeyId,
      });
      return { env: input.env, direction: change, method: 'passkey' as const };
    },
  };
}
