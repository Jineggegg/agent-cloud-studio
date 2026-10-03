import { api, readApiJson } from '@/shared/api';
import type { StudioConversation, WorkbenchNewChatChoice, WorkbenchNewProvider, WorkbenchSessionItem } from '@/shared/types';

// Routing, row mapping and new-chat rules shared by the workbench route, shell, history, chat column and redirects.

// Every agent a workbench chat can start with; Cursor and OpenCode arrive from the Studio project app's cards.
const NEW_PROVIDERS: readonly string[] = ['claude', 'codex', 'cursor', 'opencode', 'deepseek'];
const AGENT_PROVIDERS: readonly string[] = ['claude', 'codex', 'cursor', 'opencode'];
// Offered in every project's menus; Cursor and OpenCode join only where the project enables them (or already runs one).
const MENU_PROVIDERS: readonly WorkbenchNewProvider[] = ['claude', 'codex', 'deepseek'];
const OPTIONAL_PROVIDERS: readonly WorkbenchNewProvider[] = ['cursor', 'opencode'];
// Why DeepSeek is unavailable: it files its conversations in the Studio project's space.
const DEEPSEEK_NEEDS_HUB = '需先在 Studio 中建立此项目';
// Shown until an agent session has a name of its own (the first prompt usually becomes it).
const UNTITLED_SESSION = '新会话';

// Name, mineral tone and mark of each provider, matching the Studio project app's agent cards.
const PROVIDER_META: Record<WorkbenchSessionItem['provider'], { name: string; tone: string; mark: string }> = {
  claude: { name: 'Claude Code', tone: 'clay', mark: 'C' },
  codex: { name: 'Codex', tone: 'graphite', mark: 'O' },
  cursor: { name: 'Cursor', tone: 'slate', mark: 'Cu' },
  opencode: { name: 'OpenCode', tone: 'stone', mark: 'Oc' },
  // DeepSeek draws an icon instead of a letter (WorkbenchProviderMark).
  deepseek: { name: 'DeepSeek', tone: 'slate', mark: '' },
};

/** Display name, icon tone and letter mark of a provider; an unknown id reads as Claude Code. */
export function providerMeta(provider: string) {
  return PROVIDER_META[provider as WorkbenchSessionItem['provider']] ?? PROVIDER_META.claude;
}

/** Reads a `?new=` value; anything but Claude Code, Codex, Cursor, OpenCode or DeepSeek is ignored. */
export function parseNewProvider(value: string | null | undefined): WorkbenchNewProvider | null {
  return value && NEW_PROVIDERS.includes(value) ? value as WorkbenchNewProvider : null;
}

/**
 * The agents a new chat in this project can start with, in menu order: Claude Code, Codex and DeepSeek, then Cursor
 * and OpenCode when `extra` names them (the hub project enables them, or the chat already runs one). DeepSeek is
 * listed but unavailable without a hub project. The sidebar's new-session menu and the chat header both use this,
 * so they never disagree.
 */
export function newChatChoices(hubProjectId: string | null, extra: readonly string[] = []): WorkbenchNewChatChoice[] {
  const providers = [...MENU_PROVIDERS, ...OPTIONAL_PROVIDERS.filter(provider => extra.includes(provider))];
  return providers.map(provider => ({ provider, unavailableReason: provider === 'deepseek' && !hubProjectId ? DEEPSEEK_NEEDS_HUB : null }));
}

/** The agent a new chat really starts with: DeepSeek needs a hub project, so without one it falls back to Claude Code. */
export function resolveNewChatProvider(requested: WorkbenchNewProvider, hubProjectId: string | null): WorkbenchNewProvider {
  return requested === 'deepseek' && !hubProjectId ? 'claude' : requested;
}

/** The URL of a project's new chat (optionally with a provider preselected), an agent session or a DeepSeek conversation. */
export function workbenchPath(
  projectId: string,
  target?: Pick<WorkbenchSessionItem, 'kind' | 'id'> | null,
  provider?: WorkbenchNewProvider | null,
): string {
  const base = `/work/${encodeURIComponent(projectId)}`;
  if (target) return `${base}/${target.kind === 'deepseek' ? 'd' : 's'}/${encodeURIComponent(target.id)}`;
  return provider ? `${base}?new=${provider}` : base;
}

/** One row of GET /api/projects/:projectId/sessions (or a `session_upserted` frame) as a workbench row. */
export function toAgentItem(row: { id: string; provider?: string; summary?: string; lastActivity?: string | null }): WorkbenchSessionItem {
  return {
    id: row.id,
    kind: 'agent',
    provider: row.provider && AGENT_PROVIDERS.includes(row.provider) ? row.provider as WorkbenchSessionItem['provider'] : 'claude',
    title: row.summary?.trim() || UNTITLED_SESSION,
    updatedAt: row.lastActivity ?? null,
  };
}

/** A Studio DeepSeek conversation of the project's space as a workbench row. */
export function toDeepSeekItem(conversation: StudioConversation): WorkbenchSessionItem {
  return { id: conversation.id, kind: 'deepseek', provider: 'deepseek', title: conversation.title || '新对话', updatedAt: conversation.updated_at ?? null };
}

type SessionDetailsEnvelope = {
  data?: {
    sessionId?: string; provider?: string; summary?: string; lastActivity?: string | null;
    project?: { projectId?: string } | null;
  };
};

/**
 * Resolves an agent session id (the app id, or a provider-native id from an old link) to its canonical row and
 * owning IDE project through GET /api/providers/sessions/:id. Null when the server does not know the session.
 */
export async function fetchAgentSession(sessionId: string): Promise<{ projectId: string | null; item: WorkbenchSessionItem } | null> {
  try {
    const envelope = await api.sessionDetails(sessionId).then(readApiJson<SessionDetailsEnvelope>);
    const details = envelope.data;
    if (!details?.sessionId) return null;
    return {
      projectId: details.project?.projectId ?? null,
      item: toAgentItem({ id: details.sessionId, provider: details.provider, summary: details.summary, lastActivity: details.lastActivity }),
    };
  } catch {
    return null;
  }
}

/** Loads one DeepSeek conversation as a row; null when it was deleted or belongs to someone else. */
export async function fetchDeepSeekConversation(conversationId: string): Promise<WorkbenchSessionItem | null> {
  try {
    return toDeepSeekItem(await api.studio.conversation(conversationId).then(readApiJson<StudioConversation>));
  } catch {
    return null;
  }
}

/** Where an old `/session/:id` link (bookmark, notification) lives now; null when the session is gone. */
export async function resolveLegacySessionPath(sessionId: string): Promise<string | null> {
  const resolved = await fetchAgentSession(sessionId);
  if (!resolved?.projectId) return null;
  return workbenchPath(resolved.projectId, resolved.item);
}
