import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, History, X } from 'lucide-react';

import {
  LazyMessageRow,
  Markdown,
  PermissionContext,
  TranscriptSessionContext,
  createCachedDiffCalculator,
  normalizedToChatMessages,
  useLazyRowObserver,
} from '@/modules/chat';
import { api, readApiJson } from '@/shared/api';
import type {
  ChatMessage, NormalizedMessage, Project, StudioConversation, WorkbenchNewProvider, WorkbenchPermissionDecision, WorkbenchThreadSegment,
} from '@/shared/types';
import { WorkbenchSessionHistoryContext } from '@/modules/workbench/context/WorkbenchSessionHistoryContext';
import { WorkbenchAssistantMessage, WorkbenchUserMessage } from '@/modules/workbench/chat/WorkbenchMessageRow';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { WorkbenchTranscriptItem } from '@/modules/workbench/chat/WorkbenchTranscript';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import { buildWorkbenchTranscriptRows } from '@/modules/workbench/chat/utils/workbenchTranscriptRows';
import { workbenchPath } from '@/modules/workbench/utils/workbenchRoutes';

// History rows read per request from an earlier stretch, newest first. Twice the open session's page: a stretch is
// read only while scrolling up through it, and a turn with tool calls spans many rows.
const STRETCH_PAGE_SIZE = 40;
// Older rows load once the top of the prelude comes this close to the top of the view (the open session uses 100px
// of scroll offset; the prelude starts a little earlier so the next page is usually in before it is reached).
const LOAD_OLDER_MARGIN_PX = 240;

const timeFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// GET /api/providers/sessions/:id/messages, the fields read here.
type HistoryEnvelope = { data?: { messages?: NormalizedMessage[]; hasMore?: boolean } };

// An earlier stretch as loaded so far: an agent session's history rows (oldest first, newest pages loaded first), or
// a DeepSeek conversation, which the API returns whole.
type StretchView =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; kind: 'agent'; rows: NormalizedMessage[]; hasMore: boolean }
  | { status: 'ready'; kind: 'deepseek'; messages: ChatMessage[]; model: string | null };

// The stretches loaded for one chain (`key`), and whether the last request for older rows of a stretch failed.
type PreludeState = { key: string; views: Record<string, StretchView>; olderFailed: boolean };

// An earlier stretch's session, as named in the prelude's key (`agent:<id>|deepseek:<id>`).
type StretchRef = Pick<WorkbenchThreadSegment, 'kind' | 'sessionId'>;

// What scrolling up loads next: a stretch's first (newest) page, or the page above what it shows.
type NextLoad = { index: number; ref: StretchRef; offset: number; first: boolean };

// Earlier stretches never wait on the owner: no plan or permission answered from here reaches any session.
const READ_ONLY_DECISION: WorkbenchPermissionDecision = () => undefined;
const READ_ONLY_PERMISSIONS = { pendingPermissionRequests: [], handlePermissionDecision: () => undefined };
// What a chain shows before anything of it has loaded.
const NO_VIEWS: Record<string, StretchView> = {};

/** The divider's label for the stretch that took over: `Codex · GPT-6.1 Sol`. */
function stretchName(provider: string, modelLabel: string | null): string {
  return modelLabel ? `${providerLabel(provider)} · ${modelLabel}` : providerLabel(provider);
}

function formatTime(value: string | null): string {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? timeFormatter.format(time) : '';
}

function parseStretchKey(key: string): StretchRef[] {
  return key.split('|').filter(Boolean).map((part) => {
    const separator = part.indexOf(':');
    return { kind: part.slice(0, separator) === 'deepseek' ? 'deepseek' : 'agent', sessionId: part.slice(separator + 1) };
  });
}

/**
 * Stretches load from the handoff point backwards: the newest stretch first, then each stretch's older pages, then
 * the stretch before it. Null while a request is out for the oldest stretch shown, or once everything is shown.
 */
