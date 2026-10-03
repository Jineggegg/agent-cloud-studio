import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { m } from 'motion/react';

import { useAnchoredPopover } from '@/modules/workbench/chat/hooks/useAnchoredPopover';
import { WorkbenchFloatingPanel } from '@/modules/workbench/chat/WorkbenchFloatingPanel';
import { providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

const RING_SIZE = 22;
const RING_STROKE = 3;
// The usage card's width; under the header and flush with the ring's right edge, clear of the conversation's centre.
const CARD_WIDTH = 288;
// From here the ring turns orange and the card explains compaction; from CRITICAL_RATIO it turns red.
const HIGH_RATIO = 0.8;
const CRITICAL_RATIO = 0.95;

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** `68K`, `1.2M`: context sizes at a glance. */
const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
};

/** `41,820`: an exact count for the card's rows. */
const formatExact = (value: number): string => Math.round(value).toLocaleString('en-US');

type WorkbenchTokenRingProps = {
  // The engine's token budget, as Claude and Codex report it: `used` / `total`, the latest request's input and
  // output, and (Claude) its cache reads and writes.
  usage: Record<string, unknown> | null;
  provider: string;
  modelLabel: string;
};

/**
 * Used by the workbench chat header (WorkbenchAgentChat's trailing status): how full the session's context window
 * is, as a small ring that fills with a spring. Renders nothing until a budget with a window size exists. Pressing
 * it blooms a small card out of the ring (a sheet on a phone): context used of the window, the model, the latest
 * request's input, output and cache tokens, and a line about compaction once the window is nearly full. A press
 * outside, Escape or a second press closes it, shrinking back into the ring.
 */
export function WorkbenchTokenRing({ usage, provider, modelLabel }: WorkbenchTokenRingProps) {
  // Whether the usage card is showing; owned here because only the ring opens it.
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const layout = useAnchoredPopover({
    open,
    triggerRef,
    panelRef,
    preferredSide: 'below',
    align: 'end',
    width: CARD_WIDTH,
    onDismiss: () => setOpen(false),
  });

  const panelShown = layout !== null;
  useEffect(() => {
    if (!panelShown) return undefined;
    // The card has no control of its own: it takes focus so Escape and screen readers find it, without iOS panning.
    const frame = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [panelShown]);

  const total = readNumber(usage?.total);
  const breakdown = usage?.breakdown && typeof usage.breakdown === 'object' ? usage.breakdown as Record<string, unknown> : null;
  const inputTokens = readNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readNumber(usage?.outputTokens ?? breakdown?.output);
  const used = readNumber(usage?.used) || inputTokens + outputTokens;
  if (!total || !used) {
    // A budget reset (new chat, switched session) hides the ring; a card left open would bloom again with the next one.
    if (open) setOpen(false);
    return null;
  }

  const cacheRead = readNumber(usage?.cacheReadTokens);
  const cacheWrite = readNumber(usage?.cacheCreationTokens);
  const ratio = Math.min(1, used / total);
  const percent = Math.round(ratio * 100);
  const level = ratio >= CRITICAL_RATIO ? 'critical' : ratio >= HIGH_RATIO ? 'high' : 'normal';
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const description = `上下文已用 ${percent}%（${formatTokens(used)} / ${formatTokens(total)}）`;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  // Escape closes the card (from the card or the ring) and is spent, so the column does not also stop the run.
  const onEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div className="wbc-menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className={`wbc-ring is-${level}`}
        aria-label={description}
        title={description}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelShown ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onEscape}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
          <circle className="wbc-ring-track" cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={radius} strokeWidth={RING_STROKE} />
          <m.circle
            className="wbc-ring-fill"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={radius}
            strokeWidth={RING_STROKE}
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: circumference * (1 - ratio) }}
            transition={{ type: 'spring', stiffness: 70, damping: 18 }}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
        <span className="wbc-ring-value">{percent}%</span>
      </button>
      <WorkbenchFloatingPanel
        layout={layout}
        panelRef={panelRef}
        id={panelId}
        role="dialog"
        label="上下文用量"
        className={`wbc-menu wbc-usage is-${level}`}
        onKeyDown={onEscape}
        tabIndex={-1}
        bloom
      >
        <div className="wbc-usage-head">
          <span className="wbc-usage-title">上下文</span>
          <strong className="wbc-usage-percent">{percent}%</strong>
        </div>
        <p className="wbc-usage-figure">{formatTokens(used)} / {formatTokens(total)} tokens</p>
        <div className="wbc-usage-meter" aria-hidden="true">
          <m.span initial={{ scaleX: 0 }} animate={{ scaleX: ratio }} transition={{ type: 'spring', stiffness: 160, damping: 24 }} />
        </div>
        <dl className="wbc-usage-rows">
          <div><dt>模型</dt><dd>{providerLabel(provider)} · {modelLabel}</dd></div>
          {inputTokens > 0 && <div><dt>输入</dt><dd>{formatExact(inputTokens)}</dd></div>}
          {outputTokens > 0 && <div><dt>输出</dt><dd>{formatExact(outputTokens)}</dd></div>}
          {(cacheRead > 0 || cacheWrite > 0) && (
            <div><dt>缓存</dt><dd>读 {formatExact(cacheRead)} · 写 {formatExact(cacheWrite)}</dd></div>
          )}
        </dl>
        {/* Claude reports each request's own prompt (cache included); Codex's figures are its own totals. */}
        {provider === 'claude' && inputTokens > 0 && <p className="wbc-usage-note">按最近一次请求统计，输入含缓存。</p>}
        {level !== 'normal' && (
          <p className="wbc-usage-hint" role="note">上下文快满了：接近上限时，较早的对话会被自动压缩成摘要。</p>
        )}
      </WorkbenchFloatingPanel>
    </div>
  );
}
