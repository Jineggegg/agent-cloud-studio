import { scheduledMessagesDb, taskRunsDb } from '@/modules/database/index.js';
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

/** Server startup calls this once before initializing dispatchers; no provider is invoked. */
export function initializeTaskRecovery(): number {
  const interruptedCount = taskRunsDb.interruptUnfinished();
  scheduledMessagesDb.failInterruptedClaims();
  return interruptedCount;
}
