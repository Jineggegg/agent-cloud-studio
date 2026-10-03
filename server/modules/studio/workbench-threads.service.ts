import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { StudioWorkbenchHandoff, StudioWorkbenchThread, StudioWorkbenchThreadSegment } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { buildHandoffSummary, formatHandoffContext } from './workbench-handoff-summary.service.js';
import type { HandoffTranscriptEntry } from './workbench-handoff-summary.service.js';

type SegmentKind = StudioWorkbenchThreadSegment['kind'];
type SegmentProvider = StudioWorkbenchThreadSegment['provider'];
// One message of an agent transcript, as the providers module's history reader returns it (only the fields read here).
type AgentTranscriptMessage = {
  kind: string; role?: string; content?: string; toolName?: string; toolInput?: unknown;
  isCompactSummary?: boolean; isLocalCommand?: boolean; isLocalCommandStdout?: boolean;
};
type DeepSeekTranscript = { messages: { role: string; content: string; status?: string }[] };

type WorkbenchThreadsDeps = {
  database: Database.Database;
  // The agent session with this app id: its provider and the IDE project it runs in (null when the project is
  // unknown); null when there is no such session.
  agentSession: (sessionId: string) => { provider: string; projectId: string | null } | null;
  // The whole stored transcript of an agent session (providers module history).
  agentTranscript: (sessionId: string) => Promise<AgentTranscriptMessage[]>;
  // The owner's Studio DeepSeek conversation; throws a 404 AppError for a missing one or anyone else's.
  deepseekConversation: (userId: number, conversationId: string) => DeepSeekTranscript;
  now?: () => number;
};

// The stretch a handoff starts from or a link names.
type WorkbenchSegmentRef = { kind: SegmentKind; id: string };

type ThreadRow = { id: string; user_id: number; project_id: string; title: string; created_at: string; updated_at: string };
type SegmentRow = { thread_id: string; position: number; kind: SegmentKind; provider: SegmentProvider; session_id: string; model_label: string | null; handoff_at: string | null };

const PROVIDER_LABELS: Record<SegmentProvider, string> = { claude: 'Claude Code', codex: 'Codex', deepseek: 'DeepSeek' };
const MAX_TITLE = 80;
const MAX_MODEL_LABEL = 60;

function fail(message: string, statusCode: number, code: string): never {
  throw new AppError(message, { statusCode, code });
}

function agentEntries(messages: AgentTranscriptMessage[]): HandoffTranscriptEntry[] {
  const entries: HandoffTranscriptEntry[] = [];
  for (const message of messages) {
    if (message.kind === 'tool_use' && message.toolName) {
      entries.push({ type: 'tool', name: message.toolName, input: message.toolInput });
      continue;
    }
    if (message.kind !== 'text' || typeof message.content !== 'string' || message.isLocalCommand || message.isLocalCommandStdout) continue;
    if (message.isCompactSummary) entries.push({ type: 'summary', text: message.content });
    else if (message.role === 'user') entries.push({ type: 'user', text: message.content });
    else if (message.role === 'assistant') entries.push({ type: 'assistant', text: message.content });
  }
  return entries;
}

function deepseekEntries(conversation: DeepSeekTranscript): HandoffTranscriptEntry[] {
  return conversation.messages
    .filter(message => (message.status ?? 'complete') === 'complete')
    .map(message => ({ type: message.role === 'user' ? 'user' : 'assistant', text: message.content }) as HandoffTranscriptEntry);
}

/**
 * Used by studio.module behind /api/studio/workbench: workbench conversations that move between providers. A handoff
 * summarises the outgoing session from its stored transcript; once the next provider's session exists, `link` records
 * it as the thread's next stretch, so the history lists the chain as one conversation and the chat shows it whole.
 * Agent sessions must belong to the IDE project named; DeepSeek conversations to the owner.
 */
