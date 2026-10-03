import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { WorkbenchEffortControl } from '@/modules/workbench/chat/WorkbenchEffortControl';

// The levels the catalog lists per model: Claude's families, and Codex models with and without `ultra`.
const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const GPT_6_LUNA_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GPT_5_5_LEVELS = ['low', 'medium', 'high', 'xhigh'];

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

function renderControl(props: Partial<Parameters<typeof WorkbenchEffortControl>[0]> = {}, triggerTop = 700) {
  const onSelectEffort = vi.fn();
  const onOpenModels = vi.fn();
  const view = render(
    <LazyMotion features={domMax} strict>
      <WorkbenchEffortControl
        effort="high"
        levels={CLAUDE_LEVELS}
        recommended="high"
        modelLabel="Opus 5.5"
        onSelectEffort={onSelectEffort}
        onOpenModels={onOpenModels}
        {...props}
      />
    </LazyMotion>,
  );
  const trigger = screen.getByRole('button', { name: /^思考强度：/ });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 420, y: triggerTop, width: 64, height: 32 }));
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '思考强度' });
  const slider = within(dialog).getByRole('slider', { name: '思考强度' });
  return { ...view, trigger, dialog, slider, onSelectEffort, onOpenModels };
}

// jsdom has no PointerEvent; without one the pointer handlers would see no button, pointer id or position.
const nativePointerEvent = window.PointerEvent;
beforeAll(() => {
  if (nativePointerEvent) return;
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
});
afterAll(() => {
  window.PointerEvent = nativePointerEvent;
});

const leftPercent = (element: Element | null) => Number.parseFloat((element as HTMLElement).style.left);

beforeEach(() => setViewport(1024, 768));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setViewport(1024, 768);
});

describe('the effort popover', () => {
  test('opens anchored above its chip, growing from it, and flips below near the top', () => {
    const { dialog, trigger } = renderControl();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.className).toContain('is-above');
    expect(dialog.style.bottom).toBe(`${768 - 700 + 6}px`);
    expect(dialog.style.left).toBe('420px');
    expect(dialog.style.transformOrigin).toBe('32px bottom');
    cleanup();

    const low = renderControl({}, 20);
    expect(low.dialog.className).toContain('is-below');
    expect(low.dialog.style.top).toBe(`${20 + 32 + 6}px`);
  });

  test('titles the level in Chinese and names the model, whose row opens the model menu', () => {
    const { dialog, trigger, onOpenModels } = renderControl({ effort: 'xhigh' });
    expect(trigger.textContent).toContain('极高');
    expect(within(dialog).getByText('极高', { selector: 'strong' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Opus 5\.5/ }));
    expect(onOpenModels).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the effort slider', () => {
  test('has one stop per level the model supports, labelled from 更快 to 更聪明, 推荐 under the recommended one', () => {
    const claude = renderControl();
    expect(claude.slider.getAttribute('aria-valuemax')).toBe(String(CLAUDE_LEVELS.length - 1));
    expect(claude.dialog.querySelectorAll('.wbc-slider-stop')).toHaveLength(6);
    expect(within(claude.dialog).getByText('更快')).toBeTruthy();
    expect(within(claude.dialog).getByText('更聪明')).toBeTruthy();
    expect(leftPercent(within(claude.dialog).getByText('推荐'))).toBe(40);
    expect(claude.slider.getAttribute('aria-valuetext')).toBe('高（推荐）');
    cleanup();

    const luna = renderControl({ levels: GPT_6_LUNA_LEVELS, recommended: 'medium', effort: 'max', modelLabel: 'GPT-6 Luna' });
    expect(luna.dialog.querySelectorAll('.wbc-slider-stop')).toHaveLength(5);
    expect(luna.slider.getAttribute('aria-valuenow')).toBe('4');
    expect(luna.slider.getAttribute('aria-valuetext')).toBe('最高');
    cleanup();

    const sol = renderControl({ levels: [...GPT_6_LUNA_LEVELS, 'ultra'], recommended: 'low', effort: 'ultra' });
    expect(sol.slider.getAttribute('aria-valuetext')).toBe('超高');
  });

  test('a level the model lacks shows on its nearest stop; the default sits on the recommended stop', () => {
    const clamped = renderControl({ levels: GPT_5_5_LEVELS, recommended: 'medium', effort: 'ultra' });
    expect(clamped.slider.getAttribute('aria-valuetext')).toBe('极高');
    cleanup();

    const automatic = renderControl({ effort: 'default' });
    expect(automatic.slider.getAttribute('aria-valuenow')).toBe('2');
    expect(automatic.slider.getAttribute('aria-valuetext')).toBe('高（推荐）');
  });

  test('arrow, Home and End keys step through the stops', () => {
    const { slider, onSelectEffort } = renderControl();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSelectEffort).toHaveBeenLastCalledWith('xhigh');
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(onSelectEffort).toHaveBeenLastCalledWith('medium');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onSelectEffort).toHaveBeenLastCalledWith('ultracode');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSelectEffort).toHaveBeenLastCalledWith('low');
  });

  test('a tap picks the nearest stop, and a drag snaps to the stop nearest where it is let go', () => {
    const { slider, dialog, onSelectEffort } = renderControl();
    const rail = dialog.querySelector('.wbc-slider-rail') as HTMLElement;
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 100, y: 0, width: 200, height: 34 }));

    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 296 });
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: 296 });
    expect(onSelectEffort).toHaveBeenLastCalledWith('ultracode');

    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 110 });
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 150 });
    // While dragging the thumb follows the pointer instead of springing between stops.
    expect(slider.className).toContain('is-dragging');
    expect(leftPercent(dialog.querySelector('.wbc-slider-thumb'))).toBe(25);
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 236 });
    fireEvent.pointerUp(slider, { pointerId: 1, clientX: 236 });
    expect(onSelectEffort).toHaveBeenLastCalledWith('xhigh');
    expect(slider.className).not.toContain('is-dragging');
  });

  test('↺ resets to the recommended level, and is off when already there', () => {
    const { dialog, onSelectEffort } = renderControl({ effort: 'max' });
    const reset = within(dialog).getByRole('button', { name: '恢复推荐强度' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(onSelectEffort).toHaveBeenLastCalledWith('high');
    cleanup();

    for (const effort of ['high', 'default']) {
      const view = renderControl({ effort });
      expect((within(view.dialog).getByRole('button', { name: '恢复推荐强度' }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }
  });

  test('a model without effort levels shows no control', () => {
    render(
      <LazyMotion features={domMax} strict>
        <WorkbenchEffortControl effort="default" levels={[]} modelLabel="Haiku 4.5" onSelectEffort={vi.fn()} onOpenModels={vi.fn()} />
      </LazyMotion>,
    );
    expect(screen.queryByRole('button', { name: /^思考强度/ })).toBeNull();
  });
});
