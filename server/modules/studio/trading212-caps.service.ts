import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';
import type { StudioT212CapsInput, StudioT212CapsProof, StudioT212Environment, StudioT212TrustedOrigin } from '@/shared/types.js';

// Passkey access lent by the orders service, which owns the stored credentials and their counters.
type PasskeyGate = {
  // RP IDs (domains) where this user has at least one passkey.
  rpIds: (userId: number) => string[];
  // WebAuthn request options for the user's passkeys on one RP ID, signing exactly `challenge`, user verification required.
  options: (userId: number, rpId: string, challenge: Uint8Array<ArrayBuffer>, timeoutMs: number) => Promise<PublicKeyCredentialRequestOptionsJSON>;
  // Verifies an assertion against the user's stored credential on `rpId` and advances its counter; the passkey id, or null.
  verify: (userId: number, rpId: string, assertion: AuthenticationResponseJSON, challenge: string, origin: string) => Promise<string | null>;
};
type Dependencies = {
  database: Database.Database;
  // STUDIO_T212_MAX_ORDER_VALUE: default per-order cap until the user saves their own (default 500).
  maxOrderValue?: string;
  // STUDIO_T212_MAX_DAILY_VALUE: default rolling-24-hour cap (default four times the per-order default).
  maxDailyValue?: string;
  // STUDIO_T212_CAP_CEILING: no default and no edit may exceed this (default 10000).
  ceiling?: string;
  passkeys: PasskeyGate;
  now: () => number;
};
type Limits = { maxOrderValue: number; dailyLimit: number };
type Direction = 'raise' | 'lower';
type Refusal = { message: string; statusCode: number; code: string };
type CapRow = { max_order_value: number; daily_limit: number; updated_at: string };
type ChangeRow = {
  row_id: number; env: StudioT212Environment; old_max_order_value: number; old_daily_limit: number;
  new_max_order_value: number; new_daily_limit: number; direction: Direction; method: 'passkey' | 'session';
  status: 'applied' | 'refused'; reason: string | null; origin: string | null; created_at: string;
};
// A raise waiting for its Face ID / Touch ID assertion: the exact values, who asked, where, and the bound challenge.
type PendingRaise = StudioT212CapsInput & {
  userId: number; origin: string; rpId: string; nonce: string; challenge: string; issuedAt: number; expiresAt: number;
};

// The assertion for a raise must arrive within a minute of the challenge.
const CHALLENGE_TTL_MS = 60_000;
// Older unanswered raise challenges of the same user are dropped beyond this many.
const MAX_PENDING_PER_USER = 5;
const DEFAULT_MAX_ORDER_VALUE = 500;
const DAILY_DEFAULT_MULTIPLIER = 4;
const DEFAULT_CEILING = 10_000;
const HISTORY_LIMIT = 20;
const ENV_LABEL: Record<StudioT212Environment, string> = { live: '实盘', demo: '模拟盘' };

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
// The challenge a raise must be signed over: a digest of the exact values, the user, the origin and a fresh nonce.
// Values that differ from what was shown at Face ID time produce a different challenge, so the assertion no longer fits.
function bindingChallenge(raise: StudioT212CapsInput & { userId: number; origin: string; rpId: string; nonce: string }) {
  const canonical = JSON.stringify([
    'studio-t212-caps-v1', raise.userId, raise.origin, raise.rpId, raise.env,
    raise.maxOrderValue.toFixed(2), raise.dailyLimit.toFixed(2), raise.nonce,
  ]);
  return createHash('sha256').update(canonical).digest();
}

/**
 * Used by the Trading 212 orders service (and through it trading212-orders.routes) to keep each user's order caps
 * per account: a per-order cap and a rolling-24-hour cap, defaulting to the environment values and never above
 * STUDIO_T212_CAP_CEILING. Lowering needs only the session; raising needs a Face ID / Touch ID assertion over a
 * single-use, 60-second challenge bound to the exact new values, the user and the origin, from a domain where the
 * user has a passkey. Every applied change, and every refused raise that consumed a challenge, is audited.
 */
