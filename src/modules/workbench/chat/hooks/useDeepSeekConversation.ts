import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { StudioChatSpace, StudioConversation, StudioStatus } from '@/shared/types';

type UseDeepSeekConversationArgs = {
  // The conversation the shell has open, or null for a new chat.
  conversationId: string | null;
  // Where a new conversation is filed: the project's space, or the general DeepSeek app.
  space: StudioChatSpace;
  onCreated: (conversation: StudioConversation, firstMessage: string) => void;
};

const readableError = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message ? failure.message : fallback;

/**
 * Used by WorkbenchDeepSeekChat: a DeepSeek conversation over Studio's REST API (no streaming). Loads the connector
 * status and the open conversation, creates the conversation on the first send, and keeps one request in flight
 * that the owner can stop.
 */
export function useDeepSeekConversation({ conversationId, space, onCreated }: UseDeepSeekConversationArgs) {
  // Connector state from the server: whether a key exists and which models it offers.
  const [status, setStatus] = useState<StudioStatus | null>(null);
  // The conversation on screen with its messages; null until a new chat sends its first message.
  const [conversation, setConversation] = useState<StudioConversation | null>(null);
  // True while an existing conversation's history is loading.
  const [loading, setLoading] = useState(Boolean(conversationId));
  // One request at a time: the reply arrives whole, so this is the 正在思考 state.
  const [sending, setSending] = useState(false);
  // When the pending request started, for the elapsed time beside the thinking state.
  const [sendingSince, setSendingSince] = useState<number | null>(null);
  // Short actionable failure shown above the composer.
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  // Id of the conversation this hook already holds, so the shell echoing a just-created id does not reload it.
  const heldIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.studio.status()
      .then(readApiJson<StudioStatus>)
      .then((result) => { if (!cancelled) setStatus(result); })
      .catch((failure: unknown) => { if (!cancelled) setError(readableError(failure, '读不到 DeepSeek 的连接状态')); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!conversationId || conversationId === heldIdRef.current) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    api.studio.conversation(conversationId)
      .then(readApiJson<StudioConversation>)
      .then((result) => {
        if (cancelled) return;
        heldIdRef.current = result.id;
        setConversation(result);
      })
      .catch((failure: unknown) => { if (!cancelled) setError(readableError(failure, '打不开这个对话')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const send = useCallback(async (text: string, model: string, includeSnr: boolean): Promise<boolean> => {
    if (controllerRef.current || !text.trim()) return false;
    if (!status?.deepseek.configured) {
      setError('DeepSeek 还没有 API 密钥：到 Studio 主屏的「连接」里添加后再试');
      return false;
    }
    const abort = new AbortController();
    controllerRef.current = abort;
    setSending(true);
    setSendingSince(Date.now());
    setError('');
    let id = conversation?.id ?? null;
    try {
      if (!id) {
        const created = await api.studio.createConversation(model, space).then(readApiJson<StudioConversation>);
        id = created.id;
        heldIdRef.current = created.id;
        setConversation({ ...created, messages: created.messages ?? [] });
        onCreated(created, text);
      }
      // Shown at once; the server's copy replaces it when the reply lands.
      setConversation((previous) => previous
        ? { ...previous, messages: [...(previous.messages ?? []), { id: -Date.now(), role: 'user', content: text, status: 'complete' }] }
        : previous);
      const result = await api.studio.send(id, text, includeSnr, abort.signal).then(readApiJson<StudioConversation>);
      setConversation(result);
      return true;
    } catch (failure) {
      setError(abort.signal.aborted ? '已停止回复' : readableError(failure, '发送失败，请再试一次'));
      if (id) {
        const latest = await api.studio.conversation(id).then(readApiJson<StudioConversation>).catch(() => null);
        if (latest) setConversation(latest);
      }
      return false;
    } finally {
      controllerRef.current = null;
      setSending(false);
      setSendingSince(null);
    }
  }, [conversation?.id, onCreated, space, status?.deepseek.configured]);

  const stop = useCallback(() => controllerRef.current?.abort(), []);
  const clearError = useCallback(() => setError(''), []);

  return { status, conversation, loading, sending, sendingSince, error, send, stop, clearError };
}