function planNextLoad(refs: StretchRef[], views: Record<string, StretchView>): NextLoad | null {
  const oldestShown = refs.findIndex((ref) => views[ref.sessionId]);
  if (oldestShown === -1) {
    return refs.length ? { index: refs.length - 1, ref: refs[refs.length - 1], offset: 0, first: true } : null;
  }
  const view = views[refs[oldestShown].sessionId];
  if (view.status === 'loading') return null;
  if (view.status === 'ready' && view.kind === 'agent' && view.hasMore) {
    return { index: oldestShown, ref: refs[oldestShown], offset: view.rows.length, first: false };
  }
  return oldestShown > 0 ? { index: oldestShown - 1, ref: refs[oldestShown - 1], offset: 0, first: true } : null;
}

/** One page of an agent stretch (`offset` rows back from its newest), or a DeepSeek conversation whole. */
async function loadStretchPage(ref: StretchRef, offset: number): Promise<{ rows: NormalizedMessage[]; hasMore: boolean } | { messages: ChatMessage[]; model: string | null }> {
  if (ref.kind === 'deepseek') {
    const conversation = await api.studio.conversation(ref.sessionId).then(readApiJson<StudioConversation>);
    // As the DeepSeek view draws them: the API keeps no per-message time, and an unanswered turn is marked.
    const messages = (conversation.messages ?? []).map((message): ChatMessage => ({
      type: message.role === 'user' ? 'user' : 'assistant', content: message.content, timestamp: '', id: `ds-${message.id}`, failed: message.status === 'error',
    }));
    return { messages, model: conversation.model ?? null };
  }
  const envelope = await api.providers.sessionMessages(ref.sessionId, { limit: STRETCH_PAGE_SIZE, offset }).then(readApiJson<HistoryEnvelope>);
  return { rows: envelope.data?.messages ?? [], hasMore: Boolean(envelope.data?.hasMore) };
}

type StretchRowsProps = {
  project: Project;
  provider: string;
  lazyRows: ReturnType<typeof useLazyRowObserver>;
};

/**
 * An agent stretch drawn the way the live transcript draws a session — turn labels, prose, tool stacks with diffs
 * and command output, plans, questions, subagent and workflow panels — but read-only: never running, no pending
 * plan, no edit. Rows mount at full height so loading a page above the view can keep the view still.
 */
function AgentStretchRows({ project, provider, lazyRows, sessionId, rows, onOpenFile }: StretchRowsProps & {
  sessionId: string;
  rows: NormalizedMessage[];
  onOpenFile: (path: string) => void;
}) {
  const items = useMemo(() => buildWorkbenchTranscriptRows(normalizedToChatMessages(rows)), [rows]);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  // Workflow panels read their agents' timelines from the stretch's own session, not the one open below.
  const transcriptSession = useMemo(() => ({ sessionId }), [sessionId]);
  return (
    <TranscriptSessionContext.Provider value={transcriptSession}>
      {items.map((item) => (
        // No timestamp on the wrapper: a search jump in the open session must never land in another session's rows.
        <LazyMessageRow key={item.key} lazyRows={lazyRows} timestamp={undefined} initiallyNearViewport>
          <div className={`wbc-item is-${item.kind}`}>
            <WorkbenchTranscriptItem
              item={item}
              provider={provider}
              project={project}
              runActive={false}
              createDiff={createDiff}
              onOpenFile={onOpenFile}
              pendingPlanRequest={null}
              onDecision={READ_ONLY_DECISION}
            />
          </div>
        </LazyMessageRow>
      ))}
    </TranscriptSessionContext.Provider>
  );
}

/** A DeepSeek stretch drawn as the DeepSeek view draws its conversation. */
function DeepSeekStretchRows({ project, provider, lazyRows, messages, model }: StretchRowsProps & { messages: ChatMessage[]; model: string | null }) {
  return messages.map((message, index) => (
    <LazyMessageRow key={String(message.id)} lazyRows={lazyRows} timestamp={undefined} initiallyNearViewport>
      <div className={`wbc-item is-${message.type}`}>
        {message.type === 'user'
          ? <WorkbenchUserMessage message={message} projectId={project.projectId} failed={Boolean(message.failed)} />
          : <WorkbenchAssistantMessage message={{ ...message, model: model ?? undefined }} provider={provider} turnStart={messages[index - 1]?.type !== 'assistant'} />}
      </div>
    </LazyMessageRow>
  ));
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
  // Opens a file named in an earlier stretch's tool call (the column's file viewer).
  onOpenFile: (path: string) => void;
};

