import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { StudioConversation, WorkbenchSessionItem, WorkbenchThread } from '@/shared/types';
import { isListedAgentSession, toAgentItem, toDeepSeekItem } from '@/modules/workbench/utils/workbenchRoutes';
import { collapseThreads, sortSessionsByRecency } from '@/modules/workbench/utils/workbenchSessionGroups';

// Enough history for a working week in one request; older pages load on demand.
const PAGE_SIZE = 50;

type SessionsPage = {
  sessions?: { id: string; provider?: string; summary?: string; lastActivity?: string | null }[];
  sessionMeta?: { hasMore?: boolean };
};

// The `session_upserted` frame (server/modules/websocket/services/session-upsert-broadcast.service.ts).
type SessionUpsertFrame = {
  sessionId?: string;
  providerSessionId?: string | null;
  provider?: string;
  session?: { id?: string; summary?: string; lastActivity?: string };
  project?: { projectId?: string } | null;
};

// Inserts or replaces a row; a new frame without a name keeps the name the row already had.
function upsertRow(rows: WorkbenchSessionItem[], item: WorkbenchSessionItem, replacedId?: string | null): WorkbenchSessionItem[] {
  const previous = rows.find(row => row.id === item.id);
  const merged = previous && item.title === '新会话' && previous.title !== '新会话' ? { ...item, title: previous.title } : item;
  return [merged, ...rows.filter(row => row.id !== item.id && row.id !== replacedId)];
}

// The sessions of a history row: every stretch of a handed-over conversation, or the row itself.
function sessionsOf(item: WorkbenchSessionItem): Pick<WorkbenchSessionItem, 'kind' | 'id'>[] {
  return item.thread ? item.thread.segments.map(segment => ({ kind: segment.kind, id: segment.sessionId })) : [item];
}

/**
 * Used by the workbench shell: the history of one project — its Claude Code / Codex sessions
 * (GET /api/projects/:projectId/sessions, kept current by `session_upserted` frames) plus the DeepSeek
 * conversations of the matching hub project's space, with each conversation handed between providers
 * (GET /api/studio/workbench/threads) folded into one row — and rename, archive (undoable) and delete, which act on
 * every session of such a conversation.
 */
