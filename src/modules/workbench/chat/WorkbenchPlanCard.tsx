import { useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { ChevronDown, Map as MapIcon } from 'lucide-react';

import { Markdown } from '@/modules/chat';
import type { PendingPermissionRequest, WorkbenchPermissionDecision } from '@/shared/types';
import { WorkbenchSpinner } from '@/modules/workbench/chat/WorkbenchSpinner';

// What Claude reads when a plan is sent back without a note; the runtime adapter's own wording.
const DEFAULT_REVISE_MESSAGE = 'User asked to revise the plan';
// Plans longer than this many characters start folded behind a fade.
const LONG_PLAN_CHARS = 1400;

/**
 * Used by WorkbenchTranscript for an ExitPlanMode call, and by WorkbenchAgentChat's dock when the prompt's
 * transcript row is not loaded: the proposed plan as a reading card. While Claude waits for approval it carries
 * 批准并执行 and 继续修改, where the owner can say what to change.
 */
export function WorkbenchPlanCard({ plan, pendingRequest, onDecision, isWriting }: {
  plan: string;
  // The ExitPlanMode prompt awaiting an answer, when this is the plan it belongs to.
  pendingRequest: PendingPermissionRequest | null;
  onDecision: WorkbenchPermissionDecision;
  // True while the plan is still being written (no result yet and nothing pending).
  isWriting?: boolean;
}) {
  // Long plans start folded; the owner can open the whole text.
  const [expanded, setExpanded] = useState(plan.length <= LONG_PLAN_CHARS);
  // Whether the revision note field is showing.
  const [revising, setRevising] = useState(false);
  // The owner's note on what to change, sent back as the denial message.
  const [note, setNote] = useState('');

  const approve = () => pendingRequest && onDecision(pendingRequest.requestId, { allow: true });
  const sendRevision = () => {
    if (!pendingRequest) return;
    onDecision(pendingRequest.requestId, { allow: false, message: note.trim() || DEFAULT_REVISE_MESSAGE });
  };

  return (
    <section className={`wbc-plan${pendingRequest ? ' is-pending' : ''}`} aria-label="执行计划">
      <header className="wbc-plan-head">
        <span className="wbc-plan-icon" aria-hidden="true"><MapIcon size={16} strokeWidth={2.1} /></span>
        <span className="wbc-plan-title">执行计划</span>
        {pendingRequest && <span className="wbc-plan-badge">等你批准</span>}
        {isWriting && !pendingRequest && <WorkbenchSpinner size={14} label="正在写计划" />}
      </header>
      <div className={`wbc-plan-body${expanded ? '' : ' is-folded'}`}>
        {plan ? <Markdown className="wbc-prose">{plan}</Markdown> : <p className="wbc-detail-note">正在写计划…</p>}
      </div>
      {!expanded && (
        <button type="button" className="wbc-plan-more" onClick={() => setExpanded(true)}>
          <span>展开全文</span><ChevronDown size={15} strokeWidth={2.4} aria-hidden="true" />
        </button>
      )}
      <AnimatePresence initial={false}>
        {pendingRequest && (
          <m.div
            className="wbc-plan-actions"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            {revising ? (
              <form className="wbc-plan-revise" onSubmit={(event) => { event.preventDefault(); sendRevision(); }}>
                <label className="wbc-visually-hidden" htmlFor={`revise-${pendingRequest.requestId}`}>想怎么改</label>
                <textarea
                  id={`revise-${pendingRequest.requestId}`}
                  className="wbc-plan-note"
                  rows={2}
                  placeholder="想怎么改？比如：先别动数据库，只改前端"
                  value={note}
                  autoFocus
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="wbc-plan-buttons">
                  <button type="button" className="wbc-button is-plain" onClick={() => setRevising(false)}>取消</button>
                  <button type="submit" className="wbc-button is-tinted">发回修改</button>
                </div>
              </form>
            ) : (
              <div className="wbc-plan-buttons">
                <button type="button" className="wbc-button is-plain" onClick={() => setRevising(true)}>继续修改</button>
                <button type="button" className="wbc-button is-filled" onClick={approve}>批准并执行</button>
              </div>
            )}
          </m.div>
        )}
      </AnimatePresence>
    </section>
  );
}
