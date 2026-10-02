import { memo, useState } from 'react';
import { AlertTriangle, Check, Copy, Paperclip, PencilLine, Scissors } from 'lucide-react';

import { ChatMessageImages, Markdown, StreamingMarkdown, SubagentPanel, WorkflowPanel, stripProposedPlanEnvelope } from '@/modules/chat';
import type { ChatMessage, DiffCalculator, Project } from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { modelDisplayName, providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import { readToolInput } from '@/modules/workbench/chat/utils/workbenchToolSummary';

const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });

function formatTime(value: ChatMessage['timestamp']): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : '';
}

function CopyMessageButton({ content }: { content: string }) {
  // Brief tick after a successful copy.
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="wbc-row-action"
      aria-label={copied ? '已复制' : '复制'}
      title={copied ? '已复制' : '复制'}
      onClick={() => {
        void copyTextToClipboard(content).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check size={14} strokeWidth={2.6} className="wbc-pop" /> : <Copy size={14} />}
    </button>
  );
}

/**
 * Used by WorkbenchTranscript and WorkbenchDeepSeekChat for one turn of the owner: a soft bubble on the right, with
 * attachments above it and copy / edit beneath.
 */
export const WorkbenchUserMessage = memo(function WorkbenchUserMessage({ message, projectId, onEdit, failed }: {
  message: ChatMessage;
  projectId: string | null;
  // Present when the provider can re-run from this turn and the session is idle.
  onEdit?: (message: ChatMessage) => void;
  // A DeepSeek turn the model never answered.
  failed?: boolean;
}) {
  const content = String(message.content ?? '');
  const time = formatTime(message.timestamp);
  return (
    <div className={`wbc-row is-user${failed ? ' is-failed' : ''}`}>
      {message.images && message.images.length > 0 && (
        <div className="wbc-attachments"><ChatMessageImages images={message.images} projectId={projectId} /></div>
      )}
      {message.files && message.files.length > 0 && (
        <ul className="wbc-file-chips" aria-label="附件">
          {message.files.map((file, index) => (
            <li key={`${file.path ?? file.name}-${index}`} className="wbc-file-chip"><Paperclip size={13} aria-hidden="true" /><span>{file.name ?? file.path}</span></li>
          ))}
        </ul>
      )}
      {content.trim() && (
        <div className="wbc-bubble">
          <span className="wbc-visually-hidden">你：</span>
          <Markdown breaks className="wbc-prose is-bubble">{content}</Markdown>
        </div>
      )}
      <div className="wbc-row-actions">
        {failed && <span className="wbc-row-failed">没有送达</span>}
        {onEdit && message.transcriptAnchorId && (
          <button type="button" className="wbc-row-action" aria-label="编辑后重新发送" title="编辑后重新发送" onClick={() => onEdit(message)}>
            <PencilLine size={14} />
          </button>
        )}
        {content.trim() && <CopyMessageButton content={content} />}
        {time && <time className="wbc-row-time" dateTime={new Date(message.timestamp).toISOString()}>{time}</time>}
      </div>
    </div>
  );
});

/**
 * Used by WorkbenchTranscript (above each agent turn) and WorkbenchAssistantMessage: who is answering, with the
 * model the provider reported for the turn when it reported one.
 */
export function WorkbenchTurnLabel({ provider, model }: { provider: string; model?: string | null }) {
  return (
    <div className="wbc-turn-label">
      <WorkbenchProviderMark provider={provider} size={20} />
      <span>{providerLabel(provider)}</span>
      {model && <span className="wbc-turn-model" title={model}>{modelDisplayName(model)}</span>}
    </div>
  );
}

/**
 * Used by WorkbenchTranscript and WorkbenchDeepSeekChat for an assistant reply: prose on the left with full
 * markdown, code and tables. With `turnStart` the reply opens its turn and carries the turn label itself.
 */
export const WorkbenchAssistantMessage = memo(function WorkbenchAssistantMessage({ message, provider, turnStart }: {
  message: ChatMessage;
  provider: string;
  turnStart: boolean;
}) {
  const raw = String(message.content ?? '');
  const content = provider === 'codex' ? stripProposedPlanEnvelope(raw) : raw;
  const time = formatTime(message.timestamp);
  return (
    <div className="wbc-row is-assistant">
      {turnStart && <WorkbenchTurnLabel provider={provider} model={message.model} />}
      <StreamingMarkdown content={content} isStreaming={Boolean(message.isStreaming)} className="wbc-prose" />
      {!message.isStreaming && content.trim() && (
        <div className="wbc-row-actions">
          <CopyMessageButton content={content} />
          {time && <time className="wbc-row-time" dateTime={new Date(message.timestamp).toISOString()}>{time}</time>}
        </div>
      )}
    </div>
  );
});