export function createWorkbenchThreadsService(deps: WorkbenchThreadsDeps) {
  const db = deps.database;
  const now = deps.now ?? Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_workbench_threads (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_workbench_threads_project ON studio_workbench_threads (user_id, project_id);
    CREATE TABLE IF NOT EXISTS studio_workbench_thread_segments (
      thread_id TEXT NOT NULL, position INTEGER NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL,
      session_id TEXT NOT NULL, model_label TEXT, handoff_at TEXT,
      PRIMARY KEY (thread_id, position)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS studio_workbench_thread_segments_session ON studio_workbench_thread_segments (kind, session_id);
  `);

  function toThread(row: ThreadRow): StudioWorkbenchThread {
    const segments = db.prepare('SELECT * FROM studio_workbench_thread_segments WHERE thread_id = ? ORDER BY position').all(row.id) as SegmentRow[];
    return {
      id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
      segments: segments.map(segment => ({
        kind: segment.kind, provider: segment.provider, sessionId: segment.session_id, modelLabel: segment.model_label, handoffAt: segment.handoff_at,
      })),
    };
  }

  function ownedThread(userId: number, threadId: string): ThreadRow {
    const row = db.prepare('SELECT * FROM studio_workbench_threads WHERE id = ? AND user_id = ?').get(threadId, userId) as ThreadRow | undefined;
    if (!row) fail('找不到这段对话', 404, 'WORKBENCH_THREAD_NOT_FOUND');
    return row;
  }

  // The owner's thread holding this stretch, and whether the stretch is its latest one.
  function threadOf(userId: number, ref: WorkbenchSegmentRef): { row: ThreadRow; latest: boolean } | null {
    const segment = db.prepare('SELECT thread_id, position FROM studio_workbench_thread_segments WHERE kind = ? AND session_id = ?')
      .get(ref.kind, ref.id) as { thread_id: string; position: number } | undefined;
    if (!segment) return null;
    const row = db.prepare('SELECT * FROM studio_workbench_threads WHERE id = ? AND user_id = ?').get(segment.thread_id, userId) as ThreadRow | undefined;
    if (!row) fail('找不到这段对话', 404, 'WORKBENCH_THREAD_NOT_FOUND');
    const last = db.prepare('SELECT MAX(position) AS position FROM studio_workbench_thread_segments WHERE thread_id = ?').get(row.id) as { position: number };
    return { row, latest: last.position === segment.position };
  }

  // Checks that a stretch exists where the owner says it does; resolves an agent session's provider.
  function verify(userId: number, projectId: string, ref: WorkbenchSegmentRef): SegmentProvider {
    if (ref.kind === 'deepseek') {
      deps.deepseekConversation(userId, ref.id);
      return 'deepseek';
    }
    const session = deps.agentSession(ref.id);
    if (!session || session.projectId !== projectId) fail('这个会话不在这个项目里', 404, 'WORKBENCH_SESSION_NOT_FOUND');
    if (session.provider !== 'claude' && session.provider !== 'codex') fail('只能交接 Claude Code、Codex 或 DeepSeek 的对话', 400, 'WORKBENCH_HANDOFF_PROVIDER');
    return session.provider;
  }

  return {
    // The owner's threads in one IDE project, newest first.
    list(userId: number, projectId: string): StudioWorkbenchThread[] {
      const rows = db.prepare('SELECT * FROM studio_workbench_threads WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC').all(userId, projectId) as ThreadRow[];
      return rows.map(toThread);
    },

    // Summarises the outgoing stretch for `toProvider`. Only the latest stretch of a thread can be handed on, and a
    // switch within the same provider needs no handoff (the chat changes the model in place).
    async handoff(userId: number, input: { projectId: string; from: WorkbenchSegmentRef; toProvider: SegmentProvider; fromModelLabel: string | null }): Promise<StudioWorkbenchHandoff> {
      const fromProvider = verify(userId, input.projectId, input.from);
      if (fromProvider === input.toProvider) fail('同一服务换模型不需要交接', 400, 'WORKBENCH_HANDOFF_SAME_PROVIDER');
      const thread = threadOf(userId, input.from);
      if (thread && !thread.latest) fail('这段对话已经交给其他模型了，请打开最新的会话', 409, 'WORKBENCH_HANDOFF_NOT_LATEST');
      const entries = input.from.kind === 'deepseek'
        ? deepseekEntries(deps.deepseekConversation(userId, input.from.id))
        : agentEntries(await deps.agentTranscript(input.from.id));
      const summary = buildHandoffSummary({ sourceLabel: PROVIDER_LABELS[fromProvider], entries });
      const context = formatHandoffContext({
        fromLabel: PROVIDER_LABELS[fromProvider], fromModelLabel: input.fromModelLabel, toLabel: PROVIDER_LABELS[input.toProvider],
        toDeepSeek: input.toProvider === 'deepseek', summary,
      });
      return { summary, context };
    },

    // Records `to` (the session the handoff started) as the next stretch after `from`, creating the thread with
    // `from` as its first stretch when this is the conversation's first handoff.
    link(userId: number, input: {
      projectId: string; title: string;
      from: WorkbenchSegmentRef & { modelLabel: string | null };
      to: WorkbenchSegmentRef & { modelLabel: string | null };
    }): StudioWorkbenchThread {
      const fromProvider = verify(userId, input.projectId, input.from);
      const toProvider = verify(userId, input.projectId, input.to);
      if (fromProvider === toProvider) fail('同一服务换模型不需要交接', 400, 'WORKBENCH_HANDOFF_SAME_PROVIDER');
      if (threadOf(userId, input.to)) fail('这个会话已经在另一段对话里了', 409, 'WORKBENCH_HANDOFF_LINKED');
      const at = new Date(now()).toISOString();
      const modelLabel = (label: string | null) => (label?.trim() ? label.trim().slice(0, MAX_MODEL_LABEL) : null);
      return db.transaction(() => {
        const existing = threadOf(userId, input.from);
        if (existing && !existing.latest) fail('这段对话已经交给其他模型了，请打开最新的会话', 409, 'WORKBENCH_HANDOFF_NOT_LATEST');
        if (existing && existing.row.project_id !== input.projectId) fail('这段对话不在这个项目里', 404, 'WORKBENCH_THREAD_NOT_FOUND');
        let threadId = existing?.row.id;
        if (!threadId) {
          threadId = randomUUID();
          db.prepare('INSERT INTO studio_workbench_threads (id, user_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(threadId, userId, input.projectId, input.title.trim().slice(0, MAX_TITLE) || '新会话', at, at);
          db.prepare('INSERT INTO studio_workbench_thread_segments (thread_id, position, kind, provider, session_id, model_label, handoff_at) VALUES (?, 0, ?, ?, ?, ?, NULL)')
            .run(threadId, input.from.kind, fromProvider, input.from.id, modelLabel(input.from.modelLabel));
        }
        const next = db.prepare('SELECT MAX(position) + 1 AS position FROM studio_workbench_thread_segments WHERE thread_id = ?').get(threadId) as { position: number };
        db.prepare('INSERT INTO studio_workbench_thread_segments (thread_id, position, kind, provider, session_id, model_label, handoff_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(threadId, next.position, input.to.kind, toProvider, input.to.id, modelLabel(input.to.modelLabel), at);
        db.prepare('UPDATE studio_workbench_threads SET updated_at = ? WHERE id = ?').run(at, threadId);
        return toThread(ownedThread(userId, threadId));
      })();
    },

    // Renames the conversation as the history lists it.
    rename(userId: number, threadId: string, title: string): StudioWorkbenchThread {
      const row = ownedThread(userId, threadId);
      const clean = title.trim().slice(0, MAX_TITLE);
      if (!clean) fail('名称不能为空', 400, 'WORKBENCH_THREAD_TITLE');
      db.prepare('UPDATE studio_workbench_threads SET title = ? WHERE id = ?').run(clean, row.id);
      return toThread(ownedThread(userId, threadId));
    },

    // Forgets the chain (its sessions are deleted or archived by their own APIs); the stretches become plain sessions.
    remove(userId: number, threadId: string) {
      const row = ownedThread(userId, threadId);
      db.transaction(() => {
        db.prepare('DELETE FROM studio_workbench_thread_segments WHERE thread_id = ?').run(row.id);
        db.prepare('DELETE FROM studio_workbench_threads WHERE id = ?').run(row.id);
      })();
    },
  };
}
