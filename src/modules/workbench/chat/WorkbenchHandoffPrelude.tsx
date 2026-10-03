import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, X } from 'lucide-react';

import { Markdown } from '@/modules/chat';
import { api, readApiJson } from '@/shared/api';
import type { ChatMessage, Project, StudioConversation, WorkbenchNewProvider, WorkbenchThreadSegment } from '@/shared/types';
import { WorkbenchAssistantMessage, WorkbenchUserMessage } from '@/modules/workbench/chat/WorkbenchMessageRow';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import { workbenchPath } from '@/modules/workbench/utils/workbenchRoutes';

// The newest messages of an earlier stretch shown inline; the whole stretch opens as its own session.
const STRETCH_MESSAGE_LIMIT = 120;

const timeFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// One message of GET /api/providers/sessions/:id/messages (the fields read here).
type HistoryMessage = { id?: string; kind?: string; role?: string; content?: string; timestamp?: string; model?: string };
type HistoryEnvelope = { data?: { messages?: HistoryMessage[]; hasMore?: boolean } };
// An earlier stretch as shown: the owner's messages and the assistant's prose, in order.
type StretchView = { status: 'loading' } | { status: 'error' } | { status: 'ready'; messages: ChatMessage[]; hasMore: boolean };

/** The divider's label for the stretch that took over: `Codex · GPT-6.1 Sol`. */
function stretchName(provider: string, modelLabel: string | null): string {
  return modelLabel ? `${providerLabel(provider)} · ${modelLabel}` : providerLabel(provider);
}

function formatTime(value: string | null): string {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? timeFormatter.format(time) : '';
}

// An earlier stretch's session, as named in the prelude's key (`agent:<id>|deepseek:<id>`).
type StretchRef = Pick<WorkbenchThreadSegment, 'kind' | 'sessionId'>;

function parseStretchKey(key: string): StretchRef[] {
  return key.split('|').filter(Boolean).map((part) => {
    const separator = part.indexOf(':');
    return { kind: part.slice(0, separator) === 'deepseek' ? 'deepseek' : 'agent', sessionId: part.slice(separator + 1) };
  });
}

