import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ChatDeliveryState, PendingChatDelivery, ServerEvent } from '@/shared/types';

const DELIVERY_TIMEOUT_MS = 20_000;
const STORAGE_PREFIX = 'chat-pending-delivery:';
const KNOWN_RUN_STATES = ['accepted', 'running', 'completed', 'failed', 'interrupted', 'aborted'];

async function lookupDelivery(pending: PendingChatDelivery): Promise<ServerEvent | null> {
  const response = await api.taskRecovery.requestStatus(pending.requestId);
  // An older or rolled-back backend can execute chat.send while ignoring its
  // request id. Only this authenticated endpoint's exact contract proves that
  // the current server understands durable request deduplication.
  if (response.status !== 200) throw new Error('Delivery lookup unavailable');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('run' in body)) {
    throw new Error('Invalid delivery lookup');
  }
  if (body.run === null) return null;
  if (!body.run || typeof body.run !== 'object' || Array.isArray(body.run)) throw new Error('Invalid delivery record');
  const run = body.run as ServerEvent;
  if (run.requestId !== pending.requestId || run.sessionId !== pending.sessionId
    || typeof run.runId !== 'string' || !run.runId
    || typeof run.state !== 'string' || !KNOWN_RUN_STATES.includes(run.state)) {
    throw new Error('Invalid delivery record');
  }
  return { ...run, kind: 'run_accepted', deliveryLookup: true };
}

function readPending(scope: string | null): PendingChatDelivery | null {
  if (!scope) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(`${STORAGE_PREFIX}${scope}`) || 'null');
    return value?.scope === scope && typeof value?.requestId === 'string' && value?.payload
      ? value as PendingChatDelivery
      : null;
  } catch {
    return null;
  }
}

function persistPending(pending: PendingChatDelivery, remove = false) {
  try {
    if (remove) sessionStorage.removeItem(`${STORAGE_PREFIX}${pending.scope}`);
    else sessionStorage.setItem(`${STORAGE_PREFIX}${pending.scope}`, JSON.stringify(pending));
  } catch {
    // Private browsing/storage quota must not turn a send into a false success.
  }
}

