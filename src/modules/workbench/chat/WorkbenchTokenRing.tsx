import { m } from 'motion/react';

const RING_SIZE = 22;
const RING_STROKE = 3;

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

/**
 * Used by the workbench chat header: how full the session's context window is, as a small ring that fills with a
 * spring. Reads the engine's token budget (`used` / `total`, as Claude and Codex report it); renders nothing until a
 * budget with a window size exists. Pressing it opens the inherited token-usage sheet.
 */
export function WorkbenchTokenRing({ usage, onOpen }: { usage: Record<string, unknown> | null; onOpen?: () => void }) {
  const total = readNumber(usage?.total);
  const breakdown = usage?.breakdown && typeof usage.breakdown === 'object' ? usage.breakdown as Record<string, unknown> : null;
  const used = readNumber(usage?.used) || readNumber(breakdown?.input) + readNumber(breakdown?.output);
  if (!total || !used) return null;

  const ratio = Math.min(1, used / total);
  const percent = Math.round(ratio * 100);
  const level = ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'high' : 'normal';
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const description = `上下文已用 ${percent}%（${formatTokens(used)} / ${formatTokens(total)}）`;

  return (
    <button type="button" className={`wbc-ring is-${level}`} onClick={onOpen} aria-label={description} title={description}>
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
  );
}
