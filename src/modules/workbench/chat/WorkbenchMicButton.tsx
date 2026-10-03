import { Mic } from 'lucide-react';

/**
 * Used by the workbench chat composers (WorkbenchComposer and WorkbenchDeepSeekChat) beside the attachment button:
 * the dictation switch. Off it is a plain microphone; on, it turns red with a soft pulse until tapped again.
 * Rendered only where the browser has speech recognition (useSpeechDictation `supported`).
 */
export function WorkbenchMicButton({ listening, disabled, onToggle }: { listening: boolean; disabled?: boolean; onToggle: () => void }) {
  const label = listening ? '停止语音输入' : '语音输入';
  return (
    <button
      type="button"
      className={`wbc-tool-button wbc-mic${listening ? ' is-listening' : ''}`}
      aria-label={label}
      aria-pressed={listening}
      title={label}
      disabled={disabled}
      onClick={onToggle}
    >
      <Mic size={18} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
