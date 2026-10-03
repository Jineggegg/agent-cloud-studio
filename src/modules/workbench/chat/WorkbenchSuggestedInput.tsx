import type { ReactNode } from 'react';

/**
 * Used by the workbench composers (WorkbenchComposer, WorkbenchDeepSeekChat) around their textarea: while the input
 * is empty and a suggested next message exists, the suggestion shows in faint tinted text where the placeholder
 * would be, and Send sends it as it is. Typing hides it; clearing the field brings it back.
 * The suggestion sets the field's height, so a two-line suggestion is never cut off.
 */
export function WorkbenchSuggestedInput({ suggestion, children }: {
  // The suggestion to show, or null (the textarea then shows its own placeholder).
  suggestion: string | null;
  children: ReactNode;
}) {
  return (
    <div className={`wbc-input-wrap${suggestion ? ' has-suggestion' : ''}`}>
      {suggestion && <div className="wbc-suggestion" aria-hidden="true">{suggestion}</div>}
      {children}
    </div>
  );
}
