import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';
import type {
  StudioT212Environment, StudioT212ModeRequest, StudioT212PasskeyGate, StudioT212Requester, StudioT212StepUpProblem,
  StudioT212TradingMode, StudioT212TrustedOrigin,
} from '@/shared/types.js';

import { createTrading212StepUp } from './trading212-step-up.service.js';

type Dependencies = {
  database: Database.Database;
  // STUDIO_T212_TRADING as the orders service read it: the accounts the server lets anyone trade at most.
  ceiling: StudioT212Environment[];
  passkeys: StudioT212PasskeyGate;
  now: () => number;
};
// widen: the change adds an account that may trade. narrow: it only removes accounts (or tidies the saved choice).
// pin: the mode in force is saved as the user's own choice, so a later, wider ceiling cannot widen it.
type Direction = 'widen' | 'narrow' | 'pin';
type Method = 'passkey' | 'session';
// applied: a saved change. refused: a widening attempt that was turned down. issued: a widening challenge handed out.
type AuditStatus = 'applied' | 'refused' | 'issued';
// What a widening's Face ID approves: the mode the review showed as in force, and the exact new mode.
type WidenBinding = { from: StudioT212TradingMode; to: StudioT212TradingMode };
type ModeRow = { mode: string; updated_at: string };
// Modes are null only for a malformed widening attempt that named no challenge of this user (and `old_mode` for an
// automatic pin); the session, client, code and outcome are null where nobody asked.
type ChangeRow = {
  row_id: number; old_mode: string | null; new_mode: string | null; direction: Direction; method: Method;
  status: AuditStatus; reason: string | null; origin: string | null; created_at: string;
  session_id: string | null; client: string | null; code: string | null; outcome: string | null;
};
type AuditEntry = {
  from: StudioT212TradingMode | null; to: StudioT212TradingMode | null; direction: Direction; method: Method;
  status: AuditStatus; reason?: string; code?: string; origin: string | null; passkeyId?: string | null;
};
// The user's saved choice (the ceiling while none is saved) and what it leaves of the ceiling.
type Current = { choice: StudioT212TradingMode; allowed: StudioT212Environment[]; custom: boolean; updatedAt: string | null };

// Per session, client and rolling hour: widening challenges issued (used or still open), real Face ID failures, and
// refused widening attempts audited; beyond any of them, 429 for that session only.
const MAX_CHALLENGES_PER_WINDOW = 10;
const MAX_FAILURES_PER_WINDOW = 10;
const MAX_REFUSALS_PER_WINDOW = 10;
const HISTORY_LIMIT = 20;
// Live first, as STUDIO_T212_TRADING=both has always listed them.
const MODE_ENVS: Record<StudioT212TradingMode, StudioT212Environment[]> = { off: [], demo: ['demo'], live: ['live'], both: ['live', 'demo'] };
const MODE_LABEL: Record<StudioT212TradingMode, string> = { off: '关闭', demo: '模拟盘', live: '实盘', both: '实盘+模拟盘' };
const ENV_LABEL: Record<StudioT212Environment, string> = { live: '实盘', demo: '模拟盘' };
// How a failed Face ID / Touch ID step-up is reported for a widening: message, status and code.
const WIDEN_PROBLEMS: Record<StudioT212StepUpProblem, [string, number, string]> = {
  'untrusted-origin': ['当前网址不在下单白名单，不能开启下单；关闭或减少账户不受影响', 403, 'T212_UNTRUSTED_ORIGIN'],
  expired: ['面容 ID / 触控 ID 验证超过 60 秒，交易模式没有改变，请重新选择', 410, 'T212_MODE_CHALLENGE_EXPIRED'],
  'wrong-origin': ['请在发起验证的同一个网址完成开启', 403, 'T212_MODE_WRONG_ORIGIN'],
  stale: ['核对之后交易模式已经改过，这次验证作废，没有开启：请重新选择', 409, 'T212_MODE_STALE'],
  tampered: ['提交的交易模式和面容 ID 验证时的不一致，没有保存', 403, 'T212_MODE_TAMPERED'],
  'passkey-failed': ['面容 ID / 触控 ID 验证失败，交易模式没有改变', 403, 'T212_MODE_PASSKEY_FAILED'],
};
// Expired or stale reviews are the owner's own timing, never counted; only these real failures gate new challenges.
const BENIGN_CODES = ['T212_MODE_CHALLENGE_EXPIRED', 'T212_MODE_STALE'];
const FAILURE_CODES = ['T212_MODE_PASSKEY_FAILED', 'T212_MODE_TAMPERED'];
const AUTO_PIN_REASON = '首次读取时固定为服务器当时允许的账户；以后服务器放宽也不会自动开启';
// For callers without a request (tests, automatic pins outside a request): one anonymous session.
const NO_REQUESTER: StudioT212Requester = { sessionId: '', client: 'unknown' };

