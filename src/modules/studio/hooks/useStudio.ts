import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { StudioChatSpace, StudioConversation, StudioSnr, StudioStatus } from '@/shared/types';

/**
 * Used by StudioPage to keep authenticated connector and conversation state synchronized with the server.
 * `space` is the chat app currently open on the home screen; its history is loaded on its own.
 */
export function useStudio(space: StudioChatSpace) {
  // Connector configuration comes only from the authenticated backend.
  const [status, setStatus] = useState<StudioStatus | null>(null);
  // SNR health is refreshed explicitly, without a background mutation.
  const [snr, setSnr] = useState<StudioSnr | null>(null);
  // History of the open chat app, shared across devices through Studio's database.
  const [history, setHistory] = useState<StudioConversation[]>([]);
  // The selected conversation owns the visible transcript.
  const [active, setActive] = useState<StudioConversation | null>(null);
  // Initial loading prevents an offline connector from looking connected.
  const [loading, setLoading] = useState(true);
  // One request flag locks conversation switching while a model reply is pending.
  const [sending, setSending] = useState(false);
  // Transport and configuration failures remain actionable in the current view.
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const selectionVersion = useRef(0);
  const currentSpace = useRef(space);
  // The chat app whose history state currently belongs on screen.
  const [shownSpace, setShownSpace] = useState(space);
  if (shownSpace !== space) {
    // Switching apps clears the transcript during render so one app's conversation never flashes inside another.
    setShownSpace(space);
    setActive(null);
    setHistory([]);
  }

  const loadHistory = useCallback(async (target: StudioChatSpace) => {
    const conversations = await api.studio.conversations(target).then(readApiJson<StudioConversation[]>);
    // A slow response for an app the user already left must not replace the newer list.
    if (currentSpace.current === target) setHistory(conversations);
  }, []);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [config, snapshot] = await Promise.all([
        api.studio.status().then(readApiJson<StudioStatus>),
        api.studio.snr().then(readApiJson<StudioSnr>),
        loadHistory(currentSpace.current),
      ]);
      setStatus(config);
      setSnr(snapshot);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '工作台无法连接'); }
    finally { setLoading(false); }
  }, [loadHistory]);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void refresh(); });
    return () => { mounted = false; controller.current?.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (currentSpace.current === space) return;
    // Late replies and selections from the previous app are ignored from here on.
    currentSpace.current = space;
    selectionVersion.current += 1;
    loadHistory(space).catch(failure => setError(failure instanceof Error ? failure.message : '无法读取对话'));
  }, [space, loadHistory]);

  const select = async (id: string) => {
    if (controller.current) return;
    const version = ++selectionVersion.current;
    setError('');
    try {
      const result = await api.studio.conversation(id).then(readApiJson<StudioConversation>);
      if (version === selectionVersion.current) setActive(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开对话'); }
  };
  const startNew = () => {
    if (controller.current) return;
    selectionVersion.current += 1;
    setActive(null);
    setError('');
  };
  const send = async (text: string, model: string, includeSnr: boolean) => {
    if (controller.current || !text.trim()) return false;
    if (!status?.deepseek.configured) { setError('请先在连接中设置 DeepSeek API 密钥'); return false; }
    const abort = new AbortController();
    const target = space;
    controller.current = abort;
    selectionVersion.current += 1;
    setSending(true);
    setError('');
    let id = active?.id;
    try {
      if (!id) {
        const created = await api.studio.createConversation(model, target).then(readApiJson<StudioConversation>);
        id = created.id;
        setActive(created);
      }
      setActive(previous => previous ? { ...previous, messages: [...(previous.messages ?? []), { id: -1, role: 'user', content: text, status: 'complete' }] } : previous);
      const result = await api.studio.send(id, text, includeSnr, abort.signal).then(readApiJson<StudioConversation>);
      // The reply only lands if the user is still inside the app that asked for it.
      if (currentSpace.current === target) setActive(result);
      return true;
    } catch (failure) {
      setError(abort.signal.aborted ? '已停止回复' : failure instanceof Error ? failure.message : '发送失败');
      if (id) {
        const result = await api.studio.conversation(id).then(readApiJson<StudioConversation>).catch(() => null);
        if (result && currentSpace.current === target) setActive(result);
      }
      return false;
    } finally {
      controller.current = null;
      setSending(false);
      await loadHistory(target).catch(() => {});
    }
  };
  const remove = async (id: string) => {
    if (controller.current) return;
    try {
      await api.studio.removeConversation(id).then(readApiJson);
      if (active?.id === id) startNew();
      await loadHistory(space);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '删除失败'); }
  };
  return { status, snr, history, active, loading, sending, error, refresh, select, startNew, send, remove, stop: () => controller.current?.abort() };
}
