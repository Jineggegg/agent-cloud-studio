import { useMemo } from 'react';
import { m } from 'motion/react';

import { buildClaudeToolPermissionEntry, formatToolInputForDisplay, getClaudeSettings } from '@/modules/chat';
import type { DiffCalculator, PendingPermissionRequest, WorkbenchPermissionDecision } from '@/shared/types';
import { WorkbenchProviderMark } from '@/modules/workbench/chat/WorkbenchProviderMark';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';
import { describeToolCall, readToolInput } from '@/modules/workbench/chat/utils/workbenchToolSummary';

// The Claude runtime matches this wording to mark the call as denied rather than failed.
const DENY_MESSAGE = 'User denied tool use';
// Changed lines previewed for an edit awaiting approval.
const PREVIEW_DIFF_LINES = 8;

const SHEET_SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;

// What the agent wants to do, completing `Claude Code 想…`; a file or pattern target follows in mono.
const ACTIONS: Record<string, string> = {
  command: '运行命令',
  edit: '修改',
  write: '写入',
  read: '读取',
  search: '搜索',
  web: '访问网络',
  agent: '启动子任务',
};

type WorkbenchPermissionSheetProps = {
  // Actionable prompts in arrival order (plan approvals and questions have their own surfaces).
  requests: PendingPermissionRequest[];
  // Every pending prompt, so "always allow" can answer the identical ones in one go.
  allRequests: PendingPermissionRequest[];
  provider: string;
  onDecision: WorkbenchPermissionDecision;
  onGrant: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  createDiff: DiffCalculator;
};

/**
 * Used by WorkbenchAgentChat above the composer: the oldest pending tool permission as an inline iOS action sheet —
 * what the agent wants to do (the command, the file and its diff), then 拒绝 / 始终允许 / 允许. It rises in with a
 * spring and the next request replaces it the same way.
 */
export function WorkbenchPermissionSheet({ requests, allRequests, provider, onDecision, onGrant, createDiff }: WorkbenchPermissionSheetProps) {
  const request = requests[0];
  const call = describeToolCall(request.toolName, request.input);
  const input = readToolInput(request.input);
  const rawInput = formatToolInputForDisplay(request.input);
  const entry = provider === 'claude' ? buildClaudeToolPermissionEntry(request.toolName, rawInput) : null;
  const alreadyAllowed = entry ? getClaudeSettings().allowedTools.includes(entry) : false;

  const diff = useMemo(() => {
    if (call.kind !== 'edit' && call.kind !== 'write') return null;
    const before = typeof input.old_string === 'string' ? input.old_string : '';
    const after = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : '';
    return createDiff(before, after).slice(0, PREVIEW_DIFF_LINES);
  }, [call.kind, createDiff, input.content, input.new_string, input.old_string]);

  const action = ACTIONS[call.kind] ?? `使用 ${call.verb}`;
  const command = call.kind === 'command' && typeof input.command === 'string' ? input.command : null;
  const description = typeof input.description === 'string' ? input.description : null;

  const allowAlways = () => {
    if (!entry) return;
    if (!alreadyAllowed) onGrant({ entry, toolName: request.toolName });
    const matching = allRequests
      .filter((item) => buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === entry)
      .map((item) => item.requestId);
    onDecision(matching.length ? matching : request.requestId, { allow: true, rememberEntry: entry });
  };

  return (
    <m.section
      key={request.requestId}
      className="wbc-sheet"
      aria-labelledby={`perm-title-${request.requestId}`}
      initial={{ opacity: 0, y: 28, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.98, transition: { duration: 0.16 } }}
      transition={SHEET_SPRING}
    >
      <div className="wbc-sheet-body">
        <div className="wbc-sheet-head">
          <WorkbenchProviderMark provider={provider} size={26} />
          <h3 className="wbc-sheet-title" id={`perm-title-${request.requestId}`}>
            <span>{providerLabel(provider)} 想{action}</span>
            {call.kind !== 'command' && call.target && <span className="wbc-sheet-target" title={call.filePath ?? call.target}>{call.target}</span>}
          </h3>
          {requests.length > 1 && <span className="wbc-sheet-count">还有 {requests.length - 1} 个</span>}
        </div>
        {command && <pre className="wbc-code is-command wbc-sheet-code"><span className="wbc-prompt" aria-hidden="true">$ </span>{command}</pre>}
        {description && <p className="wbc-sheet-note">{description}</p>}
        {diff && diff.length > 0 && (
          <div className="wbc-diff is-compact" aria-label="将要做的改动">
            {diff.map((line, index) => (
              <div key={index} className={`wbc-diff-line is-${line.type}`}>
                <span className="wbc-diff-sign" aria-hidden="true">{line.type === 'added' ? '+' : '−'}</span>
                <code className="wbc-diff-code">{line.content || ' '}</code>
              </div>
            ))}
          </div>
        )}
        {!command && !diff && rawInput && call.kind !== 'read' && (
          <details className="wbc-sheet-details">
            <summary>查看参数</summary>
            <pre className="wbc-code">{rawInput}</pre>
          </details>
        )}
      </div>
      <div className={`wbc-sheet-actions${entry ? '' : ' is-two'}`}>
        <button
          type="button"
          className="wbc-sheet-action is-destructive"
          onClick={() => onDecision(request.requestId, { allow: false, message: DENY_MESSAGE })}
        >
          拒绝
        </button>
        {entry && (
          <button type="button" className="wbc-sheet-action is-remember" onClick={allowAlways} title={`以后自动允许 ${entry}`}>
            <span>{alreadyAllowed ? '允许（已记住）' : '始终允许'}</span>
            <small>{entry}</small>
          </button>
        )}
        <button type="button" className="wbc-sheet-action is-primary" onClick={() => onDecision(request.requestId, { allow: true })}>
          允许
        </button>
      </div>
    </m.section>
  );
}
