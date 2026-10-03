import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { taskRunsDb } from '@/modules/database/repositories/task-runs.db.js';
import type { TaskRunRecord } from '@/shared/types.js';

export type ScheduledMessageStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'cancelled';

export type ScheduledMessageRow = {
  id: string;
  user_id: number;
  session_id: string;
  content: string;
  options: string;
  scheduled_for: string;
  status: ScheduledMessageStatus;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, user_id, session_id, content, options, scheduled_for, status, failure_reason, created_at, updated_at';

export const scheduledMessagesDb = {
  create(input: {
    userId: number;
    sessionId: string;
    content: string;
    options: unknown;
    scheduledFor: Date;
  }): ScheduledMessageRow {
    const db = getConnection();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO scheduled_messages (id, user_id, session_id, content, options, scheduled_for, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      id,
      input.userId,
      input.sessionId,
      input.content,
      JSON.stringify(input.options ?? {}),
      input.scheduledFor.toISOString(),
    );

    return db.prepare(`SELECT ${COLUMNS} FROM scheduled_messages WHERE id = ?`).get(id) as ScheduledMessageRow;
  },

  /** Everything still to come or recently resolved, newest schedule first. */
  listForSession(userId: number, sessionId: string): ScheduledMessageRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_messages
         WHERE user_id = ? AND session_id = ?
         ORDER BY scheduled_for ASC`
      )
      .all(userId, sessionId) as ScheduledMessageRow[];
  },

  listPendingForUser(userId: number): ScheduledMessageRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM scheduled_messages
         WHERE user_id = ? AND status = 'pending'
         ORDER BY scheduled_for ASC`
      )
      .all(userId) as ScheduledMessageRow[];
  },

  /**
   * Claims due schedules together with durable execution receipts in one
   * transaction. A claimed schedule is not yet a successfully sent message.
   *
   * Claiming is what makes a missed schedule work: the server can be down at
   * the moment a message was due, and the next poll after it starts picks the
   * pending message up instead of skipping it. Once claimed, a crash leaves
   * recoverable input for manual review instead of automatically replaying it.
   * The transaction prevents overlapping polls from sending a message twice.
   */
  claimDue(now: Date): Array<ScheduledMessageRow & { execution: TaskRunRecord }> {
    const db = getConnection();
    const nowIso = now.toISOString();

    return db.transaction(() => {
      const due = db
        .prepare(
          `SELECT ${COLUMNS} FROM scheduled_messages
           WHERE status = 'pending' AND scheduled_for <= ?
           ORDER BY scheduled_for ASC`
        )
        .all(nowIso) as ScheduledMessageRow[];

      return due.map((row) => {
        const session = sessionsDb.getSessionById(row.session_id);
        if (!session) throw new Error('Scheduled message session disappeared during claim.');
        let options: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(row.options);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) options = parsed as Record<string, unknown>;
        } catch { /* Invalid old options fall back to defaults. */ }
        const result = taskRunsDb.accept({
          userId: row.user_id, requestId: `scheduled:${row.id}`,
          sessionId: row.session_id, provider: session.provider,
          projectPath: session.project_path, content: row.content,
          options, source: 'scheduled',
        });
        if (result.kind !== 'accepted') throw new Error('Scheduled execution was already claimed.');
        db.prepare(
          `UPDATE scheduled_messages SET status = 'claimed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(row.id);
        return { ...row, execution: result.run };
      });
    })();
  },

  /** Marks completion only after the dispatcher has observed the runtime settle. */
  markSent(id: string): void {
    getConnection().prepare(
      `UPDATE scheduled_messages SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'claimed'`
    ).run(id);
  },

  /** Startup recovery never sends a previously claimed schedule a second time. */
  failInterruptedClaims(): void {
    getConnection().prepare(
      `UPDATE scheduled_messages SET status = 'failed', failure_reason = 'The service restarted during execution. Review the interrupted task before continuing.', updated_at = CURRENT_TIMESTAMP WHERE status = 'claimed'`
    ).run();
  },

  markFailed(id: string, reason: string): void {
    getConnection()
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(reason.slice(0, 500), id);
  },

  /**
   * Cancels a pending message, or dismisses a failed one so its banner goes
   * away. Returns false when it had already fired successfully.
   */
  cancel(userId: number, id: string): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND status IN ('pending', 'failed')`
      )
      .run(id, userId);

    return result.changes > 0;
  },
};
