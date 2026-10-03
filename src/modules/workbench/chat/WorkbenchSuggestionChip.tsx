import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { Sparkles } from 'lucide-react';

// The chip grows in from nothing, so the composer card's height follows it instead of jumping.
const CHIP_SPRING = { type: 'spring', stiffness: 460, damping: 38, mass: 0.8 } as const;
// With reduced motion the height changes at once and only the opacity fades.
const CHIP_REDUCED = { height: { duration: 0 }, opacity: { duration: 0.15 } } as const;

/**
 * Used by the workbench composers (WorkbenchComposer, WorkbenchDeepSeekChat) just above their textarea while the field
 * holds text (typed or dictated), where the faint in-field suggestion cannot show: the suggested next message as one
 * ellipsised line. Tapping its text puts it in the field in place of the draft; 发送 sends it as it is, leaving the
 * draft out. It sits in the card's flow, so it never covers the text being written.
 */
export function WorkbenchSuggestionChip({ suggestion, sendDisabled, onFill, onSend }: {
  // The suggestion to offer, or null to hide the chip.
  suggestion: string | null;
  // True while a send cannot go out (one is still being delivered).
  sendDisabled?: boolean;
  onFill: () => void;
  onSend: () => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {suggestion && (
        <m.div
          key="suggestion-chip"
          className="wbc-suggestion-chip-wrap"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduceMotion ? CHIP_REDUCED : CHIP_SPRING}
        >
          <div className="wbc-suggestion-chip" role="group" aria-label="输入建议">
            <button
              type="button"
              className="wbc-suggestion-chip-fill"
              aria-label={`用建议替换输入：${suggestion}`}
              title={suggestion}
              // Keeps the field focused (and the iPad keyboard up) through the tap.
              onMouseDown={(event) => event.preventDefault()}
              onClick={onFill}
            >
              <Sparkles size={13} strokeWidth={2.2} aria-hidden="true" />
              <span className="wbc-suggestion-chip-label">建议：</span>
              <span className="wbc-suggestion-chip-text">{suggestion}</span>
            </button>
            <button
              type="button"
              className="wbc-suggestion-chip-send"
              aria-label={`发送建议：${suggestion}`}
              disabled={sendDisabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onSend}
            >
              发送
            </button>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