async function loadStretch(segment: StretchRef): Promise<StretchView> {
  if (segment.kind === 'deepseek') {
    const conversation = await api.studio.conversation(segment.sessionId).then(readApiJson<StudioConversation>);
    const messages = (conversation.messages ?? []).filter((message) => message.status !== 'error').map((message): ChatMessage => ({
      type: message.role === 'user' ? 'user' : 'assistant', content: message.content, timestamp: '', id: `ds-${message.id}`, model: conversation.model,
    }));
    return { status: 'ready', messages, hasMore: false };
  }
  const envelope = await api.providers.sessionMessages(segment.sessionId, { limit: STRETCH_MESSAGE_LIMIT, offset: 0 }).then(readApiJson<HistoryEnvelope>);
  const messages = (envelope.data?.messages ?? [])
    .filter((message) => message.kind === 'text' && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string' && message.content.trim())
    .map((message, index): ChatMessage => ({
      type: message.role === 'user' ? 'user' : 'assistant',
      content: message.content ?? '',
      timestamp: message.timestamp ?? '',
      id: message.id ?? `${segment.sessionId}-${index}`,
      model: message.model,
    }));
  return { status: 'ready', messages, hasMore: Boolean(envelope.data?.hasMore) };
}

type PendingHandoffView = {
  // The summary is being built, is ready (shown folded), or failed (with a retry).
  status: 'loading' | 'ready' | 'error';
  summary: string | null;
  error: string | null;
  onRetry: () => void;
  onCancel: () => void;
};

type WorkbenchHandoffPreludeProps = {
  project: Project;
  // The stretches before the one on screen, oldest first.
  segments: WorkbenchThreadSegment[];
  // The stretch on screen below the last divider: who took over (or will), with which model, and when.
  next: { provider: WorkbenchNewProvider; modelLabel: string | null; handoffAt: string | null };
  // Set while the handoff is confirmed but the next session does not exist yet.
  pending?: PendingHandoffView | null;
};

/**
 * Used by WorkbenchChat above the open chat's own transcript when the conversation was (or is being) handed between
 * providers: each earlier stretch's messages, read-only (the owner's words and the answers; tools stay in the
 * original session, one tap away), and a divider at every handoff — 已交接给 Codex · GPT-6.1 Sol — or, before the
 * next session exists, 将交给 … with the summary and a way back.
 */
export function WorkbenchHandoffPrelude({ project, segments, next, pending }: WorkbenchHandoffPreludeProps) {
  // Each earlier stretch's messages by session id, loaded once per stretch (absent while loading).
  const [views, setViews] = useState<Record<string, StretchView>>({});
  const dividerRef = useRef<HTMLDivElement>(null);
  const segmentKey = segments.map((segment) => `${segment.kind}:${segment.sessionId}`).join('|');

  // Keyed on the stretches' identities (the array itself is rebuilt by every parent render).
  useEffect(() => {
    let alive = true;
    for (const segment of parseStretchKey(segmentKey)) {
      loadStretch(segment)
        .then((view) => { if (alive) setViews((previous) => ({ ...previous, [segment.sessionId]: view })); })
        .catch(() => { if (alive) setViews((previous) => ({ ...previous, [segment.sessionId]: { status: 'error' } })); });
    }
    return () => { alive = false; };
  }, [segmentKey]);

  // Once everything above has loaded, the handoff point is brought into view, so the owner lands where they continue.
  const allReady = segments.every((segment) => views[segment.sessionId]?.status === 'ready' || views[segment.sessionId]?.status === 'error');
  useEffect(() => {
    if (allReady) dividerRef.current?.scrollIntoView?.({ block: 'end' });
  }, [allReady]);

  return (
    <div className="wbc-handoff-prelude" aria-label="交接前的对话">
      {segments.map((segment, index) => {
        const view = views[segment.sessionId] ?? { status: 'loading' };
        const following = segments[index + 1] ?? null;
        const isLast = index === segments.length - 1;
        const takeover = following
          ? { provider: following.provider, modelLabel: following.modelLabel, handoffAt: following.handoffAt }
          : next;
        return (
          <section key={`${segment.kind}:${segment.sessionId}`} className="wbc-handoff-stretch" aria-label={`${stretchName(segment.provider, segment.modelLabel)} 的对话`}>
            {view.status === 'loading' && (
              <div className="wbc-handoff-loading" role="status"><WorkbenchSpinner size={14} />正在载入 {providerLabel(segment.provider)} 的对话</div>
            )}
            {view.status === 'error' && <p className="wbc-handoff-missing">这段 {providerLabel(segment.provider)} 对话读不到了（可能已删除）。</p>}
            {view.status === 'ready' && (
              <>
                {view.hasMore && <p className="wbc-handoff-missing">只显示最近 {STRETCH_MESSAGE_LIMIT} 条，完整记录在原会话里。</p>}
                {view.messages.map((message, position) => (
                  <div key={String(message.id)} className={`wbc-item is-${message.type}`}>
                    {message.type === 'user'
                      ? <WorkbenchUserMessage message={message} projectId={project.projectId} />
                      : <WorkbenchAssistantMessage message={message} provider={segment.provider} turnStart={view.messages[position - 1]?.type !== 'assistant'} />}
                  </div>
                ))}
              </>
            )}
            <div ref={isLast ? dividerRef : undefined} className={`wbc-divider wbc-handoff-divider${isLast && pending ? ' is-pending' : ''}`} role="note">
              <span className="wbc-divider-label">
                <ArrowRightLeft size={13} aria-hidden="true" />
                {isLast && pending ? `将交给 ${stretchName(takeover.provider, takeover.modelLabel)} 继续` : `已交接给 ${stretchName(takeover.provider, takeover.modelLabel)}`}
                {!pending && formatTime(takeover.handoffAt) && <time dateTime={takeover.handoffAt ?? undefined}>{formatTime(takeover.handoffAt)}</time>}
              </span>
              <span className="wbc-handoff-links">
                <Link to={workbenchPath(project.projectId, { kind: segment.kind, id: segment.sessionId })}>打开原会话</Link>
                {isLast && pending && (
                  <button type="button" onClick={pending.onCancel}><X size={13} aria-hidden="true" />取消交接</button>
                )}
              </span>
              {isLast && pending && (
                pending.status === 'loading' ? (
                  <span className="wbc-handoff-status" role="status"><WorkbenchSpinner size={13} />正在整理交接摘要…</span>
                ) : pending.status === 'error' ? (
                  <span className="wbc-handoff-status is-error" role="alert">
                    {pending.error || '没能整理交接摘要'}
                    <button type="button" onClick={pending.onRetry}>重试</button>
                  </span>
                ) : pending.summary ? (
                  <details className="wbc-divider-details">
                    <summary>查看交接摘要</summary>
                    <Markdown className="wbc-prose is-quiet">{pending.summary}</Markdown>
                  </details>
                ) : null
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
