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
  resolve(userId: string | number, runId: string): boolean {
    return taskRunsDb.resolve(userId, runId);
  },
};

/** Server startup calls this once before initializing dispatchers; no provider is invoked. */
export function initializeTaskRecovery(): number {
  const interruptedCount = taskRunsDb.interruptUnfinished();
  scheduledMessagesDb.failInterruptedClaims();
  return interruptedCount;
}