function fail(message: string, statusCode: number, code: string): never {
  throw new AppError(message, { statusCode, code });
}
function modeOf(envs: StudioT212Environment[]): StudioT212TradingMode {
  const live = envs.includes('live');
  const demo = envs.includes('demo');
  return live && demo ? 'both' : live ? 'live' : demo ? 'demo' : 'off';
}
function isMode(value: string | null): value is StudioT212TradingMode {
  return value !== null && Object.hasOwn(MODE_ENVS, value);
}

/**
 * Used by the Trading 212 orders service (and through it trading212-orders.routes) to keep each user's trading mode:
 * which accounts (none, demo, live or both) may place orders. STUDIO_T212_TRADING is the ceiling; the user's choice
 * is stored in studio_t212_trading_modes and the accounts that may trade are the ceiling ∩ the choice. A user with
 * no stored choice is pinned to the mode in force when it is first read, so a later, wider ceiling never widens an
 * existing user without Face ID. A choice outside the ceiling is refused. Narrowing (fewer accounts, including off)
 * and pinning need only the session; widening (adding any account) needs a Face ID / Touch ID assertion over a
 * single-use, 60-second challenge (trading212-step-up) bound to the user, the requesting session, the mode in force,
 * the exact new mode and the origin / RP ID, from a domain where the user has a passkey; the challenge reply carries
 * the server's state so the review is built from it. A named challenge is spent before anything else is checked.
 * Applied changes, issued challenges and refused widening attempts are audited in studio_t212_mode_changes with the
 * session and masked client; budgets are per session and client (429), so another session cannot lock the owner out.
 */
