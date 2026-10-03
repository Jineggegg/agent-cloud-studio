import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronRight, CircleHelp, Gauge, RotateCcw } from 'lucide-react';

import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { clampEffortLevel, reasoningEffortLabel } from '@/shared/utils';
import { useAnchoredPopover } from '@/modules/workbench/chat/hooks/useAnchoredPopover';
import { WorkbenchFloatingPanel } from '@/modules/workbench/chat/WorkbenchFloatingPanel';

type WorkbenchEffortControlProps = {
  // The current choice: a level, or `default` (the model decides, shown at its recommended level).
  effort: string;
  // The levels the selected model accepts, least to most thinking.
  levels: string[];
  // The model's recommended level (its catalog default), marked 推荐 and the target of the reset button.
  recommended?: string;
  // The selected model's name, shown under the title; its row opens the model menu.
  modelLabel: string;
  onSelectEffort: (effort: string) => void;
  onOpenModels: () => void;
};

// Keys that move the slider one stop, and which way.
const KEY_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1,
};
// Fraction of the rail at which stop `index` of `count` sits.
const stopFraction = (index: number, count: number) => (count > 1 ? index / (count - 1) : 0.5);
const asPercent = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

/**
 * Used by the workbench chat's composer as the reasoning-effort control beside the model chip: a chip naming the
 * level that opens a popover anchored to it (useAnchoredPopover, a sheet on a phone). The popover titles the level in
 * Chinese, names the model (its row opens the model menu), resets to the recommended level, and offers a discrete
 * slider from 更快 to 更聪明 with one stop per level the model supports and 推荐 under the recommended stop. The
 * slider follows a drag and snaps to the nearest stop on release (a tap picks the nearest stop), takes the arrow,
 * Home and End keys, and is a role="slider" with the level as its aria-valuetext.
 */
