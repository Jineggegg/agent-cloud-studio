import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { StudioConversation, WorkbenchSessionItem } from '@/shared/types';
import { toAgentItem, toDeepSeekItem } from '@/modules/workbench/utils/workbenchRoutes';
import { sortSessionsByRecency } from '@/modules/workbench/utils/workbenchSessionGroups';

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

/**
 * Used by the workbench shell: the history of one project — its Claude Code / Codex sessions
 * (GET /api/projects/:projectId/sessions, kept current by `session_upserted` frames) plus the DeepSeek
 * conversations of the matching hub project's space — with rename, archive (undoable) and delete.
 */
export function useWorkbenchSessions(projectId: string | null, hubProjectId: string | null) {
  const { subscribe } = useWebSocket();
  const scope = `${projectId ?? ''}|${hubProjectId ?? ''}`;
  // Agent rows of the project; null while the first page of this project loads.
  const [agentItems, setAgentItems] = useState<WorkbenchSessionItem[] | null>(null);
  // DeepSeek conversations of the hub project's space; empty when the directory has no hub project.
  const [deepseekItems, setDeepseekItems] = useState<WorkbenchSessionItem[]>([]);
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

  const reload = useCallback(async () => {
    const requested = scope;
    if (!projectId) return;
    try {
      const [response] = await Promise.all([api.projectSessions(projectId, { limit: PAGE_SIZE, offset: 0 }), loadDeepSeek()]);
      if (!response.ok) throw new Error(`会话加载失败（${response.status}）`);
      const page = await response.json() as SessionsPage;
      if (currentScope.current !== requested) return;
      const rows = (page.sessions ?? []).map(toAgentItem);
      pagedCount.current = rows.length;
      setAgentItems(rows);
      setHasMore(Boolean(page.sessionMeta?.hasMore));
      setError('');
    } catch (failure) {
      if (currentScope.current !== requested) return;
      setError(failure instanceof Error ? failure.message : '会话加载失败');
      setAgentItems(previous => previous ?? []);
    }
  }, [projectId, scope, loadDeepSeek]);

  useEffect(() => { void reload(); }, [reload]);

  // Live agent rows: new sessions, renames and activity arrive as `session_upserted` frames.
  useEffect(() => subscribe(event => {
    if (event.kind === 'websocket_reconnected') { void reload(); return; }
    if (event.kind !== 'session_upserted' || !projectId) return;
    const frame = event as SessionUpsertFrame;
    if (frame.project?.projectId !== projectId || !frame.sessionId) return;
    const item = toAgentItem({ id: frame.sessionId, provider: frame.provider, summary: frame.session?.summary, lastActivity: frame.session?.lastActivity });
    // A frame naming the canonical id replaces the provider-id row it was merged from.
    setAgentItems(previous => previous === null ? previous : upsertRow(previous, item, frame.providerSessionId));
  }), [subscribe, projectId, reload]);

  // DeepSeek has no live channel: refresh it when the owner comes back to the tab.
  useEffect(() => {
    const onFocus = () => { void loadDeepSeek(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadDeepSeek]);

  const loadMore = useCallback(async () => {
    if (!projectId || loadingMore || !hasMore) return;
    const requested = scope;
    setLoadingMore(true);
    try {
      const response = await api.projectSessions(projectId, { limit: PAGE_SIZE, offset: pagedCount.current });
      if (!response.ok) throw new Error(`更早的会话加载失败（${response.status}）`);
      const page = await response.json() as SessionsPage;
      if (currentScope.current !== requested) return;
      const rows = (page.sessions ?? []).map(toAgentItem);
      pagedCount.current += rows.length;
      setAgentItems(previous => [...(previous ?? []), ...rows.filter(row => !(previous ?? []).some(existing => existing.id === row.id))]);
      setHasMore(Boolean(page.sessionMeta?.hasMore) && rows.length > 0);
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, loadingMore, hasMore, scope]);

  /** Adds a row the chat just created (or restores one) without waiting for the server. */
  const upsert = useCallback((item: WorkbenchSessionItem) => {
    if (item.kind === 'deepseek') {
      setDeepseekItems(previous => upsertRow(previous, item));
      void loadDeepSeek();
    } else {
      setAgentItems(previous => upsertRow(previous ?? [], item));
    }
  }, [loadDeepSeek]);

  const dropRow = useCallback((item: WorkbenchSessionItem) => {
    if (item.kind === 'deepseek') setDeepseekItems(previous => previous.filter(row => row.id !== item.id));
    else setAgentItems(previous => previous?.filter(row => row.id !== item.id) ?? previous);
  }, []);

  const rename = useCallback(async (item: WorkbenchSessionItem, title: string) => {
    if (item.kind !== 'agent') throw new Error('DeepSeek 对话不能重命名');
    await api.renameSession(item.id, title).then(readApiJson);
    setAgentItems(previous => previous?.map(row => row.id === item.id ? { ...row, title } : row) ?? previous);
  }, []);

  // Archived sessions keep their transcript and can come back (restore).
  const archive = useCallback(async (item: WorkbenchSessionItem) => {
    if (item.kind !== 'agent') throw new Error('DeepSeek 对话不能归档');
    await api.deleteSession(item.id, false).then(readApiJson);
    dropRow(item);
  }, [dropRow]);

  const restore = useCallback(async (item: WorkbenchSessionItem) => {
    await api.restoreSession(item.id).then(readApiJson);
    setAgentItems(previous => upsertRow(previous ?? [], item));
  }, []);

  // Deleting removes the row and, for agents, the transcript on disk; there is no undo.
  const remove = useCallback(async (item: WorkbenchSessionItem) => {
    if (item.kind === 'deepseek') await api.studio.removeConversation(item.id).then(readApiJson);
    else await api.deleteSession(item.id, true).then(readApiJson);
    dropRow(item);
  }, [dropRow]);

  const items = useMemo(
    () => agentItems === null ? null : sortSessionsByRecency([...agentItems, ...deepseekItems]),
    [agentItems, deepseekItems],
  );

  return { items, hasMore, loadingMore, error, reload, loadMore, upsert, rename, archive, restore, remove };
}
