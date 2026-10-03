import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ScanFace } from 'lucide-react';

import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-orders.css';

// Matches the alert's CSS exit animation in studio.css.
const EXIT_MS = 180;

function exitDelay() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS;
}

/**
 * Used by StudioT212CapsEditor (raising caps) and StudioT212TradingModeSelector (adding accounts that may trade) as
 * the review step before Face ID / Touch ID: what changes, from → to, then one confirm tap that starts the
 * authenticator inside that user gesture. Cancel, the scrim and Escape close it unless verification is running;
 * focus starts on 取消 and stays inside the alert.
 */
export function StudioT212ReviewSheet({ title, message, rows, verifying, onConfirm, onCancel }: {
  title: string; message: string; rows: { label: string; value: string }[]; verifying: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  // The exit animation runs before a cancel unmounts the alert.
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    // Focus starts on the safe choice and returns to the trigger afterwards.
    const previous = document.activeElement as HTMLElement | null;
    cancelButton.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const cancel = () => {
    if (verifying || closing) return;
    setClosing(true);
    window.setTimeout(onCancel, exitDelay());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (event.key !== 'Tab' || !panel.current) return;
    // Keep keyboard focus inside the alert.
    const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return createPortal(
    <div className={`studio-layer ${closing ? 'closing' : ''}`} onKeyDown={onKeyDown}>
      <div className="sheet-scrim" aria-hidden="true" onClick={cancel} />
      <div ref={panel} className="sheet-panel t212-review" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}
        aria-busy={verifying || undefined}>
        <div className="sheet-text">
          <h2 id={titleId}>{title}</h2>
          <p id={messageId}>{message}</p>
        </div>
        <dl className="t212-review-values">
          {rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        </dl>
        <div className="sheet-actions">
          <button type="button" className="sheet-action t212-review-confirm" disabled={verifying || closing} onClick={onConfirm}>
            {verifying ? <StudioSpinner size={16} /> : <ScanFace size={18} aria-hidden="true" />}用面容 ID / 触控 ID 确认
          </button>
          <button ref={cancelButton} type="button" className="sheet-action" disabled={verifying || closing} onClick={cancel}>取消</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
