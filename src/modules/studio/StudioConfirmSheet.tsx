import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

// Matches the CSS exit animation so the alert fades out before it unmounts.
const EXIT_MS = 180;

function exitDelay() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS;
}

/**
 * Used by StudioPage, StudioConnections, StudioSettingsMail (removing a mail
 * account), the workbench module (deleting a session, handing a conversation to another model) and StudioMemory
 * (deleting a note) in place of window.confirm, which cannot be styled and blocks the iOS
 * standalone web app. Rendered through a portal so animated ancestors never
 * become the containing block. The confirm action reads as destructive (red) unless `destructive` is false.
 */
export function StudioConfirmSheet({ title, message, confirmLabel, onConfirm, onCancel, destructive = true }: {
  title: string; message?: string; confirmLabel: string;
  onConfirm: () => void; onCancel: () => void; destructive?: boolean;
}) {
  // The exit animation runs before the chosen callback unmounts the alert.
  const [closing, setClosing] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus starts on the safe choice and returns to the trigger afterwards.
    const previous = document.activeElement as HTMLElement | null;
    cancelButton.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const finish = (callback: () => void) => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(callback, exitDelay());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); finish(onCancel); }
    if (event.key === 'Tab') {
      // Keep keyboard focus inside the two alert actions.
      event.preventDefault();
      (document.activeElement === cancelButton.current ? confirmButton : cancelButton).current?.focus();
    }
  };

  return createPortal(
    <div className={`studio-layer ${closing ? 'closing' : ''}`} onKeyDown={onKeyDown}>
      <div className="sheet-scrim" aria-hidden="true" onClick={() => finish(onCancel)} />
      <div className="sheet-panel" role="alertdialog" aria-modal="true" aria-labelledby="studio-confirm-title" aria-describedby={message ? 'studio-confirm-message' : undefined}>
        <div className="sheet-text">
          <h2 id="studio-confirm-title">{title}</h2>
          {message && <p id="studio-confirm-message">{message}</p>}
        </div>
        <div className="sheet-actions">
          <button ref={cancelButton} type="button" className="sheet-action" onClick={() => finish(onCancel)}>取消</button>
          <button ref={confirmButton} type="button" className={`sheet-action ${destructive ? 'destructive' : 'is-default'}`} onClick={() => finish(onConfirm)}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
