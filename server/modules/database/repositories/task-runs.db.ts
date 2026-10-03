import { createHash, randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { TaskRecoveryFilters, TaskRunRecord } from '@/shared/index.js';

type TaskRunRow = {
  run_id: string;
  request_id: string;
  user_id: string | null;
  session_id: string;
  provider: string;
  project_path: string | null;
  content: string;
  options: string;
  source: TaskRunRecord['source'];
  recovery_of_run_id: string | null;
  state: TaskRunRecord['state'];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  interrupted_at: string | null;
  resolved_at: string | null;
  claimed_by_run_id: string | null;
  error: string | null;
};

type AcceptTaskInput = {
  userId: string | number | null;
  requestId: string;
  sessionId: string;
  provider: string;
  projectPath: string | null;
  content: string;
  options: Record<string, unknown>;
  recoveryOfRunId?: string;
  source?: TaskRunRecord['source'];
  runId?: string;
};

type AcceptTaskResult =
  | { kind: 'accepted' | 'duplicate'; run: TaskRunRecord }
  | { kind: 'rejected'; errorCode: string };

function userKey(userId: string | number | null): string {
  return userId === null ? '' : String(userId);
}

function toRecord(row: TaskRunRow): TaskRunRecord {
  return {
    runId: row.run_id,
    requestId: row.request_id,
    userId: row.user_id,
    sessionId: row.session_id,
    provider: row.provider,
    projectPath: row.project_path,
    content: row.content,
    options: JSON.parse(row.options) as Record<string, unknown>,
    source: row.source,
    recoveryOfRunId: row.recovery_of_run_id,
    state: row.state,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    interruptedAt: row.interrupted_at,
    resolvedAt: row.resolved_at,
    claimedByRunId: row.claimed_by_run_id,
    error: row.error,
  };
}

function getByRunId(runId: string): TaskRunRecord | null {
  const row = getConnection().prepare('SELECT * FROM task_runs WHERE run_id = ?')
    .get(runId) as TaskRunRow | undefined;
  return row ? toRecord(row) : null;
}

function getByRequestId(userId: string | number | null, requestId: string): TaskRunRecord | null {
  const row = getConnection().prepare('SELECT * FROM task_runs WHERE user_key = ? AND request_id = ?')
    .get(userKey(userId), requestId) as TaskRunRow | undefined;
  return row ? toRecord(row) : null;
}

// Build the object in fixed key order for stable request comparison. Never persist
// arbitrary nested objects: composer payloads can also contain credentials or env.
function safeOptions(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ['model', 'effort', 'permissionMode', 'cwd', 'projectPath', 'resumeAnchorId', 'operation', 'editAnchorId']) {
    if (typeof input[key] === 'string') output[key] = input[key];
  }
  if (typeof input.resumeFromScratch === 'boolean') output.resumeFromScratch = input.resumeFromScratch;
  for (const key of ['images', 'files', 'attachments']) {
    if (!Array.isArray(input[key])) continue;
    output[key] = input[key].flatMap((entry: unknown) => {
      if (typeof entry === 'string' && entry.trim()) return [{ path: entry.trim() }];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const raw = entry as Record<string, unknown>;
      if (typeof raw.path !== 'string' || !raw.path.trim()) return [];
      const descriptor: Record<string, unknown> = { path: raw.path.trim() };
      for (const field of ['name', 'mimeType']) {
        if (typeof raw[field] === 'string') descriptor[field] = raw[field];
      }
      if (typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0) {
        descriptor.size = raw.size;
      }
      return [descriptor];
    });
  }
  return output;
}

