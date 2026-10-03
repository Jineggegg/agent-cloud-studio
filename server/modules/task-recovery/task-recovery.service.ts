import { scheduledMessagesDb, taskRunsDb } from '@/modules/database/index.js';
import { notifyRunInterrupted } from '@/modules/notifications/index.js';
import type { TaskRecoveryFilters, TaskRunRecord } from '@/shared/index.js';

/** Task Recovery routes use this read/acknowledge surface; execution stays in the WebSocket gateway. */
export const taskRecoveryService = {
  list(userId: string | number, filters: TaskRecoveryFilters): TaskRunRecord[] {
    return taskRunsDb.listInterrupted(userId, filters);
  },
  findRequest(userId: string | number, requestId: string): TaskRunRecord | null {
    return taskRunsDb.getByRequestId(userId, requestId);
  },
  /**
   * Acknowledging is idempotent for the owner: a record that was already resolved, or claimed by a
   * continuation (possibly from another device), has nothing left to review. Records that do not
   * exist or belong to another user stay indistinguishable ('not_found').
   */
  resolve(userId: string | number, runId: string): 'resolved' | 'already_handled' | 'not_found' {
    if (taskRunsDb.resolve(userId, runId)) return 'resolved';
    const run = taskRunsDb.getByRunId(runId);
    if (!run || run.userId !== String(userId)) return 'not_found';
    return run.resolvedAt !== null || run.claimedByRunId !== null ? 'already_handled' : 'not_found';
  },
};

// Runs the last initializeTaskRecovery interrupted, waiting for announceInterruptedRuns (Web Push is configured later).
let interruptedAtStartup: TaskRunRecord[] = [];

/** Server startup calls this once before initializing dispatchers; no provider is invoked. */
export function initializeTaskRecovery(): number {
  const unfinished = taskRunsDb.listUnfinished();
  const interruptedCount = taskRunsDb.interruptUnfinished();
  scheduledMessagesDb.failInterruptedClaims();
  interruptedAtStartup = unfinished;
  return interruptedCount;
}

/**
 * Server startup calls this once Web Push is configured: one "interrupted" notification per session whose run
 * the previous process left unfinished (several runs of one session make one notification). Returns how many
 * sessions were announced; a second call announces nothing.
 */
export function announceInterruptedRuns(notify: (run: TaskRunRecord) => void = notifyInterrupted): number {
  const runs = interruptedAtStartup;
  interruptedAtStartup = [];
  const announced = new Set<string>();
  for (const run of runs) {
    const key = `${run.userId ?? ''}\u0000${run.sessionId || run.runId}`;
    if (announced.has(key)) continue;
    announced.add(key);
    notify(run);
  }
  return announced.size;
}

function notifyInterrupted(run: TaskRunRecord): void {
  const userId = run.userId === null ? null : Number(run.userId);
  if (!userId || !Number.isSafeInteger(userId)) return;
  notifyRunInterrupted({ userId, provider: run.provider, sessionId: run.sessionId || null, runId: run.runId });
}
