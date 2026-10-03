import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { taskRunsDb } from '@/modules/database/repositories/task-runs.db.js';
import { AppError } from '@/shared/index.js';
import type { SessionDraftInput, SessionDraftRecord, TaskRunRecord } from '@/shared/index.js';

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  recovery_of_run_id: string | null;
  updated_at: string;
};

/** A server-owned queued turn together with the exact stored value used to claim it once. */
export type QueuedSessionMessageRecord = {
  userId: number;
  sessionId: string;
  queuedMessage: unknown;
  claimToken: string;
  /** Set by the atomic claim; the dispatcher executes this exact durable record. */
  execution?: TaskRunRecord;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
};

/** A queued message that no longer parses is treated as absent, not fatal. */
function parseQueuedMessage(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessage: parseQueuedMessage(row.queued_message),
    recoveryOfRunId: row.recovery_of_run_id,
    updatedAt: row.updated_at,
  };
}

/** User reads/writes composer drafts; Scheduled Messages claims queued turns atomically. */
export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, recovery_of_run_id, updated_at
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /** Lists persisted queued turns whose scopes are real chat sessions. */
  listQueuedMessages(): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL`
      )
      .all() as QueuedMessageRow[];

    return rows.map((row) => ({
      userId: row.user_id,
      sessionId: row.draft_scope,
      queuedMessage: parseQueuedMessage(row.queued_message),
      claimToken: row.queued_message,
    }));
  },

  /** Removes a queued turn in the same transaction that preserves its execution input. */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    const db = getConnection();
    const value = candidate.queuedMessage;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    const content = typeof message.content === 'string' ? message.content : '';
    const attachments = Array.isArray(message.attachments) ? message.attachments : Array.isArray(message.images) ? message.images : [];
    if (!content.trim() && attachments.length === 0) return false;
    const options = message.options && typeof message.options === 'object' && !Array.isArray(message.options)
      ? message.options as Record<string, unknown> : {};
    return db.transaction(() => {
      const result = db.prepare(
        `UPDATE session_drafts SET queued_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      ).run(candidate.userId, candidate.sessionId, candidate.claimToken);
      if (result.changes === 0) return false;
      const session = sessionsDb.getSessionById(candidate.sessionId);
      if (!session) throw new Error('Queued session disappeared during claim.');
      const accepted = taskRunsDb.accept({
        userId: candidate.userId, requestId: `queued:${randomUUID()}`,
        sessionId: candidate.sessionId, provider: session.provider,
        projectPath: session.project_path, content,
        options: { ...options, attachments }, source: 'queued',
      });
      if (accepted.kind !== 'accepted') throw new Error('Queued execution could not be accepted.');
      candidate.execution = accepted.run;
      return true;
    })();
  },

  /** Remove drained queue placeholders while preserving another device's prepared recovery. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL AND recovery_of_run_id IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's draft, or deletes the row when nothing is left to keep.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into.
   */
  saveDraft(userId: number, scope: string, draft: SessionDraftInput): void {
    const db = getConnection();
    db.transaction(() => {
      if (!draft.text && draft.queuedMessage === null) {
        db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
          .run(userId, scope);
        return;
      }
      const previous = db.prepare(`SELECT recovery_of_run_id FROM session_drafts
        WHERE user_id = ? AND draft_scope = ?`).get(userId, scope) as
        { recovery_of_run_id: string | null } | undefined;
      const recoveryOfRunId = draft.recoveryOfRunId === undefined
        ? previous?.recovery_of_run_id ?? null : draft.recoveryOfRunId;
      if (recoveryOfRunId !== null) {
        const run = taskRunsDb.getByRunId(recoveryOfRunId);
        const session = sessionsDb.getSessionById(scope);
        if (!run || run.userId !== String(userId) || run.sessionId !== scope
          || !session || run.projectPath !== session.project_path || run.provider !== session.provider
          || (run.state !== 'interrupted' && run.state !== 'failed')
          || run.resolvedAt !== null || run.claimedByRunId !== null) {
          throw new AppError('Recovery task is unavailable for this draft', {
            code: 'INVALID_DRAFT_RECOVERY', statusCode: 400,
          });
        }
      }
      // Validate and persist on the same connection/transaction, without claiming
      // the task. A subsequent send still has to win taskRunsDb.accept's claim.
      db.prepare(
        `INSERT INTO session_drafts
          (user_id, draft_scope, draft_text, queued_message, recovery_of_run_id, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           draft_text = excluded.draft_text,
           queued_message = excluded.queued_message,
           recovery_of_run_id = excluded.recovery_of_run_id,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, scope, draft.text,
        draft.queuedMessage === null ? null : JSON.stringify(draft.queuedMessage), recoveryOfRunId);
    })();
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .run(userId, scope);
  },
};
