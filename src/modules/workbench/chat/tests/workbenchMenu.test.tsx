import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ProviderModelOption, WorkbenchMenuSection } from '@/shared/types';
import { WorkbenchMenu } from '@/modules/workbench/chat/WorkbenchMenu';
import { modelMenuSections } from '@/modules/workbench/chat/utils/workbenchModelMenu';

// The Claude rows as the server now lists them: one per family, the 1M window as a variant.
const CLAUDE: ProviderModelOption[] = [
  { value: 'claude-fable-5-1', label: 'Fable 5.1', description: '最强的 Claude', aliases: ['fable', 'best'], longContextValue: 'claude-fable-5-1[1m]' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', description: '复杂推理和编码的首选', recommended: true, aliases: ['opus', 'default'], longContextValue: 'claude-opus-5-5[1m]' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: '速度和能力兼顾', aliases: ['sonnet'], longContextValue: 'claude-sonnet-5-5[1m]' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: '最快、最省', aliases: ['haiku'] },
];

const SECTIONS: WorkbenchMenuSection[] = [{
  key: 'mode',
  title: '权限',
  items: [{ key: 'default', label: '每次询问', checked: true, onSelect: () => undefined }],
}];

type Rect = { top: number; left: number; width: number; height: number };

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

function renderMenu(rect: Rect, props: { placement?: 'up' | 'down'; align?: 'start' | 'end'; sections?: WorkbenchMenuSection[] } = {}) {
  const view = render(
    <LazyMotion features={domMax} strict>
      <WorkbenchMenu label="模型" triggerClassName="wbc-chip" trigger="Opus 5.5" sections={props.sections ?? SECTIONS} placement={props.placement} align={props.align} />
    </LazyMotion>,
  );
  const trigger = screen.getByRole('button', { name: '模型' });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
  );
  return { ...view, trigger, open: () => fireEvent.click(trigger) };
}

beforeEach(() => setViewport(1024, 768));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  setViewport(1024, 768);
});

describe('the menu opens anchored to the button that opened it', () => {
  test('a header pill menu drops down from the pill, growing from its centre', () => {
    const { open } = renderMenu({ top: 10, left: 300, width: 120, height: 40 });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    // Portalled out of the chat column, so its overflow and containment cannot clip or re-anchor it.
    expect(menu.closest('.wbc-layer')?.parentElement).toBe(document.body);
    expect(menu.className).toContain('is-below');
    expect(menu.style.top).toBe('56px');
    expect(menu.style.left).toBe('300px');
    expect(menu.style.bottom).toBe('');
    expect(menu.style.transformOrigin).toBe('60px top');
  });

  test('a pill near the bottom of the screen flips the menu above it', () => {
    const { open } = renderMenu({ top: 700, left: 300, width: 120, height: 40 });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    expect(menu.className).toContain('is-above');
    expect(menu.style.bottom).toBe(`${768 - 700 + 6}px`);
    expect(menu.style.top).toBe('');
    expect(menu.style.transformOrigin).toBe('60px bottom');
    expect(Number.parseInt(menu.style.maxHeight, 10)).toBeLessThanOrEqual(700 - 6 - 8);
  });

  test('a composer chip opens upward, and flips down once its real height does not fit above', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.getAttribute('role') === 'menu' ? 400 : 0; },
    });
    const { open } = renderMenu({ top: 300, left: 200, width: 100, height: 32 }, { placement: 'up' });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    // 286px above is too little for 400px of rows; 414px below is enough.
    expect(menu.className).toContain('is-below');
    expect(menu.style.top).toBe(`${300 + 32 + 6}px`);
  });

  test('a composer chip low on the screen stays above it', () => {
    const { open } = renderMenu({ top: 690, left: 200, width: 100, height: 32 }, { placement: 'up' });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    expect(menu.className).toContain('is-above');
    expect(menu.style.bottom).toBe(`${768 - 690 + 6}px`);
  });

  test('stays inside the viewport at the right edge, the origin still pointing at the trigger', () => {
    const { open } = renderMenu({ top: 10, left: 960, width: 56, height: 40 });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    expect(menu.style.left).toBe(`${1024 - 8 - 300}px`);
    expect(menu.style.width).toBe('300px');
    expect(menu.style.transformOrigin).toBe(`${988 - (1024 - 8 - 300)}px top`);
  });

  test('on a phone-wide screen it becomes a bottom sheet with a scrim that closes it', () => {
    setViewport(390, 844);
    const { open } = renderMenu({ top: 780, left: 120, width: 100, height: 32 }, { placement: 'up' });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    expect(menu.className).toContain('is-sheet');
    expect(menu.style.top).toBe('');
    const scrim = document.querySelector('.wbc-menu-scrim');
    expect(scrim).toBeTruthy();
    fireEvent.pointerDown(scrim!);
    expect(screen.getByRole('button', { name: '模型' }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the simplified model list', () => {
  test('one row per family with its version, a one-line description and 推荐 on the recommended one', () => {
    const { open } = renderMenu({ top: 10, left: 300, width: 120, height: 40 }, {
      sections: modelMenuSections(CLAUDE, 'claude-opus-5-5', () => undefined),
    });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    const rows = within(menu).getAllByRole('menuitemradio');
    expect(rows.map((row) => row.getAttribute('aria-labelledby') && document.getElementById(row.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
    const opus = within(menu).getByRole('menuitemradio', { name: 'Opus 5.5' });
    expect(opus.getAttribute('aria-checked')).toBe('true');
    expect(within(opus).getByText('推荐')).toBeTruthy();
    expect(within(opus).getByText('复杂推理和编码的首选')).toBeTruthy();
    expect(within(menu).queryByText(/Default|Best available|1M context\)/)).toBeNull();
  });

  test('a saved legacy value lands on its row, and the 1M switch reflects it and toggles in place', () => {
    const onSelect = vi.fn();
    const { open } = renderMenu({ top: 10, left: 300, width: 120, height: 40 }, {
      sections: modelMenuSections(CLAUDE, 'opus[1m]', onSelect),
    });
    open();
    const menu = screen.getByRole('menu', { name: '模型' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Opus 5.5' }).getAttribute('aria-checked')).toBe('true');
    const toggle = within(menu).getByRole('menuitemcheckbox', { name: '1M 上下文' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    expect(onSelect).toHaveBeenLastCalledWith('claude-opus-5-5');
    // A switch is a setting inside the menu: the menu stays open.
    expect(screen.getByRole('menu', { name: '模型' })).toBeTruthy();

    // Another family keeps the 1M window when it has one.
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Sonnet 5.5' }));
    expect(onSelect).toHaveBeenLastCalledWith('claude-sonnet-5-5[1m]');
  });

  test('the switch turns the 1M window on, and models without one show no switch', () => {
    const onSelect = vi.fn();
    const first = renderMenu({ top: 10, left: 300, width: 120, height: 40 }, {
      sections: modelMenuSections(CLAUDE, 'sonnet', onSelect),
    });
    first.open();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '1M 上下文' }));
    expect(onSelect).toHaveBeenLastCalledWith('claude-sonnet-5-5[1m]');
    first.unmount();

    const second = renderMenu({ top: 10, left: 300, width: 120, height: 40 }, {
      sections: modelMenuSections(CLAUDE, 'claude-haiku-4-5-20251001', onSelect),
    });
    second.open();
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
  });
});
