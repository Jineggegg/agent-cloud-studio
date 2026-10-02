import { Fragment, memo, useMemo, useState } from 'react';
import { m } from 'motion/react';
import {
  Ban,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  ListChecks,
  Map as MapIcon,
  MessageCircleQuestion,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Markdown } from '@/modules/chat';
import type { ChatMessage, DiffCalculator, DiffLine, WorkbenchToolSummary } from '@/shared/types';
import { copyTextToClipboard } from '@/shared/utils';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';
import { WorkbenchTodoList } from '@/modules/workbench/chat/WorkbenchTodoList';
import { readTodos, readToolInput, summarizeTool } from '@/modules/workbench/chat/utils/workbenchToolSummary';

const KIND_ICONS: Record<WorkbenchToolSummary['kind'], LucideIcon> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  search: Search,
  web: Globe,
  todo: ListChecks,
  agent: Bot,
  plan: MapIcon,
  question: MessageCircleQuestion,
  think: Brain,
  other: Wrench,
};

const STATUS_LABELS: Record<WorkbenchToolSummary['status'], string> = {
  running: '进行中',
  done: '完成',
  error: '出错',
  denied: '已拒绝',
  idle: '未完成',
};

// A stack longer than this folds its middle behind one row until asked.
const STACK_FOLD_THRESHOLD = 6;
// Output panes keep the tail of very long command output; the head is rarely what matters.
const OUTPUT_TAIL_CHARS = 12_000;
// Diffs past this many changed lines point at the file instead of drawing everything.
const DIFF_LINE_LIMIT = 300;
// Changed lines previewed under a collapsed edit row.
const DIFF_GLIMPSE_LINES = 2;

type ToolStackProps = {
  messages: ChatMessage[];
  runActive: boolean;
  createDiff: DiffCalculator;
  onOpenFile: (path: string) => void;
};

/** The before/after text an edit-like call carries, or null for any other call. */
function readEditTexts(message: ChatMessage): { before: string; after: string }[] | null {
  const name = String(message.toolName ?? '');
  const input = readToolInput(message.toolInput);
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  if (name === 'Write') return [{ before: '', after: str(input.content) }];
  if (name === 'Edit' || name === 'ApplyPatch') return [{ before: str(input.old_string), after: str(input.new_string) }];
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((edit) => {
      const record = (edit && typeof edit === 'object' ? edit : {}) as Record<string, unknown>;
      return { before: str(record.old_string), after: str(record.new_string) };
    });
  }
  return null;
}

/** Changed lines of an edit-like call, computed once per row through the session's cached calculator. */
function useEditDiff(message: ChatMessage, createDiff: DiffCalculator): DiffLine[] | null {
  return useMemo(() => {
    const texts = readEditTexts(message);
    if (!texts) return null;
    return texts.flatMap(({ before, after }) => createDiff(before, after));
  }, [createDiff, message]);
}