/**
 * Used by WorkbenchChat above the open chat's own transcript when the conversation was (or is being) handed between
 * providers: each earlier stretch drawn read-only with the same rows a live session uses (tool calls included), and
 * a divider at every handoff — 已交接给 Codex · GPT-6.1 Sol, with 打开原会话 — or, before the next session exists,
 * 将交给 … with the summary and a way back. Like the live transcript it pages: the newest stretch's latest rows load
 * first, and scrolling up reads older rows, then the stretch before.
 */
export function WorkbenchHandoffPrelude({ project, segments, next, pending, onOpenFile }: WorkbenchHandoffPreludeProps) {
  const segmentKey = segments.map((segment) => `${segment.kind}:${segment.sessionId}`).join('|');
  // What is loaded of this chain's earlier stretches; starts over when the chain on screen changes.
  const [state, setState] = useState<PreludeState>({ key: segmentKey, views: {}, olderFailed: false });
  // The chain whose page request is out, for the spinner; a stale chain's request never reads as this one's.
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const { olderRowsPending } = useContext(WorkbenchSessionHistoryContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  // The column's scroll container, found from the prelude itself (the agent and DeepSeek views both own one).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The latest state for the pager, which runs from scroll events and resolved requests.
  const stateRef = useRef(state);
  // In-flight chain, so one scroll gesture never sends two requests.
  const busyRef = useRef<string | null>(null);
  // Distance from the scroll bottom just before rows were added above, restored once they are in the DOM.
  const restoreRef = useRef<number | null>(null);
  const lazyRows = useLazyRowObserver(scrollRef);

  // Another chain on screen starts over (state adjusted during render); until then nothing of the old one shows.
  const isCurrentChain = state.key === segmentKey;
  if (!isCurrentChain) setState({ key: segmentKey, views: {}, olderFailed: false });
  const views = isCurrentChain ? state.views : NO_VIEWS;
  const olderFailed = isCurrentChain && state.olderFailed;

  useLayoutEffect(() => {
    scrollRef.current = rootRef.current?.closest<HTMLDivElement>('.wbc-scroll') ?? null;
  }, []);

  // Rows load above whatever the owner is reading, so the view keeps its distance from the bottom: the rows on
  // screen stay put, and a chat opened at its end stays at its end.
  const update = useCallback((nextState: PreludeState) => {
    const container = scrollRef.current;
    if (container && restoreRef.current === null) restoreRef.current = container.scrollHeight - container.scrollTop;
    setState(nextState);
  }, []);

  useLayoutEffect(() => {
    stateRef.current = state;
    const container = scrollRef.current;
    const distance = restoreRef.current;
    restoreRef.current = null;
    if (container && distance !== null) container.scrollTop = Math.max(0, container.scrollHeight - distance);
  }, [state]);

  const loadNext = useCallback(() => {
    const snapshot = stateRef.current;
    if (busyRef.current === snapshot.key) return;
    const plan = planNextLoad(parseStretchKey(snapshot.key), snapshot.views);
    if (!plan) return;
    const chain = snapshot.key;
    const sessionId = plan.ref.sessionId;
    busyRef.current = chain;
    setLoadingKey(chain);
    // A page for a chain no longer on screen is dropped. The ref moves ahead of the render, so a scroll event that
    // lands before React commits plans from the rows just received and never asks for the same page twice.
    const forChain = (change: (previous: PreludeState) => PreludeState) => {
      const previous = stateRef.current;
      if (previous.key !== chain) return;
      const nextState = change(previous);
      stateRef.current = nextState;
      update(nextState);
    };
    if (plan.first) forChain((previous) => ({ ...previous, olderFailed: false, views: { ...previous.views, [sessionId]: { status: 'loading' } } }));
    loadStretchPage(plan.ref, plan.offset)
      .then((page) => forChain((previous) => {
        const view = previous.views[sessionId];
        const loaded: StretchView = 'messages' in page
          ? { status: 'ready', kind: 'deepseek', messages: page.messages, model: page.model }
          // Older pages go above the rows already shown.
          : { status: 'ready', kind: 'agent', rows: view?.status === 'ready' && view.kind === 'agent' ? [...page.rows, ...view.rows] : page.rows, hasMore: page.hasMore };
        return { ...previous, olderFailed: false, views: { ...previous.views, [sessionId]: loaded } };
      }))
      .catch(() => forChain((previous) => (plan.first
        ? { ...previous, views: { ...previous.views, [sessionId]: { status: 'error' } } }
        : { ...previous, olderFailed: true })))
      .finally(() => {
        if (busyRef.current === chain) busyRef.current = null;
        setLoadingKey((key) => (key === chain ? null : key));
      });
  }, [update]);

  const refs = parseStretchKey(segmentKey);
  const started = refs.some((ref) => views[ref.sessionId]);
  const loading = loadingKey === segmentKey;
  const nextLoad = loading ? null : planNextLoad(refs, views);
  // Paging waits while the open session still has older rows of its own to show between here and its first row.
  const canLoadOlder = Boolean(nextLoad) && started && !olderRowsPending;

  // The newest stretch's latest rows load once the open session is shown from its first row.
  useEffect(() => {
    if (!olderRowsPending && !started && state.key === segmentKey) loadNext();
  }, [loadNext, olderRowsPending, segmentKey, started, state.key]);

  // Scrolling up to the top of the prelude reads the next older page, as the live transcript does. After a failed
  // page only the button retries, so a dead connection is not asked again on every scroll event.
  const autoLoad = canLoadOlder && !olderFailed;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !autoLoad) return undefined;
    const onScroll = () => {
      const top = topRef.current;
      if (top && top.getBoundingClientRect().bottom >= container.getBoundingClientRect().top - LOAD_OLDER_MARGIN_PX) loadNext();
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [autoLoad, loadNext]);

  const oldestShown = refs.findIndex((ref) => views[ref.sessionId]);
  const olderLoading = loading && oldestShown !== -1 && views[refs[oldestShown].sessionId]?.status !== 'loading';

  return (
    <PermissionContext.Provider value={READ_ONLY_PERMISSIONS}>
      <div ref={rootRef} className="wbc-handoff-prelude" aria-label="交接前的对话">
        {started && (olderLoading || (canLoadOlder && nextLoad)) && (
          <div ref={topRef} className="wbc-history">
            {olderLoading ? (
              <span className="wbc-history-loading" role="status"><WorkbenchSpinner size={14} />正在载入更早的消息</span>
            ) : nextLoad && (
              <button type="button" className="wbc-history-button" onClick={loadNext}>
                <History size={14} aria-hidden="true" />
                {olderFailed ? '没能载入更早的消息，再试一次'
                  : nextLoad.first ? `载入更早的 ${providerLabel(segments[nextLoad.index]?.provider ?? '')} 对话` : '载入更早的消息'}
              </button>
            )}
          </div>
        )}
        {segments.map((segment, index) => {
          const view = views[segment.sessionId];
          // A stretch above the ones read so far is not drawn yet: scrolling up reaches it.
          if (!view) return null;
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
              {view.status === 'ready' && view.kind === 'agent' && (
                <AgentStretchRows project={project} provider={segment.provider} lazyRows={lazyRows} sessionId={segment.sessionId} rows={view.rows} onOpenFile={onOpenFile} />
              )}
              {view.status === 'ready' && view.kind === 'deepseek' && (
                <DeepSeekStretchRows project={project} provider={segment.provider} lazyRows={lazyRows} messages={view.messages} model={view.model} />
              )}
              <div className={`wbc-divider wbc-handoff-divider${isLast && pending ? ' is-pending' : ''}`} role="note">
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
    </PermissionContext.Provider>
  );
}
