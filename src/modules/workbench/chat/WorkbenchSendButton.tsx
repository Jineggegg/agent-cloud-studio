import { AnimatePresence, m } from 'motion/react';
import { ArrowUp, ListPlus, Square } from 'lucide-react';

const SEND_SPRING = { type: 'spring', stiffness: 600, damping: 30, mass: 0.6 } as const;

const COPY = {
  send: '发送',
  queue: '排队，等这一轮结束再发',
  stop: '停止',
} as const;

/**
 * Used by the workbench chat composers (agent and DeepSeek): one disc that is Send, Stop while a reply runs, or
 * Queue when text is typed during a run. The glyph swaps with a spring so the state change reads at a glance.
 */
export function WorkbenchSendButton({
  mode,
  disabled,
  onStop,
}: {
  mode: 'send' | 'queue' | 'stop';
  disabled?: boolean;
  // Stop is a plain button; send and queue submit the composer form.
  onStop?: () => void;
}) {
  const icon = mode === 'stop'
    ? <Square size={13} fill="currentColor" strokeWidth={0} />
    : mode === 'queue'
      ? <ListPlus size={18} strokeWidth={2.4} />
      : <ArrowUp size={19} strokeWidth={2.6} />;

  return (
    <m.button
      type={mode === 'stop' ? 'button' : 'submit'}
      className={`wbc-send is-${mode}`}
      aria-label={COPY[mode]}
      title={COPY[mode]}
      disabled={disabled}
      onClick={mode === 'stop' ? onStop : undefined}
      whileTap={disabled ? undefined : { scale: 0.84 }}
      animate={{ scale: disabled ? 0.92 : 1 }}
      transition={SEND_SPRING}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={mode}
          className="wbc-send-glyph"
          initial={{ opacity: 0, scale: 0.3, rotate: mode === 'stop' ? -45 : 0, y: mode === 'stop' ? 0 : 6 }}
          animate={{ opacity: 1, scale: 1, rotate: 0, y: 0 }}
          exit={{ opacity: 0, scale: 0.3, transition: { duration: 0.1 } }}
          transition={SEND_SPRING}
        >
          {icon}
        </m.span>
      </AnimatePresence>
    </m.button>
  );
}