function resultText(message: ChatMessage): string {
  const content = message.toolResult?.content;
  if (content === undefined || content === null) return '';
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

function DiffLines({ lines, limit = DIFF_LINE_LIMIT }: { lines: DiffLine[]; limit?: number }) {
  const shown = lines.slice(0, limit);
  return (
    <div className="wbc-diff" role="group" aria-label="改动">
      {shown.map((line, index) => (
        <div key={index} className={`wbc-diff-line is-${line.type}`}>
          <span className="wbc-diff-num">{line.lineNum}</span>
          <span className="wbc-diff-sign" aria-hidden="true">{line.type === 'added' ? '+' : '−'}</span>
          <span className="wbc-visually-hidden">{line.type === 'added' ? '新增：' : '删除：'}</span>
          <code className="wbc-diff-code">{line.content || ' '}</code>
        </div>
      ))}
      {lines.length > shown.length && <div className="wbc-diff-more">还有 {lines.length - shown.length} 行改动，打开文件查看全部</div>}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  // Brief tick after a successful copy; reverts on its own.
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="wbc-mini-button"
      onClick={() => {
        void copyTextToClipboard(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check size={14} strokeWidth={2.6} /> : <Copy size={14} />}
      <span>{copied ? '已复制' : label}</span>
    </button>
  );
}

/** Expanded body of a tool row; mounted on first open only, so a long run costs nothing until looked at. */
function ToolDetail({ message, summary, diff, onOpenFile }: {
  message: ChatMessage;
  summary: WorkbenchToolSummary;
  diff: DiffLine[] | null;
  onOpenFile: (path: string) => void;
}) {
  const input = readToolInput(message.toolInput);
  const output = resultText(message);
  const isError = Boolean(message.toolResult?.isError);
  const openFile = summary.filePath
    ? <button type="button" className="wbc-mini-button" onClick={() => onOpenFile(summary.filePath as string)}><ExternalLink size={14} /><span>打开文件</span></button>
    : null;

  if (summary.kind === 'think') {
    return <div className="wbc-detail-prose"><Markdown className="wbc-prose is-quiet">{String(message.content ?? '')}</Markdown></div>;
  }

  if (summary.kind === 'todo') {
    const todos = readTodos(message.toolInput);
    return todos.length ? <WorkbenchTodoList todos={todos} /> : <p className="wbc-detail-note">清单为空</p>;
  }

  if (summary.kind === 'command') {
    const command = typeof input.command === 'string' ? input.command : '';
    const tail = output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output;
    return (
      <div className="wbc-detail-stack">
        <pre className="wbc-code is-command"><span className="wbc-prompt" aria-hidden="true">$ </span>{command}</pre>
        {typeof input.description === 'string' && input.description && <p className="wbc-detail-note">{input.description}</p>}
        {tail && (
          <pre className={`wbc-code is-output${isError ? ' is-error' : ''}`} tabIndex={0} aria-label="命令输出">
            {output.length > tail.length && <span className="wbc-detail-note">（前面省略 {output.length - tail.length} 个字符）{'\n'}</span>}
            {tail}
          </pre>
        )}
        <div className="wbc-detail-actions"><CopyButton value={command} label="复制命令" /></div>
      </div>
    );
  }

  if (diff) {
    return (
      <div className="wbc-detail-stack">
        {summary.filePath && <p className="wbc-detail-path" title={summary.filePath}>{summary.filePath}</p>}
        {diff.length ? <DiffLines lines={diff} /> : <p className="wbc-detail-note">没有文本改动</p>}
        {isError && output && <pre className="wbc-code is-output is-error">{output}</pre>}
        {openFile && <div className="wbc-detail-actions">{openFile}</div>}
      </div>
    );
  }

  if (summary.kind === 'search') {
    const toolUseResult = message.toolResult?.toolUseResult as { filenames?: unknown } | undefined;
    const files = Array.isArray(toolUseResult?.filenames)
      ? toolUseResult.filenames.filter((file): file is string => typeof file === 'string')
      : output.split('\n').map((line) => line.trim()).filter((line) => /[\\/]/.test(line) && !/\s{2,}/.test(line));
    return (
      <div className="wbc-detail-stack">
        {files.length > 0 ? (
          <ul className="wbc-file-list" aria-label="找到的文件">
            {files.slice(0, 60).map((file) => (
              <li key={file}><button type="button" className="wbc-file" onClick={() => onOpenFile(file)} title={file}>{file}</button></li>
            ))}
            {files.length > 60 && <li className="wbc-detail-note">还有 {files.length - 60} 个文件</li>}
          </ul>
        ) : output ? <pre className={`wbc-code is-output${isError ? ' is-error' : ''}`}>{output}</pre> : <p className="wbc-detail-note">没有结果</p>}
      </div>
    );
  }

  if (summary.kind === 'read') {
    const range = [input.offset, input.limit].every((value) => typeof value === 'number')
      ? `第 ${String(input.offset)} 行起，${String(input.limit)} 行`
      : null;
    return (
      <div className="wbc-detail-stack">
        {summary.filePath && <p className="wbc-detail-path" title={summary.filePath}>{summary.filePath}</p>}
        {range && <p className="wbc-detail-note">{range}</p>}
        {isError && output && <pre className="wbc-code is-output is-error">{output}</pre>}
        {openFile && <div className="wbc-detail-actions">{openFile}</div>}
      </div>
    );
  }

  // Web, MCP and anything else: the arguments, then what came back.
  const argumentsText = Object.keys(input).length ? JSON.stringify(input, null, 2) : '';
  return (
    <div className="wbc-detail-stack">
      {argumentsText && <pre className="wbc-code" aria-label="参数">{argumentsText}</pre>}
      {output && (
        <pre className={`wbc-code is-output${isError ? ' is-error' : ''}`} tabIndex={0} aria-label="结果">
          {output.length > OUTPUT_TAIL_CHARS ? `${output.slice(0, OUTPUT_TAIL_CHARS)}…` : output}
        </pre>
      )}
      {!argumentsText && !output && <p className="wbc-detail-note">没有更多内容</p>}
    </div>
  );
}

function StatusGlyph({ status }: { status: WorkbenchToolSummary['status'] }) {
  if (status === 'running') return <WorkbenchSpinner size={15} />;
  if (status === 'done') return <Check size={15} strokeWidth={2.6} />;
  if (status === 'error') return <X size={15} strokeWidth={2.6} />;
  if (status === 'denied') return <Ban size={14} strokeWidth={2.4} />;
  return null;
}

const ToolRow = memo(function ToolRow({ message, runActive, createDiff, onOpenFile, animateIn }: {
  message: ChatMessage;
  runActive: boolean;
  createDiff: DiffCalculator;
  onOpenFile: (path: string) => void;
  animateIn: boolean;
}) {
  // Whether the detail is showing; local because every row folds independently.
  const [open, setOpen] = useState(false);
  // Set on first open and never cleared, so the detail stays mounted for a smooth collapse.
  const [hasOpened, setHasOpened] = useState(false);
  const summary = summarizeTool(message, runActive);
  const diff = useEditDiff(message, createDiff);
  const Icon = KIND_ICONS[summary.kind];
  const added = diff?.filter((line) => line.type === 'added').length ?? 0;
  const removed = diff ? diff.length - added : 0;
  const glimpse = diff && !open ? diff.slice(0, DIFF_GLIMPSE_LINES) : null;

  return (
    <m.div
      role="listitem"
      className={`wbc-tool is-${summary.kind} is-${summary.status}${open ? ' is-open' : ''}`}
      initial={animateIn ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <button
        type="button"
        className="wbc-tool-row"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setHasOpened(true);
        }}
      >
        <span className="wbc-tool-icon" aria-hidden="true"><Icon size={15} strokeWidth={2.1} /></span>
        <span className="wbc-tool-text">
          <span className="wbc-tool-verb">{summary.verb}</span>
          {summary.target && <span className="wbc-tool-target" title={summary.filePath ?? summary.target}>{summary.target}</span>}
        </span>
        {diff && (added > 0 || removed > 0) && (
          <span className="wbc-tool-stats" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
            {added > 0 && <span className="is-added">+{added}</span>}
            {removed > 0 && <span className="is-removed">−{removed}</span>}
          </span>
        )}
        <span className="wbc-tool-status" title={STATUS_LABELS[summary.status]}>
          <StatusGlyph status={summary.status} />
          <span className="wbc-visually-hidden">{STATUS_LABELS[summary.status]}</span>
        </span>
        <ChevronRight className="wbc-tool-chevron" size={15} strokeWidth={2.4} aria-hidden="true" />
      </button>
      {glimpse && glimpse.length > 0 && (
        <div className="wbc-glimpse" aria-hidden="true">
          {glimpse.map((line, index) => (
            <code key={index} className={`is-${line.type}`}>{line.type === 'added' ? '+ ' : '− '}{line.content}</code>
          ))}
        </div>
      )}
      <div className="wbc-tool-detail" data-open={open}>
        <div className="wbc-tool-detail-inner">
          {hasOpened && <ToolDetail message={message} summary={summary} diff={diff} onOpenFile={onOpenFile} />}
        </div>
      </div>
    </m.div>
  );
});

const rowKey = (message: ChatMessage, index: number): string =>
  String(message.toolId ?? message.id ?? `${index}-${String(message.timestamp)}`);

/**
 * Used by WorkbenchTranscript for a run of consecutive tool calls (and the reasoning between them): one grouped
 * inset list, each call a compact row with icon, verb, target and status that expands to its diff, output or
 * arguments. Long stacks fold their middle.
 */
export const WorkbenchToolStack = memo(function WorkbenchToolStack({ messages, runActive, createDiff, onOpenFile }: ToolStackProps) {
  // Whether a folded stack has been expanded to show every step.
  const [showAll, setShowAll] = useState(false);
  // Rows present when the stack mounted; they arrive without an entrance, rows streamed in later rise into place.
  // Never updated: a stack remounted by the lazy-row band starts with everything counted as present.
  const [initialKeys] = useState(() => new Set(messages.map(rowKey)));

  const folded = !showAll && messages.length > STACK_FOLD_THRESHOLD;
  const hiddenCount = folded ? messages.length - 5 : 0;
  const rows = folded ? [...messages.slice(0, 2), ...messages.slice(-3)] : messages;

  return (
    <div className="wbc-stack" role="list" aria-label="工具调用">
      {rows.map((message, index) => {
        const sourceIndex = folded && index >= 2 ? messages.length - 3 + (index - 2) : index;
        const key = rowKey(message, sourceIndex);
        return (
          <Fragment key={key}>
            {folded && index === 2 && (
              <div role="listitem" className="wbc-tool">
                <button type="button" className="wbc-stack-fold" onClick={() => setShowAll(true)}>
                  展开另外 {hiddenCount} 步
                </button>
              </div>
            )}
            <ToolRow
              message={message}
              runActive={runActive}
              createDiff={createDiff}
              onOpenFile={onOpenFile}
              animateIn={!initialKeys.has(key)}
            />
          </Fragment>
        );
      })}
    </div>
  );
});