export function useWorkbenchSessions(projectId: string | null, hubProjectId: string | null) {
  const { subscribe } = useWebSocket();
  const scope = `${projectId ?? ''}|${hubProjectId ?? ''}`;
  // Agent rows of the project; null while the first page of this project loads.
  const [agentItems, setAgentItems] = useState<WorkbenchSessionItem[] | null>(null);
  // DeepSeek conversations of the hub project's space; empty when the directory has no hub project.
  const [deepseekItems, setDeepseekItems] = useState<WorkbenchSessionItem[]>([]);
  // Conversations of this project handed between providers; their sessions show as one row each.
  const [threads, setThreads] = useState<WorkbenchThread[]>([]);
  // Whether the server holds older agent sessions than the pages loaded so far.
  const [hasMore, setHasMore] = useState(false);
  // An older page is in flight, so repeated taps do not request it twice.
  const [loadingMore, setLoadingMore] = useState(false);
  // The history could not be loaded; shown with a retry rather than as an empty project.
  const [error, setError] = useState('');
  // The project whose history the state above describes; switching projects clears it during render.
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setAgentItems(null);
    setDeepseekItems([]);
    setThreads([]);
    setHasMore(false);
    setError('');
  }
  // The scope responses must still match when they land; a reply for a project the owner left is dropped.
  const currentScope = useRef(scope);
  useEffect(() => { currentScope.current = scope; }, [scope]);
  // Rows taken from server pages so far: the next page's offset (websocket inserts do not count).
  const pagedCount = useRef(0);

  const loadDeepSeek = useCallback(async () => {
    const requested = scope;
    if (!hubProjectId) return;
    const conversations = await api.studio.conversations(`project:${hubProjectId}`).then(readApiJson<StudioConversation[]>).catch(() => null);
    if (conversations && currentScope.current === requested) setDeepseekItems(conversations.map(toDeepSeekItem));
  }, [hubProjectId, scope]);

  // A failed read keeps the chains already known: their sessions then show as separate rows only until the next read.
  const loadThreads = useCallback(async () => {
    const requested = scope;
    if (!projectId) return;
    try {
      const loaded = await api.studio.workbench.threads(projectId).then(readApiJson<WorkbenchThread[]>);
      if (Array.isArray(loaded) && currentScope.current === requested) setThreads(loaded);
    } catch {
      // The plain history still loads; the chains come back with the next read.
    }
  }, [projectId, scope]);

  const reload = useCallback(async () => {
    const requested = scope;
    if (!projectId) return;
    try {
      const [response] = await Promise.all([api.projectSessions(projectId, { limit: PAGE_SIZE, offset: 0 }), loadDeepSeek(), loadThreads()]);
      if (!response.ok) throw new Error(`会话加载失败（${response.status}）`);
      const page = await response.json() as SessionsPage;
      if (currentScope.current !== requested) return;
      const pageRows = page.sessions ?? [];
      // The offset counts every server row, hidden Cursor / OpenCode ones included, so pages never overlap.
      pagedCount.current = pageRows.length;
      const rows = pageRows.filter(isListedAgentSession).map(toAgentItem);
      setAgentItems(rows);
      setHasMore(Boolean(page.sessionMeta?.hasMore));
      setError('');
    } catch (failure) {
      if (currentScope.current !== requested) return;
      setError(failure instanceof Error ? failure.message : '会话加载失败');
      setAgentItems(previous => previous ?? []);
    }
  }, [projectId, scope, loadDeepSeek, loadThreads]);

  useEffect(() => { void reload(); }, [reload]);

  // Live agent rows: new sessions, renames and activity arrive as `session_upserted` frames.
  useEffect(() => subscribe(event => {
    if (event.kind === 'websocket_reconnected') { void reload(); return; }
    if (event.kind !== 'session_upserted' || !projectId) return;
    const frame = event as SessionUpsertFrame;
    if (frame.project?.projectId !== projectId || !frame.sessionId || !isListedAgentSession(frame)) return;
    const item = toAgentItem({ id: frame.sessionId, provider: frame.provider, summary: frame.session?.summary, lastActivity: frame.session?.lastActivity });
    // A frame naming the canonical id replaces the provider-id row it was merged from.
    setAgentItems(previous => previous === null ? previous : upsertRow(previous, item, frame.providerSessionId));
  }), [subscribe, projectId, reload]);

  // DeepSeek and the chains have no live channel: refresh them when the owner comes back to the tab.
  useEffect(() => {
    const onFocus = () => { void loadDeepSeek(); void loadThreads(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadDeepSeek, loadThreads]);

  const loadMore = useCallback(async () => {
    if (!projectId || loadingMore || !hasMore) return;
    const requested = scope;
    setLoadingMore(true);
    try {
      const response = await api.projectSessions(projectId, { limit: PAGE_SIZE, offset: pagedCount.current });
      if (!response.ok) throw new Error(`更早的会话加载失败（${response.status}）`);
      const page = await response.json() as SessionsPage;
      if (currentScope.current !== requested) return;
      const pageRows = page.sessions ?? [];
      pagedCount.current += pageRows.length;
      const rows = pageRows.filter(isListedAgentSession).map(toAgentItem);
      setAgentItems(previous => [...(previous ?? []), ...rows.filter(row => !(previous ?? []).some(existing => existing.id === row.id))]);
      setHasMore(Boolean(page.sessionMeta?.hasMore) && pageRows.length > 0);
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, loadingMore, hasMore, scope]);

  /** Adds a row the chat just created (or restores one) without waiting for the server. */
  const upsert = useCallback((item: WorkbenchSessionItem) => {
    // The plain session row: a chain is folded in from `threads`, never stored on a row.
    const row: WorkbenchSessionItem = { ...item };
    delete row.thread;
    if (row.kind === 'deepseek') {
      setDeepseekItems(previous => upsertRow(previous, row));
      void loadDeepSeek();
    } else {
      setAgentItems(previous => upsertRow(previous ?? [], row));
    }
  }, [loadDeepSeek]);

  /** Records a conversation as it stands after a handoff (the chat column reports it), so its sessions fold at once. */
  const upsertThread = useCallback((thread: WorkbenchThread) => {
    setThreads(previous => [thread, ...previous.filter(existing => existing.id !== thread.id)]);
  }, []);

  const dropRows = useCallback((targets: Pick<WorkbenchSessionItem, 'kind' | 'id'>[]) => {
    const dropped = (row: WorkbenchSessionItem) => targets.some(target => target.kind === row.kind && target.id === row.id);
    setDeepseekItems(previous => previous.filter(row => !dropped(row)));
    setAgentItems(previous => previous?.filter(row => !dropped(row)) ?? previous);
  }, []);

  // A handed-over conversation is renamed as a whole (its sessions keep their own names).
  const rename = useCallback(async (item: WorkbenchSessionItem, title: string) => {
    if (item.thread) {
      const renamed = await api.studio.workbench.renameThread(item.thread.id, title).then(readApiJson<WorkbenchThread>);
      upsertThread(renamed);
      return;
    }
    if (item.kind !== 'agent') throw new Error('DeepSeek 对话不能重命名');
    await api.renameSession(item.id, title).then(readApiJson);
    setAgentItems(previous => previous?.map(row => row.id === item.id ? { ...row, title } : row) ?? previous);
  }, [upsertThread]);

  // Archived sessions keep their transcript and can come back (restore); a conversation archives all its sessions.
  const archive = useCallback(async (item: WorkbenchSessionItem) => {
    const targets = sessionsOf(item);
    if (targets.some(target => target.kind !== 'agent')) throw new Error('DeepSeek 对话不能归档');
    for (const target of targets) await api.deleteSession(target.id, false).then(readApiJson);
    dropRows(targets);
  }, [dropRows]);

  const restore = useCallback(async (item: WorkbenchSessionItem) => {
    for (const target of sessionsOf(item)) await api.restoreSession(target.id).then(readApiJson);
    if (item.thread) { void reload(); return; }
    setAgentItems(previous => upsertRow(previous ?? [], item));
  }, [reload]);

  // Deleting removes the row and, for agents, the transcript on disk; there is no undo. A handed-over conversation
  // deletes every session it went through, then forgets the chain.
  const remove = useCallback(async (item: WorkbenchSessionItem) => {
    const targets = sessionsOf(item);
    for (const target of targets) {
      if (target.kind === 'deepseek') await api.studio.removeConversation(target.id).then(readApiJson);
      else await api.deleteSession(target.id, true).then(readApiJson);
    }
    dropRows(targets);
    if (item.thread) {
      const threadId = item.thread.id;
      await api.studio.workbench.removeThread(threadId).then(readApiJson).catch(() => undefined);
      setThreads(previous => previous.filter(thread => thread.id !== threadId));
    }
  }, [dropRows]);

  const items = useMemo(
    () => agentItems === null ? null : collapseThreads(sortSessionsByRecency([...agentItems, ...deepseekItems]), threads),
    [agentItems, deepseekItems, threads],
  );

  return { items, threads, hasMore, loadingMore, error, reload, loadMore, upsert, upsertThread, rename, archive, restore, remove };
}