/** Durable receipts used by WebSocket/dispatchers for execution and Task Recovery for manual decisions. */
export const taskRunsDb = {
  getByRunId,
  getByRequestId,

  /** Reserve a request and, when requested, its failed or interrupted predecessor in one transaction. */
  accept(input: AcceptTaskInput): AcceptTaskResult {
    const key = userKey(input.userId);
    if (!input.requestId?.trim() || !input.sessionId?.trim() || !input.provider?.trim()
      || (input.userId !== null && !key.trim()) || typeof input.content !== 'string'
      || !input.options || typeof input.options !== 'object' || Array.isArray(input.options)) {
      return { kind: 'rejected', errorCode: 'INVALID_TASK_REQUEST' };
    }
    const options = safeOptions(input.options);
    const serializedOptions = JSON.stringify(options);
    const recoveryOfRunId = input.recoveryOfRunId ?? null;
    const runId = input.runId ?? randomUUID();
    let fingerprint: string;
    try {
      // Fingerprint all execution input, including non-persisted runtime settings.
      // A changed tool allowlist must conflict even though credentials/configuration
      // are deliberately absent from the recoverable options stored above.
      const identity = JSON.stringify({
        sessionId: input.sessionId, provider: input.provider, projectPath: input.projectPath,
        content: input.content, options: input.options, recoveryOfRunId,
      }, (_key, value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      });
      fingerprint = createHash('sha256').update(identity).digest('hex');
    } catch {
      return { kind: 'rejected', errorCode: 'INVALID_TASK_REQUEST' };
    }
    const db = getConnection();

    return db.transaction((): AcceptTaskResult => {
      const existing = getByRequestId(input.userId, input.requestId);
      if (existing) {
        const row = db.prepare('SELECT request_fingerprint FROM task_runs WHERE run_id = ?')
          .get(existing.runId) as { request_fingerprint: string };
        const matches = row.request_fingerprint === fingerprint;
        return matches
          ? { kind: 'duplicate', run: existing }
          : { kind: 'rejected', errorCode: 'REQUEST_ID_CONFLICT' };
      }
      if (getByRunId(runId)) return { kind: 'rejected', errorCode: 'RUN_ID_CONFLICT' };
      const now = new Date().toISOString();
      if (recoveryOfRunId) {
        const previous = getByRunId(recoveryOfRunId);
        if (!previous || userKey(previous.userId) !== key || (previous.state !== 'interrupted' && previous.state !== 'failed')
          || previous.resolvedAt !== null || previous.claimedByRunId !== null) {
          return { kind: 'rejected', errorCode: 'RECOVERY_NOT_AVAILABLE' };
        }
        if (previous.sessionId !== input.sessionId || previous.provider !== input.provider
          || previous.projectPath !== input.projectPath) {
          return { kind: 'rejected', errorCode: 'RECOVERY_TARGET_MISMATCH' };
        }
        const claim = db.prepare(`UPDATE task_runs SET claimed_by_run_id = ?, resolved_at = ?
          WHERE run_id = ? AND user_key = ? AND state IN ('interrupted', 'failed')
          AND resolved_at IS NULL AND claimed_by_run_id IS NULL`)
          .run(runId, now, recoveryOfRunId, key);
        if (claim.changes !== 1) return { kind: 'rejected', errorCode: 'RECOVERY_NOT_AVAILABLE' };
      }
      // Any insertion failure rolls back the predecessor claim as well. This
      // transaction is nestable inside a queued-message/schedule claim transaction.
      db.prepare(`INSERT INTO task_runs
        (run_id, request_id, request_fingerprint, user_id, user_key, session_id, provider, project_path,
         content, options, source, recovery_of_run_id, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`)
        .run(runId, input.requestId, fingerprint, input.userId === null ? null : key, key, input.sessionId,
          input.provider, input.projectPath, input.content, serializedOptions,
          input.source ?? 'interactive', recoveryOfRunId, now);
      return { kind: 'accepted', run: getByRunId(runId)! };
    }).immediate();
  },

  /** Only an accepted receipt may start; completed or interrupted work cannot restart silently. */
  markRunning(runId: string): boolean {
    return getConnection().prepare(`UPDATE task_runs SET state = 'running', started_at = ?
      WHERE run_id = ? AND state = 'accepted'`).run(new Date().toISOString(), runId).changes > 0;
  },

  settle(runId: string, result: { state: 'completed' | 'failed' | 'aborted'; error?: string }): void {
    getConnection().prepare(`UPDATE task_runs SET state = ?, error = ?, completed_at = ?
      WHERE run_id = ? AND state IN ('accepted', 'running')`)
      .run(result.state, result.error?.slice(0, 2000) ?? null, new Date().toISOString(), runId);
  },

  /** Preserve an uncertain dispatch for user inspection without replaying its side effects. */
  interrupt(runId: string, error?: string): void {
    getConnection().prepare(`UPDATE task_runs SET state = 'interrupted', interrupted_at = ?, error = ?
      WHERE run_id = ? AND state IN ('accepted', 'running')`)
      .run(new Date().toISOString(), error?.slice(0, 2000) ?? null, runId);
  },

  /** Called once after database initialization, before accepting any new runtime work. */
  interruptUnfinished(): number {
    return getConnection().prepare(`UPDATE task_runs SET state = 'interrupted', interrupted_at = ?
      WHERE state IN ('accepted', 'running')`).run(new Date().toISOString()).changes;
  },

  /** Runs still accepted or running: at startup, the ones the previous server process left unfinished. */
  listUnfinished(): TaskRunRecord[] {
    const rows = getConnection().prepare(`SELECT * FROM task_runs WHERE state IN ('accepted', 'running')
      ORDER BY created_at ASC, run_id ASC`).all() as TaskRunRow[];
    return rows.map(toRecord);
  },

  /** Recovery includes failed turns so a claimed queued or continued task cannot disappear on failure. */
  listInterrupted(userId: string | number | null, filters: TaskRecoveryFilters = {}): TaskRunRecord[] {
    const clauses = ["user_key = ?", "state IN ('interrupted', 'failed')", 'resolved_at IS NULL', 'claimed_by_run_id IS NULL'];
    const values: Array<string | number> = [userKey(userId)];
    if (filters.projectPath !== undefined) { clauses.push('project_path = ?'); values.push(filters.projectPath); }
    if (filters.sessionId !== undefined) { clauses.push('session_id = ?'); values.push(filters.sessionId); }
    if (filters.unassigned) clauses.push("session_id = ''");
    const limit = Number.isFinite(filters.limit) ? Math.min(100, Math.max(1, Math.floor(filters.limit!))) : 50;
    values.push(limit);
    const rows = getConnection().prepare(`SELECT * FROM task_runs WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, run_id DESC LIMIT ?`).all(...values) as TaskRunRow[];
    return rows.map(toRecord);
  },

  /** Resolving is an explicit acknowledgement; it never executes or deletes the original turn. */
  resolve(userId: string | number | null, runId: string): boolean {
    return getConnection().prepare(`UPDATE task_runs SET resolved_at = ?
      WHERE run_id = ? AND user_key = ? AND state IN ('interrupted', 'failed')
      AND resolved_at IS NULL AND claimed_by_run_id IS NULL`)
      .run(new Date().toISOString(), runId, userKey(userId)).changes > 0;
  },
};