export function createTrading212ModeService(deps: Dependencies) {
  const db = deps.database;
  const now = deps.now;
  const ceilingEnvs = deps.ceiling;
  const ceiling = modeOf(ceilingEnvs);
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_t212_trading_modes (
      user_id INTEGER PRIMARY KEY, mode TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_t212_mode_changes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, old_mode TEXT, new_mode TEXT,
      direction TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, origin TEXT, passkey_id TEXT, created_at TEXT NOT NULL,
      session_id TEXT, client TEXT, code TEXT, outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_t212_mode_changes_user_status ON studio_t212_mode_changes (user_id, status, row_id);
  `);
  const stepUp = createTrading212StepUp<WidenBinding>({
    database: db, auditTable: 'studio_t212_mode_changes', tag: 'studio-t212-mode-v2', passkeys: deps.passkeys, now,
    encode: widening => [widening.from, widening.to],
    isStale: (issued, submitted) => issued.to === submitted.to && issued.from !== submitted.from,
    benignCodes: BENIGN_CODES, failureCodes: FAILURE_CODES,
  });

  const isoNow = () => new Date(now()).toISOString();
  function read(userId: number): Current {
    const row = db.prepare('SELECT mode, updated_at FROM studio_t212_trading_modes WHERE user_id = ?').get(userId) as ModeRow | undefined;
    // An unreadable saved value fails closed: nothing may trade until the user chooses again.
    const choice: StudioT212TradingMode = row ? (isMode(row.mode) ? row.mode : 'off') : ceiling;
    const chosen = MODE_ENVS[choice];
    return { choice, allowed: ceilingEnvs.filter(env => chosen.includes(env)), custom: Boolean(row), updatedAt: row?.updated_at ?? null };
  }
  // Pins a user without a stored choice to the mode in force (and audits it), once; a parallel pin does nothing.
  const pin = db.transaction((userId: number, mode: StudioT212TradingMode, requester: StudioT212Requester) => {
    const inserted = db.prepare('INSERT INTO studio_t212_trading_modes (user_id, mode, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING')
      .run(userId, mode, isoNow()).changes;
    if (inserted) audit(userId, requester, { from: null, to: mode, direction: 'pin', method: 'session', status: 'applied', reason: AUTO_PIN_REASON, origin: null });
  });
  // The mode as read by everything but an explicit change: a first read pins it. If the pin cannot be written the
  // read still answers with the ceiling, exactly what it would have pinned, and the next read tries again.
  function current(userId: number, requester = NO_REQUESTER): Current {
    const state = read(userId);
    if (state.custom) return state;
    try {
      pin(userId, modeOf(state.allowed), requester);
    } catch (error) {
      console.error(`[studio] could not pin the Trading 212 trading mode of user ${userId}`, error);
      return state;
    }
    return read(userId);
  }
  // Why the server does not allow this mode at all, or null when it fits inside STUDIO_T212_TRADING.
  function ceilingRefusal(mode: StudioT212TradingMode) {
    const missing = MODE_ENVS[mode].filter(env => !ceilingEnvs.includes(env));
    if (!missing.length) return null;
    return `服务器未开启${missing.map(env => ENV_LABEL[env]).join('和')}下单（STUDIO_T212_TRADING=${ceiling}），不能选择「${MODE_LABEL[mode]}」`;
  }
  function added(before: Current, mode: StudioT212TradingMode) {
    return MODE_ENVS[mode].filter(env => !before.allowed.includes(env));
  }
  // Adding any account that may not trade now is a widening, even when another one is dropped at the same time;
  // the mode in force again is a pin while nothing is stored, and no change once it is.
  function direction(before: Current, mode: StudioT212TradingMode): Direction | null {
    if (added(before, mode).length) return 'widen';
    if (mode === before.choice) return before.custom ? null : 'pin';
    return 'narrow';
  }
  // Why this domain cannot approve a widening, or null when the user has a passkey here.
  function passkeyRefusal(userId: number, rpId: string) {
    const { domains, here } = stepUp.passkeyDomains(userId, rpId);
    if (here) return null;
    if (!domains.length) return `启用面容 ID 后才能开启：请先在「设置 → 交易安全」为 ${rpId} 启用面容 ID / 触控 ID。关闭或减少账户不需要验证`;
    return `${rpId} 还没有启用面容 ID / 触控 ID，启用面容 ID 后才能开启：请先为这个网址启用，或到 ${domains.join('、')} 操作`;
  }
  function assertUnderLimit(userId: number, requester: StudioT212Requester, budget: 'issued' | 'refused' | 'failed', max: number, message: string) {
    stepUp.assertUnderLimit(userId, requester, budget, max, 'T212_MODE_RATE_LIMITED', minutes => `${message}，请约 ${minutes} 分钟后再试；关闭或减少账户不受影响`);
  }
  // Inserts one audit row (with who asked) and returns its id.
  function audit(userId: number, requester: StudioT212Requester, entry: AuditEntry) {
    const rowId = Number(db.prepare(`INSERT INTO studio_t212_mode_changes (user_id, old_mode, new_mode, direction, method, status, reason,
      origin, passkey_id, created_at, session_id, client, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, entry.from, entry.to, entry.direction, entry.method, entry.status, entry.reason?.slice(0, 300) ?? null,
      entry.origin, entry.passkeyId ?? null, isoNow(), requester.sessionId, requester.client, entry.code ?? null,
    ).lastInsertRowid);
    if (entry.status !== 'applied') stepUp.trimAudit(userId, requester, entry.status);
    return rowId;
  }
  // Saves the choice and its audit row together, or neither.
  const saveAudited = db.transaction((userId: number, requester: StudioT212Requester, mode: StudioT212TradingMode, entry: AuditEntry) => {
    db.prepare(`INSERT INTO studio_t212_trading_modes (user_id, mode, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`).run(userId, mode, isoNow());
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
    return db.prepare('SELECT * FROM studio_t212_mode_changes WHERE user_id = ? AND status = ? ORDER BY row_id DESC LIMIT ?')
      .all(userId, status, HISTORY_LIMIT) as ChangeRow[];
  }
  function historyOf(userId: number, status: 'applied' | 'refused', viewer: StudioT212Requester | undefined) {
    return rowsOf(userId, status).map(row => ({
      id: row.row_id, direction: row.direction, method: row.method, status: row.status as 'applied' | 'refused',
      from: isMode(row.old_mode) ? row.old_mode : null, to: isMode(row.new_mode) ? row.new_mode : null,
      reason: row.reason, origin: row.origin, createdAt: row.created_at, ...who(row, viewer),
    }));
  }

  return {
    // The accounts this user may trade right now: STUDIO_T212_TRADING ∩ their choice (pinned on the first read).
    allowed(userId: number, requester?: StudioT212Requester) {
      return current(userId, requester).allowed;
    },

    // For Settings: the mode in force, the server ceiling, and whether the choice is stored (it is after this read).
    view(userId: number, requester?: StudioT212Requester) {
      const state = current(userId, requester);
      return { mode: modeOf(state.allowed), ceiling, custom: state.custom, updatedAt: state.updatedAt };
    },

    // Newest first, applied changes and refused widenings listed apart, so a burst of refusals never hides a change.
    // `viewer` marks the entries that came from the session reading them.
    history(userId: number, viewer?: StudioT212Requester) {
      return { applied: historyOf(userId, 'applied', viewer), refused: historyOf(userId, 'refused', viewer) };
    },

    // The widening challenges handed out, newest first, with who asked and what became of each.
    issued(userId: number, viewer?: StudioT212Requester) {
      return rowsOf(userId, 'issued').map(row => ({
        id: `mode-${row.row_id}`, kind: 'mode' as const, to: isMode(row.new_mode) ? row.new_mode : null,
        outcome: stepUp.outcome(row), origin: row.origin, createdAt: row.created_at, ...who(row, viewer),
      }));
    },

    // Starts a widening: checks the ceiling, that it widens, that this domain has a passkey and this session's hourly
    // limits (issued challenges and real Face ID failures, never other refusals), then issues (and audits, in the
    // same synchronous step as the limit check) the bound, single-use challenge. The reply carries the mode in force,
    // the new one, the accounts it adds and the ceiling, which the review shows and the challenge is bound to.
    async challenge(userId: number, origin: StudioT212TrustedOrigin, mode: StudioT212TradingMode, requester = NO_REQUESTER) {
      const outside = ceilingRefusal(mode);
      if (outside) fail(outside, 403, 'T212_MODE_CEILING');
      const before = read(userId);
      const change = direction(before, mode);
      if (!change || change === 'pin') fail(`交易模式已经是「${MODE_LABEL[mode]}」`, 400, 'T212_MODE_UNCHANGED');
      if (change === 'narrow') fail('关闭或减少账户不需要面容 ID / 触控 ID，直接保存即可', 400, 'T212_MODE_NOT_WIDENING');
      const missing = passkeyRefusal(userId, origin.rpId);
      if (missing) fail(missing, 403, 'T212_MODE_PASSKEY_REQUIRED');
      assertUnderLimit(userId, requester, 'failed', MAX_FAILURES_PER_WINDOW, '面容 ID / 触控 ID 验证失败的次数过多');
      assertUnderLimit(userId, requester, 'issued', MAX_CHALLENGES_PER_WINDOW, '一小时内发起开启下单的次数过多');
      const binding: WidenBinding = { from: modeOf(before.allowed), to: mode };
      const rowId = audit(userId, requester, { from: binding.from, to: mode, direction: 'widen', method: 'passkey', status: 'issued', origin: origin.origin });
      const issued = await stepUp.issue(userId, requester, origin, binding, rowId);
      return { ...issued, from: binding.from, to: mode, adds: added(before, mode), ceiling };
    },

    // Saves a new mode. Narrowing and pinning need only the session (origin may be null when the page is not on the
    // trading allowlist); widening needs the assertion for a challenge issued to this session for exactly this mode,
    // from the mode still in force, on this origin.
    async update(userId: number, origin: StudioT212TrustedOrigin | null, request: StudioT212ModeRequest, requester = NO_REQUESTER) {
      // A named challenge of this session is spent before anything else is checked, whatever happens next (malformed
      // body, a mode outside the ceiling, a failed signature), and synchronously so a parallel attempt with the same
      // id finds it gone. Another user's or session's id is ignored rather than spent, so it cannot burn theirs.
      const named = request.challengeId !== undefined;
      const widening = stepUp.take(userId, requester, request.challengeId);
      const mode = 'mode' in request ? request.mode : null;
      // Not pinned by this read: saving the mode in force is how a user without a stored choice pins it.
      const before = read(userId);
      const inForce = modeOf(before.allowed);
      // What the attempt was about: the submitted mode, or else the mode its challenge was issued for.
      const target = mode ?? widening?.binding.to ?? null;

      // A refused widening attempt (one that named a challenge, left the ceiling, or widened without a challenge) is
      // audited until this session's hourly limit; beyond it the attempt gets a 429 and no further row.
      function refuseWidening(reason: string, statusCode: number, code: string): never {
        assertUnderLimit(userId, requester, 'refused', MAX_REFUSALS_PER_WINDOW, '开启下单被拒绝的次数过多');
        audit(userId, requester, {
          from: inForce, to: target, direction: 'widen', method: named ? 'passkey' : 'session', status: 'refused',
          reason, code, origin: origin?.origin ?? null,
        });
        return fail(reason, statusCode, code);
      }

      if (!mode) {
        const reason = 'invalid' in request ? request.invalid : '请求格式无效';
        return named ? refuseWidening(reason, 400, 'T212_MODE_INVALID') : fail(reason, 400, 'T212_MODE_INVALID');
      }
      // Outside the ceiling is always an attempt to add an account the server does not allow.
      const outside = ceilingRefusal(mode);
      if (outside) refuseWidening(outside, 403, 'T212_MODE_CEILING');
      const change = direction(before, mode);
      if (!change) {
        const reason = `交易模式已经是「${MODE_LABEL[mode]}」`;
        return named ? refuseWidening(reason, 400, 'T212_MODE_UNCHANGED') : fail(reason, 400, 'T212_MODE_UNCHANGED');
      }
      if (change !== 'widen') {
        saveAudited(userId, requester, mode, { from: inForce, to: mode, direction: change, method: 'session', status: 'applied', origin: origin?.origin ?? null });
        return { mode, direction: change, method: 'session' as const };
      }

      if (!named) {
        // Say what is missing: an allowlisted page, a passkey on this domain, or just the Face ID step.
        const reason = origin ? passkeyRefusal(userId, origin.rpId) ?? '开启下单需要面容 ID / 触控 ID 验证' : WIDEN_PROBLEMS['untrusted-origin'][0];
        refuseWidening(reason, 403, 'T212_MODE_PASSKEY_REQUIRED');
      }
      if (!widening) refuseWidening('这次面容 ID 验证不存在或已经用过，请重新选择', 410, 'T212_MODE_CHALLENGE_GONE');
      // Bound to the mode in force now: if it changed since the review, the approval no longer fits.
      const verdict = await stepUp.verify(widening, userId, requester, origin, { from: inForce, to: mode }, 'assertion' in request ? request.assertion : undefined);
      if ('problem' in verdict) {
        const [reason, statusCode, code] = WIDEN_PROBLEMS[verdict.problem];
        refuseWidening(reason, statusCode, code);
      }
      // The verification awaited, so the audit records the mode as it was at the moment of saving.
      saveAudited(userId, requester, mode, {
        from: modeOf(read(userId).allowed), to: mode, direction: 'widen', method: 'passkey', status: 'applied',
        origin: verdict.origin.origin, passkeyId: verdict.passkeyId,
      });
      return { mode, direction: change, method: 'passkey' as const };
    },
  };
}