/** Chat's composer uses server receipts, never WebSocket.send success, to clear a submitted draft. */
export function useChatDelivery({
  scope,
  subscribe,
  sendMessage,
  isConnected,
  onAccepted,
  onRestore,
}: {
  scope: string | null;
  subscribe?: (listener: (event: ServerEvent) => void) => () => void;
  sendMessage: (message: unknown) => boolean | void;
  isConnected?: boolean;
  onAccepted: (pending: PendingChatDelivery, event: ServerEvent) => void;
  onRestore: (pending: PendingChatDelivery) => PendingChatDelivery;
}) {
  const pendingRef = useRef<PendingChatDelivery | null>(readPending(scope));
  const scopeRef = useRef(scope);
  const acceptedRef = useRef(onAccepted);
  const restoreRef = useRef(onRestore);
  const connectionRef = useRef(isConnected);
  const retryingRef = useRef<PendingChatDelivery | null>(null);
  // The listener remains stable while its callbacks follow the committed view.
  useLayoutEffect(() => {
    scopeRef.current = scope;
    acceptedRef.current = onAccepted;
    restoreRef.current = onRestore;
    connectionRef.current = isConnected;
  }, [scope, onAccepted, onRestore, isConnected]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The composer shows unconfirmed delivery independently of a running model.
  const [delivery, setDelivery] = useState<ChatDeliveryState | null>(() => {
    const pending = readPending(scope);
    return pending ? { requestId: pending.requestId, state: 'unknown' } : null;
  });
  // Users can inspect the original send even after they have edited the next draft.
  const [pendingContent, setPendingContent] = useState<string | null>(() => readPending(scope)?.content ?? null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const handleReceipt = useCallback((event: ServerEvent) => {
    const pending = pendingRef.current;
    if (!pending || event.requestId !== pending.requestId) return;
    if (event.kind === 'run_accepted' || event.type === 'run-accepted') {
      clearTimer();
      pendingRef.current = null;
      persistPending(pending, true);
      setDelivery(null);
      setPendingContent(null);
      acceptedRef.current(pending, event);
    } else if (event.kind === 'protocol_error' || event.type === 'run-rejected') {
      clearTimer();
      pendingRef.current = null;
      persistPending(pending, true);
      setDelivery({ requestId: pending.requestId, state: 'failed', error: String(event.error || ''), errorCode: String(event.errorCode || event.code || '') });
      setPendingContent(null);
    }
  }, [clearTimer]);

  const checkDelivery = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    try {
      if (connectionRef.current === false) throw new Error('Offline');
      const receipt = await lookupDelivery(pending);
      if (pendingRef.current !== pending || scopeRef.current !== pending.scope) return;
      if (receipt) {
        handleReceipt(receipt);
      } else {
        // An HTTP lookup may beat an in-flight WebSocket frame. Absence is not
        // proof that it is safe to create another request with a different id.
        setDelivery({ requestId: pending.requestId, state: 'unknown' });
      }
    } catch {
      if (pendingRef.current === pending && scopeRef.current === pending.scope) {
        setDelivery({ requestId: pending.requestId, state: 'unknown', errorCode: 'DELIVERY_CHECK_UNAVAILABLE' });
      }
    }
  }, [handleReceipt]);

  useEffect(() => {
    clearTimer();
    const restored = readPending(scope);
    pendingRef.current = restored ? restoreRef.current(restored) : null;
    setPendingContent(restored?.content ?? null);
    setDelivery(pendingRef.current ? { requestId: pendingRef.current.requestId, state: 'unknown' } : null);
    if (pendingRef.current && connectionRef.current !== false) void checkDelivery();
    return () => {
      clearTimer();
      // Late lookups must not send from a conversation that was left or unmounted.
      pendingRef.current = null;
    };
    // Connection changes are handled below without replacing the live snapshot.
  }, [scope, checkDelivery, clearTimer]);

  useEffect(() => subscribe?.((event) => {
    if (event.kind === 'websocket_reconnected') void checkDelivery();
    else handleReceipt(event);
  }), [subscribe, checkDelivery, handleReceipt]);

  useEffect(() => {
    if (isConnected === false && pendingRef.current) {
      clearTimer();
      setDelivery({ requestId: pendingRef.current.requestId, state: 'unknown' });
    }
  }, [isConnected, clearTimer]);

  const transmit = useCallback((pending: PendingChatDelivery, retry = false) => {
    if (!retry && pendingRef.current) return false;
    pendingRef.current = pending;
    setPendingContent(pending.content);
    persistPending(pending);
    setDelivery({ requestId: pending.requestId, state: 'sending' });
    clearTimer();
    let sent = false;
    try {
      sent = connectionRef.current !== false && sendMessage(pending.payload) !== false;
    } catch {
      sent = false;
    }
    if (!sent) {
      if (retry) {
        // A prior attempt is still ambiguous even when this retry is offline.
        setDelivery({ requestId: pending.requestId, state: 'unknown' });
      } else {
        pendingRef.current = null;
        persistPending(pending, true);
        setDelivery({ requestId: pending.requestId, state: 'failed' });
        setPendingContent(null);
      }
      return false;
    }
    // A test transport, or a local transport, can acknowledge synchronously.
    if (pendingRef.current === pending) {
      timerRef.current = setTimeout(() => {
        if (pendingRef.current === pending) setDelivery({ requestId: pending.requestId, state: 'unknown' });
      }, DELIVERY_TIMEOUT_MS);
    }
    return true;
  }, [clearTimer, sendMessage]);

  const retryDelivery = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending || pending.scope !== scopeRef.current || retryingRef.current === pending) return;
    // Re-read after the await; the browser may have disconnected during lookup.
    const isOffline = () => connectionRef.current === false;
    retryingRef.current = pending;
    try {
      if (isOffline()) throw new Error('Offline');
      const receipt = await lookupDelivery(pending);
      if (pendingRef.current !== pending || scopeRef.current !== pending.scope) return;
      if (receipt) handleReceipt(receipt);
      else {
        if (isOffline()) throw new Error('Offline');
        transmit(pending, true);
      }
    } catch {
      if (pendingRef.current === pending && scopeRef.current === pending.scope) {
        setDelivery({ requestId: pending.requestId, state: 'unknown', errorCode: 'DELIVERY_CHECK_UNAVAILABLE' });
      }
    } finally {
      if (retryingRef.current === pending) retryingRef.current = null;
    }
  }, [handleReceipt, transmit]);
  const hasPendingDelivery = useCallback(() => pendingRef.current !== null, []);

  return {
    delivery,
    pendingContent,
    sendDelivery: transmit,
    checkDelivery,
    retryDelivery,
    hasPendingDelivery,
  };
}
