import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';

import type { TaskRecoveryRun } from '@/shared/types';

/**
 * Used by ChatInterface and the workbench chat column (WorkbenchAgentChat) to show interrupted executions beside the
 * composer for explicit review and continuation.
 */
export function ChatRecoveryBanner({ runs, error, disabled, onRefresh, onViewRecords, onPrepare, onResolve }: {
  runs: TaskRecoveryRun[];
  error?: boolean;
  disabled?: boolean;
  onRefresh: () => void;
  onViewRecords: (run: TaskRecoveryRun) => void;
  onPrepare: (run: TaskRecoveryRun) => void;
  onResolve: (runId: string) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  // Resolution failures remain next to the record; they must not silently dismiss it.
  const [resolveState, setResolveState] = useState<{ runId: string; failed: boolean } | null>(null);
  if (!runs.length && !error) return null;
  const actionClass = 'min-h-11 rounded-lg px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <section aria-label={t('recovery.title', { defaultValue: 'Interrupted execution' })} className="mx-auto mb-3 max-h-[40dvh] w-full max-w-[54.25rem] overflow-y-auto rounded-xl border border-border bg-muted/40 p-3 text-foreground">
      {error && <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{t('recovery.loadFailed', { defaultValue: 'Recovery records could not be loaded. Check your connection and try again.' })}</span>
        <button type="button" className={actionClass} onClick={onRefresh}>{t('recovery.refresh', { defaultValue: 'Refresh records' })}</button>
      </div>}
      {runs.map((run) => <div key={run.runId} className="border-border py-1 [&+&]:mt-3 [&+&]:border-t [&+&]:pt-3">
        <div className="flex items-start gap-2">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{run.state === 'failed'
              ? t('recovery.failedTitle', { defaultValue: 'Execution did not finish' })
              : t('recovery.title', { defaultValue: 'Interrupted execution' })}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('recovery.description', { defaultValue: 'Some actions may already have completed. Review the result before continuing; previous approvals will not be replayed.' })}</p>
            {!run.sessionId && <p className="mt-1 text-sm text-muted-foreground">{t('recovery.noSession', { defaultValue: 'This first execution has no recoverable conversation yet. Check the original request below before preparing a new continuation.' })}</p>}
            <details className="mt-2 text-sm">
              <summary className="min-h-11 cursor-pointer content-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('recovery.original', { defaultValue: 'Original request' })}</summary>
              <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2">{run.content}</p>
            </details>
          </div>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {run.sessionId && <button type="button" className={actionClass} onClick={() => onViewRecords(run)}>{t('recovery.view', { defaultValue: 'View records' })}</button>}
          <button type="button" disabled={disabled} className={`${actionClass} text-primary`} onClick={() => onPrepare(run)}>{t('recovery.prepare', { defaultValue: 'Prepare continuation' })}</button>
          <button type="button" disabled={resolveState?.runId === run.runId && !resolveState.failed} className={`${actionClass} text-muted-foreground`} onClick={async () => {
            setResolveState({ runId: run.runId, failed: false });
            try { await onResolve(run.runId); setResolveState(null); }
            catch { setResolveState({ runId: run.runId, failed: true }); }
          }}>{t('recovery.resolve', { defaultValue: 'Mark reviewed' })}</button>
        </div>
        {resolveState?.runId === run.runId && resolveState.failed && <p role="alert" className="mt-1 text-sm text-destructive">{t('recovery.resolveFailed', { defaultValue: 'Could not update this record. Please try again.' })}</p>}
      </div>)}
    </section>
  );
}