export function WorkbenchEffortControl({
  effort,
  levels,
  recommended,
  modelLabel,
  onSelectEffort,
  onOpenModels,
}: WorkbenchEffortControlProps) {
  // Whether the popover is showing; owned here because only the chip opens it.
  const [open, setOpen] = useState(false);
  // Where the thumb is while a finger or pointer drags it (0–1 along the rail); null when it rests on a stop.
  const [dragFraction, setDragFraction] = useState<number | null>(null);
  // Whether the one-line explanation under the ? button is showing.
  const [helpShown, setHelpShown] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const helpId = useId();
  const layout = useAnchoredPopover({
    open,
    triggerRef,
    panelRef,
    preferredSide: 'above',
    align: 'start',
    width: 320,
    onDismiss: () => setOpen(false),
  });

  const recommendedIndex = recommended ? levels.indexOf(recommended) : -1;
  // `default` rests on the recommended stop; a level the model lacks shows as its nearest supported one.
  const clamped = clampEffortLevel(effort, levels);
  const currentIndex = clamped !== DEFAULT_EFFORT_VALUE ? levels.indexOf(clamped)
    : recommendedIndex >= 0 ? recommendedIndex : -1;
  const currentLevel = currentIndex >= 0 ? levels[currentIndex] : null;
  const title = currentLevel ? reasoningEffortLabel(currentLevel) : reasoningEffortLabel(DEFAULT_EFFORT_VALUE);
  const resetTarget = recommendedIndex >= 0 ? levels[recommendedIndex] : DEFAULT_EFFORT_VALUE;
  const isAtRecommended = effort === resetTarget || (effort === DEFAULT_EFFORT_VALUE && recommendedIndex >= 0);
  const thumbIndex = currentIndex >= 0 ? currentIndex : Math.floor((levels.length - 1) / 2);
  const thumbFraction = dragFraction ?? stopFraction(thumbIndex, levels.length);

  const panelShown = layout !== null;
  useEffect(() => {
    if (!panelShown) return undefined;
    // Keyboard users land on the slider; without scrolling, so iOS does not pan while the popover grows in.
    const frame = requestAnimationFrame(() => sliderRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [panelShown]);

  if (levels.length === 0) return null;

  const select = (index: number) => {
    const level = levels[Math.min(Math.max(index, 0), levels.length - 1)];
    if (level !== effort) onSelectEffort(level);
  };
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const fractionAt = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return thumbFraction;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  };
  const nearestIndex = (fraction: number) => Math.round(fraction * (levels.length - 1));
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sliderRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragFraction(fractionAt(event.clientX));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragFraction !== null) setDragFraction(fractionAt(event.clientX));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragFraction === null) return;
    // A tap and the end of a drag both land on the nearest stop; the thumb springs there.
    select(nearestIndex(fractionAt(event.clientX)));
    setDragFraction(null);
  };

  const onSliderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEPS[event.key];
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'Home') select(0);
    else if (event.key === 'End') select(levels.length - 1);
    else select(thumbIndex + (step ?? 0));
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div className="wbc-menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="wbc-chip"
        aria-label={`思考强度：${title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelShown ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Gauge size={14} strokeWidth={2.2} aria-hidden="true" />
        <span>{title}</span>
      </button>
      <WorkbenchFloatingPanel layout={layout} panelRef={panelRef} id={panelId} role="dialog" label="思考强度" className="wbc-menu wbc-effort" onKeyDown={onPanelKeyDown}>
        <div className="wbc-effort-head">
          <div className="wbc-effort-heading">
            <strong className="wbc-effort-title">{title}</strong>
            <button
              type="button"
              className="wbc-effort-model"
              onClick={() => {
                setOpen(false);
                onOpenModels();
              }}
            >
              <span>{modelLabel}</span>
              <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="wbc-effort-icon"
            aria-label="思考强度是什么"
            aria-expanded={helpShown}
            aria-controls={helpId}
            onClick={() => setHelpShown((value) => !value)}
          >
            <CircleHelp size={17} strokeWidth={2.1} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="wbc-effort-icon"
            aria-label="恢复推荐强度"
            title="恢复推荐强度"
            disabled={isAtRecommended}
            onClick={() => onSelectEffort(resetTarget)}
          >
            <RotateCcw size={17} strokeWidth={2.1} aria-hidden="true" />
          </button>
        </div>
        {helpShown && (
          <p className="wbc-effort-help" id={helpId}>强度越高，模型想得越久：难题更可靠，但回答更慢、用量更多。</p>
        )}

        <div className="wbc-effort-scale" aria-hidden="true"><span>更快</span><span>更聪明</span></div>
        <div
          ref={sliderRef}
          className={`wbc-slider${dragFraction !== null ? ' is-dragging' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label="思考强度"
          aria-valuemin={0}
          aria-valuemax={levels.length - 1}
          aria-valuenow={thumbIndex}
          aria-valuetext={`${title}${thumbIndex === recommendedIndex ? '（推荐）' : ''}`}
          onKeyDown={onSliderKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDragFraction(null)}
        >
          <div className="wbc-slider-rail" ref={railRef}>
            <span className="wbc-slider-track" />
            <span className="wbc-slider-fill" style={{ width: asPercent(thumbFraction) }} />
            {levels.map((level, index) => (
              <span
                key={level}
                className={`wbc-slider-stop${stopFraction(index, levels.length) <= thumbFraction + 1e-6 ? ' is-filled' : ''}`}
                style={{ left: asPercent(stopFraction(index, levels.length)) }}
              />
            ))}
            <span className="wbc-slider-thumb" style={{ left: asPercent(thumbFraction) }} />
          </div>
        </div>
        <div className="wbc-slider-marks" aria-hidden="true">
          {recommendedIndex >= 0 && (
            <span className="wbc-slider-recommended" style={{ left: asPercent(stopFraction(recommendedIndex, levels.length)) }}>推荐</span>
          )}
        </div>
      </WorkbenchFloatingPanel>
    </div>
  );
}