/**
 * Used by WorkbenchTranscript for the quiet rows between turns: an error the provider reported, a background
 * task's report, or a context compaction with its folded summary.
 */
export function WorkbenchNoticeRow({ message }: { message: ChatMessage }) {
  if (message.type === 'error') {
    return (
      <div className="wbc-notice is-error" role="note">
        <AlertTriangle size={15} strokeWidth={2.2} aria-hidden="true" />
        <span className="wbc-notice-text">{String(message.content ?? '出错了')}</span>
      </div>
    );
  }
  if (message.compact) {
    const saved = message.compact.preTokens && message.compact.postTokens
      ? ` · ${Math.round(message.compact.preTokens / 1000)}K → ${Math.round(message.compact.postTokens / 1000)}K`
      : '';
    const label = message.compact.phase === 'running' ? '正在压缩上下文…' : message.compact.phase === 'failed' ? '压缩上下文失败' : `已压缩上下文${saved}`;
    return (
      <div className={`wbc-divider is-${message.compact.phase}`} role="note">
        <span className="wbc-divider-label"><Scissors size={13} aria-hidden="true" />{label}</span>
        {message.compactSummary && (
          <details className="wbc-divider-details">
            <summary>查看摘要</summary>
            <Markdown className="wbc-prose is-quiet">{message.compactSummary}</Markdown>
          </details>
        )}
      </div>
    );
  }
  const ok = message.taskNotificationStatus === 'completed';
  return (
    <div className={`wbc-notice ${ok ? 'is-ok' : 'is-warn'}`} role="note">
      <span className="wbc-notice-dot" aria-hidden="true" />
      <span className="wbc-notice-text">{String(message.content ?? '')}</span>
    </div>
  );
}

/** Used by WorkbenchTranscript for an answered AskUserQuestion: each question with the choice that was made. */
export function WorkbenchAnsweredQuestion({ message }: { message: ChatMessage }) {
  const input = readToolInput(message.toolInput);
  const questions = Array.isArray(input.questions) ? input.questions as { question?: string; header?: string }[] : [];
  const answers = (input.answers && typeof input.answers === 'object' ? input.answers : {}) as Record<string, string>;
  if (!questions.length) return null;
  return (
    <div className="wbc-qa" role="group" aria-label="问答">
      {questions.map((question, index) => (
        <div className="wbc-qa-item" key={`${index}-${question.question}`}>
          <span className="wbc-qa-question">{question.header ? `${question.header} · ` : ''}{question.question}</span>
          <span className={`wbc-qa-answer${answers[question.question ?? ''] ? '' : ' is-empty'}`}>{answers[question.question ?? ''] || '未回答'}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Used by WorkbenchTranscript for a spawned subagent or a workflow run: the inherited panels (timeline, phases,
 * live usage) wrapped in the column's scoped styles rather than re-implemented, because they are rare and intricate.
 */
export function WorkbenchAgentPanel({ message, createDiff, onOpenFile, project }: {
  message: ChatMessage;
  createDiff: DiffCalculator;
  onOpenFile: (path: string) => void;
  project: Project;
}) {
  return (
    <div className="wbc-legacy" id={message.toolId ? `tool-result-${message.toolId}` : undefined}>
      {message.toolName === 'Workflow' ? (
        <WorkflowPanel
          toolInput={message.toolInput}
          toolResult={message.toolResult}
          workflow={message.workflow}
          taskStatus={message.taskStatus}
          onFileOpen={onOpenFile}
          createDiff={createDiff}
          selectedProject={project}
        />
      ) : (
        <SubagentPanel
          toolInput={message.toolInput}
          toolResult={message.toolResult}
          subagent={message.subagent}
          taskStatus={message.taskStatus}
          activity={message.subagentActivity}
          onFileOpen={onOpenFile}
          createDiff={createDiff}
          selectedProject={project}
        />
      )}
    </div>
  );
}
