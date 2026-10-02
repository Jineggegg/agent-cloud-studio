import { useTranslation } from 'react-i18next';

import type { ChatDeliveryState } from '@/shared/types';

/** ChatComposer displays delivery uncertainty without pretending that a model execution has started. */
export function ChatDeliveryStatus({ delivery, pendingContent, onCheck, onRetry, isConnected = true }: {
  delivery: ChatDeliveryState | null;
  pendingContent?: string | null;
  onCheck: () => void;
  onRetry: () => void;
  isConnected?: boolean;
}) {
  const { t } = useTranslation('chat');
  if (!delivery) return null;
  return <div role="status" aria-live="polite" className="mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
    <p>{t(`delivery.${delivery.state}`, { defaultValue: delivery.state === 'sending'
      ? 'Waiting for delivery confirmation. Your draft is kept until the server confirms it.'
      : delivery.state === 'unknown'
        ? 'Delivery is unconfirmed. Review the conversation before retrying the original message. Your new edits will be kept.'
        : 'The message was not sent. Your draft and attachments have been kept.' })}</p>
    {delivery.errorCode === 'RECOVERY_NOT_AVAILABLE'
      ? <p className="mt-1 text-muted-foreground">{t('delivery.recoveryUnavailable', { defaultValue: 'This task was already continued on another device or marked reviewed. Check its records; remove the recovery link before writing a separate request.' })}</p>
      : delivery.error && <p className="mt-1 break-words text-muted-foreground">{delivery.error}</p>}
    {delivery.state === 'unknown' && pendingContent && <details className="mt-1">
      <summary className="min-h-11 cursor-pointer content-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('delivery.original', { defaultValue: 'Review original message' })}</summary>
      <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2">{pendingContent}</p>
    </details>}
    {delivery.state === 'unknown' && <div className="mt-1 flex flex-wrap gap-1">
      <button type="button" disabled={!isConnected} onClick={onCheck} className="min-h-11 rounded-lg px-3 font-medium text-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{t('delivery.check', { defaultValue: 'Check delivery' })}</button>
      <button type="button" disabled={!isConnected} onClick={onRetry} className="min-h-11 rounded-lg px-3 font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{t('delivery.retry', { defaultValue: 'Retry original after review' })}</button>
    </div>}
  </div>;
}
