import { useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Check, MessageCircleQuestion } from 'lucide-react';

import type { PendingPermissionRequest, Question, WorkbenchPermissionDecision } from '@/shared/types';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

const SHEET_SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 } as const;
const NO_QUESTIONS: Question[] = [];

/**
 * Used by WorkbenchAgentChat in place of the composer while the agent waits on an AskUserQuestion: one question at
 * a time as an iOS list of choices (radio or multi-select), an 其他 field for a free answer, and 跳过 / 下一题 / 提交.
 * Answers travel back as the tool's updated input, the shape the runtime expects.
 */
export function WorkbenchQuestionSheet({ request, provider, onDecision }: {
  request: PendingPermissionRequest;
  provider: string;
  onDecision: WorkbenchPermissionDecision;
}) {
  const input = (request.input && typeof request.input === 'object' ? request.input : {}) as { questions?: Question[] };
  const questions = Array.isArray(input.questions) ? input.questions : NO_QUESTIONS;
  // Which question is showing.
  const [step, setStep] = useState(0);
  // Chosen option labels per question index.
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  // Free answers typed into 其他, per question index; present (even empty) while 其他 is selected.
  const [otherAnswers, setOtherAnswers] = useState<Record<number, string | undefined>>({});

  const question = questions[step];
  const isLast = step >= questions.length - 1;

  const toggle = (label: string) => {
    if (!question) return;
    setSelections((previous) => {
      const current = previous[step] ?? [];
      const next = question.multiSelect
        ? current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
        : [label];
      return { ...previous, [step]: next };
    });
    if (!question.multiSelect) setOtherAnswers((previous) => ({ ...previous, [step]: undefined }));
  };

  const toggleOther = () => {
    if (!question) return;
    const active = otherAnswers[step] !== undefined;
    setOtherAnswers((previous) => ({ ...previous, [step]: active ? undefined : '' }));
    if (!question.multiSelect && !active) setSelections((previous) => ({ ...previous, [step]: [] }));
  };

  const buildAnswers = () => {
    const answers: Record<string, string> = {};
    questions.forEach((item, index) => {
      const chosen = [...(selections[index] ?? [])];
      const other = otherAnswers[index]?.trim();
      if (other) chosen.push(other);
      if (chosen.length) answers[item.question] = chosen.join(', ');
    });
    return answers;
  };

  const submit = () => onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: buildAnswers() } });
  const skip = () => onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: {} } });

  if (!question) return null;
  const chosen = selections[step] ?? [];
  const otherActive = otherAnswers[step] !== undefined;
  const answered = chosen.length > 0 || Boolean(otherAnswers[step]?.trim());
  // The question's short topic (AskUserQuestion `header`) and the position in a multi-question prompt: `布局 · 1/2`.
  const meta = [question.header, questions.length > 1 ? `${step + 1}/${questions.length}` : ''].filter(Boolean).join(' · ');

  return (
    <m.section
      className="wbc-sheet is-question"
      aria-label={`${providerLabel(provider)} 想问你`}
      initial={{ opacity: 0, y: 28, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, transition: { duration: 0.16 } }}
      transition={SHEET_SPRING}
    >
      <div className="wbc-sheet-body">
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={step}
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -18 }}
            transition={{ duration: 0.18 }}
          >
            <div className="wbc-sheet-head">
              <span className="wbc-question-icon" aria-hidden="true"><MessageCircleQuestion size={16} strokeWidth={2.2} /></span>
              <h3 className="wbc-sheet-title" id={`question-${request.requestId}`}>{question.question}</h3>
              {meta && <span className="wbc-sheet-count">{meta}</span>}
            </div>
            <div
              className="wbc-choices"
              role={question.multiSelect ? 'group' : 'radiogroup'}
              aria-labelledby={`question-${request.requestId}`}
            >
              {question.options.map((option) => {
                const selected = chosen.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={question.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={selected}
                    className={`wbc-choice${selected ? ' is-selected' : ''}`}
                    onClick={() => toggle(option.label)}
                  >
                    <span className={`wbc-choice-mark${question.multiSelect ? ' is-square' : ''}`} aria-hidden="true">
                      {selected && <Check size={12} strokeWidth={3} />}
                    </span>
                    <span className="wbc-choice-text">
                      <span className="wbc-choice-label">{option.label}</span>
                      {option.description && <span className="wbc-choice-hint">{option.description}</span>}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={otherActive}
                className={`wbc-choice${otherActive ? ' is-selected' : ''}`}
                onClick={toggleOther}
              >
                <span className={`wbc-choice-mark${question.multiSelect ? ' is-square' : ''}`} aria-hidden="true">
                  {otherActive && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="wbc-choice-text"><span className="wbc-choice-label">其他</span></span>
              </button>
              {otherActive && (
                <input
                  className="wbc-choice-other"
                  aria-label="其他答案"
                  placeholder="写下你的答案"
                  autoFocus
                  value={otherAnswers[step] ?? ''}
                  onChange={(event) => setOtherAnswers((previous) => ({ ...previous, [step]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (isLast) submit(); else setStep(step + 1);
                    }
                  }}
                />
              )}
            </div>
          </m.div>
        </AnimatePresence>
      </div>
      <div className="wbc-sheet-actions is-two">
        {step > 0
          ? <button type="button" className="wbc-sheet-action" onClick={() => setStep(step - 1)}>上一题</button>
          : <button type="button" className="wbc-sheet-action" onClick={skip}>{questions.length > 1 ? '全部跳过' : '跳过'}</button>}
        {/* Moving on without a choice leaves that question unanswered; the agent decides it on its own. */}
        {isLast
          ? <button type="button" className="wbc-sheet-action is-primary" onClick={submit} disabled={!answered && questions.length === 1}>提交</button>
          : <button type="button" className="wbc-sheet-action is-primary" onClick={() => setStep(step + 1)}>下一题</button>}
      </div>
    </m.section>
  );
}