export function createTrading212CapsService(deps: Dependencies) {
  const db = deps.database;
  const now = deps.now;
  const ceiling = positiveSetting(deps.ceiling, 'STUDIO_T212_CAP_CEILING', DEFAULT_CEILING);
  const envOrderCap = positiveSetting(deps.maxOrderValue, 'STUDIO_T212_MAX_ORDER_VALUE', DEFAULT_MAX_ORDER_VALUE);
  const envDailyCap = positiveSetting(deps.maxDailyValue, 'STUDIO_T212_MAX_DAILY_VALUE', envOrderCap * DAILY_DEFAULT_MULTIPLIER);
  if (envOrderCap > ceiling || envDailyCap > ceiling) console.warn(`[studio] Trading 212 cap defaults exceed STUDIO_T212_CAP_CEILING; using ${ceiling}`);
  const defaults: Limits = { maxOrderValue: Math.min(envOrderCap, ceiling), dailyLimit: Math.min(envDailyCap, ceiling) };
  const pending = new Map<string, PendingRaise>();
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_t212_caps (
      user_id INTEGER NOT NULL, env TEXT NOT NULL, max_order_value REAL NOT NULL, daily_limit REAL NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (user_id, env)
    );
    CREATE TABLE IF NOT EXISTS studio_t212_cap_changes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, env TEXT NOT NULL,
      old_max_order_value REAL NOT NULL, old_daily_limit REAL NOT NULL, new_max_order_value REAL NOT NULL,
      new_daily_limit REAL NOT NULL, direction TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, origin TEXT, passkey_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_t212_cap_changes_user ON studio_t212_cap_changes (user_id, row_id);
  `);

  const isoNow = () => new Date(now()).toISOString();
  function prune() {
    const time = now();
    for (const [id, item] of pending) if (item.expiresAt <= time) pending.delete(id);
  }
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
  function direction(current: Limits, next: StudioT212CapsInput): Direction | null {
    if (next.maxOrderValue > current.maxOrderValue || next.dailyLimit > current.dailyLimit) return 'raise';
    if (next.maxOrderValue < current.maxOrderValue || next.dailyLimit < current.dailyLimit) return 'lower';
    return null;
  }
  function unchanged(env: StudioT212Environment): Refusal {
    return { message: `${ENV_LABEL[env]}的上限没有变化`, statusCode: 400, code: 'T212_CAPS_UNCHANGED' };
  }
  function assertPasskeyFor(userId: number, rpId: string) {
    const domains = deps.passkeys.rpIds(userId);
    if (!domains.length) fail('提高上限需要面容 ID / 触控 ID：请先在「设置 → 交易安全」启用；降低上限不需要', 403, 'T212_CAPS_PASSKEY_REQUIRED');
    if (!domains.includes(rpId)) {
      fail(`${rpId} 还没有启用面容 ID / 触控 ID：请在 ${domains.join('、')} 提高上限，或先为这个网址启用`, 403, 'T212_CAPS_PASSKEY_REQUIRED');
    }
  }
  function audit(userId: number, from: Limits, input: StudioT212CapsInput, entry: {
    direction: Direction; method: 'passkey' | 'session'; status: 'applied' | 'refused';
    reason?: string; origin: string | null; passkeyId?: string | null;
  }) {
    db.prepare(`INSERT INTO studio_t212_cap_changes (user_id, env, old_max_order_value, old_daily_limit, new_max_order_value,
      new_daily_limit, direction, method, status, reason, origin, passkey_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, input.env, from.maxOrderValue, from.dailyLimit, input.maxOrderValue, input.dailyLimit, entry.direction,
      entry.method, entry.status, entry.reason?.slice(0, 300) ?? null, entry.origin, entry.passkeyId ?? null, isoNow(),
    );
  }
  function save(userId: number, input: StudioT212CapsInput) {
    db.prepare(`INSERT INTO studio_t212_caps (user_id, env, max_order_value, daily_limit, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, env) DO UPDATE SET max_order_value = excluded.max_order_value, daily_limit = excluded.daily_limit,
      updated_at = excluded.updated_at`).run(userId, input.env, input.maxOrderValue, input.dailyLimit, isoNow());
  }

  return {
    ceiling,
    defaults,
    limits,

    // Newest first: applied changes and refused raises, for Settings → 交易安全.
    history(userId: number) {
      const rows = db.prepare('SELECT * FROM studio_t212_cap_changes WHERE user_id = ? ORDER BY row_id DESC LIMIT ?')
        .all(userId, HISTORY_LIMIT) as ChangeRow[];
      return rows.map(row => ({
        id: row.row_id, env: row.env, direction: row.direction, method: row.method, status: row.status,
        from: { maxOrderValue: row.old_max_order_value, dailyLimit: row.old_daily_limit },
        to: { maxOrderValue: row.new_max_order_value, dailyLimit: row.new_daily_limit },
        reason: row.reason, origin: row.origin, createdAt: row.created_at,
      }));
    },

    // Starts a raise: checks the values and that this domain has a passkey, then issues the bound, single-use challenge.
    async challenge(userId: number, origin: StudioT212TrustedOrigin, input: StudioT212CapsInput) {
      const invalid = problem(input);
      if (invalid) fail(invalid.message, invalid.statusCode, invalid.code);
      const change = direction(limits(userId, input.env), input);
      if (!change) { const refusal = unchanged(input.env); fail(refusal.message, refusal.statusCode, refusal.code); }
      if (change === 'lower') fail('降低上限不需要面容 ID / 触控 ID，直接保存即可', 400, 'T212_CAPS_NOT_RAISE');
      assertPasskeyFor(userId, origin.rpId);
      prune();
      const mine = [...pending].filter(([, item]) => item.userId === userId).sort((a, b) => a[1].issuedAt - b[1].issuedAt);
      for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_USER + 1))) pending.delete(id);

      const nonce = randomBytes(16).toString('hex');
      const digest = bindingChallenge({ ...input, userId, origin: origin.origin, rpId: origin.rpId, nonce });
      // The 60 seconds start when the challenge exists, not when its options have been built.
      const issuedAt = now();
      const authentication = await deps.passkeys.options(userId, origin.rpId, new Uint8Array(digest), CHALLENGE_TTL_MS);
      const id = randomUUID();
      pending.set(id, {
        env: input.env, maxOrderValue: input.maxOrderValue, dailyLimit: input.dailyLimit, userId, origin: origin.origin,
        rpId: origin.rpId, nonce, challenge: digest.toString('base64url'), issuedAt, expiresAt: issuedAt + CHALLENGE_TTL_MS,
      });
      return { challengeId: id, expiresAt: new Date(issuedAt + CHALLENGE_TTL_MS).toISOString(), authentication };
    },

    // Saves new caps. Lowering needs only the session (origin may be null when the page is not on the trading allowlist);
    // raising needs the assertion for a challenge issued for exactly these values to this user on this origin.
    async update(userId: number, origin: StudioT212TrustedOrigin | null, input: StudioT212CapsInput, proof?: StudioT212CapsProof) {
      // A presented challenge of this user is spent by this attempt before anything else is checked, whatever
      // happens next (refusal, invalid values, failed signature), and synchronously so a parallel attempt with the
      // same id finds it gone. Another user's id is ignored rather than spent, so it cannot be used to burn it.
      const found = proof ? pending.get(proof.challengeId) : undefined;
      const raise = found?.userId === userId ? found : undefined;
      if (raise && proof) pending.delete(proof.challengeId);
      const current = limits(userId, input.env);
      // Once a challenge was spent, every refusal is audited, so tampering and replays show up in Settings.
      function refuse(reason: string, statusCode: number, code: string): never {
        if (raise) audit(userId, current, input, { direction: 'raise', method: 'passkey', status: 'refused', reason, origin: origin?.origin ?? null });
        return fail(reason, statusCode, code);
      }
      const invalid = problem(input);
      if (invalid) refuse(invalid.message, invalid.statusCode, invalid.code);
      const change = direction(current, input);
      if (!change) { const refusal = unchanged(input.env); refuse(refusal.message, refusal.statusCode, refusal.code); }
      if (change === 'lower') {
        save(userId, input);
        audit(userId, current, input, { direction: 'lower', method: 'session', status: 'applied', origin: origin?.origin ?? null });
        return { direction: change, method: 'session' as const };
      }

      if (!proof) fail('提高上限需要面容 ID / 触控 ID 验证', 403, 'T212_CAPS_PASSKEY_REQUIRED');
      if (!raise) fail('这次面容 ID 验证不存在或已经用过，请重新提交', 410, 'T212_CAPS_CHALLENGE_GONE');
      if (!origin) refuse('当前网址不在下单白名单，不能提高上限；降低上限不受影响', 403, 'T212_UNTRUSTED_ORIGIN');
      if (now() >= raise.expiresAt) refuse('面容 ID / 触控 ID 验证超过 60 秒，上限没有改变，请重新提交', 410, 'T212_CAPS_CHALLENGE_EXPIRED');
      if (raise.origin !== origin.origin || raise.rpId !== origin.rpId) refuse('请在发起验证的同一个网址完成提高上限', 403, 'T212_CAPS_WRONG_ORIGIN');
      const expected = bindingChallenge({ ...input, userId, origin: origin.origin, rpId: origin.rpId, nonce: raise.nonce }).toString('base64url');
      const sameValues = raise.env === input.env && raise.maxOrderValue === input.maxOrderValue && raise.dailyLimit === input.dailyLimit;
      if (!sameValues || expected !== raise.challenge) refuse('提交的上限和面容 ID 验证时的不一致，没有保存', 403, 'T212_CAPS_TAMPERED');
      const passkeyId = await deps.passkeys.verify(userId, origin.rpId, proof.assertion, expected, origin.origin);
      if (!passkeyId) refuse('面容 ID / 触控 ID 验证失败，上限没有改变', 403, 'T212_CAPS_PASSKEY_FAILED');
      // The verification awaited, so the audit records the caps as they were at the moment of saving.
      const before = limits(userId, input.env);
      save(userId, input);
      audit(userId, before, input, { direction: 'raise', method: 'passkey', status: 'applied', origin: origin.origin, passkeyId });
      return { direction: change, method: 'passkey' as const };
    },
  };
}
