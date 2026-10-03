import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import type { ProviderModelOption } from '@/shared/types';

const EFFORT = { default: 'high', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] };
const CLAUDE: ProviderModelOption[] = [
  { value: 'claude-fable-5-1', label: 'Fable 5.1', description: '最强的 Claude', aliases: ['fable', 'best'], longContextValue: 'claude-fable-5-1[1m]', effort: EFFORT },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', description: '复杂推理和编码的首选', recommended: true, aliases: ['opus', 'default'], longContextValue: 'claude-opus-5-5[1m]', effort: EFFORT },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: '速度和能力兼顾', aliases: ['sonnet'], longContextValue: 'claude-sonnet-5-5[1m]', effort: EFFORT },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: '最快、最省', aliases: ['haiku'] },
];

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

function renderMenu(model: string, triggerTop: number, onSelectModel = vi.fn()) {
  // The trigger is measured on click, before the menu exists; every button reports the trigger's box.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 600, y: triggerTop, width: 120, height: 32 }),
  );
  render(
    <ComposerModelMenu
      effort="default"
      effortOptions={EFFORT.values}
      onSelectEffort={() => undefined}
      model={model}
      modelOptions={CLAUDE}
      onSelectModel={onSelectModel}
      modelsLoading={false}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Select model and reasoning effort' }));
  return { menu: screen.getByRole('menu'), onSelectModel };
}

beforeEach(() => setViewport(1024, 768));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the composer model menu', () => {
  test('opens above its button, right-aligned to it, growing from it', () => {
    const { menu } = renderMenu('claude-opus-5-5', 700);
    expect(menu.dataset.side).toBe('above');
    expect(menu.style.bottom).toBe(`${768 - 700 + 6}px`);
    expect(menu.style.left).toBe(`${720 - 320}px`);
    expect(menu.style.transformOrigin).toBe('260px bottom');
  });

  test('flips below its button when there is no room above', () => {
    const { menu } = renderMenu('claude-opus-5-5', 40);
    expect(menu.dataset.side).toBe('below');
    expect(menu.style.top).toBe(`${40 + 32 + 6}px`);
    expect(menu.style.bottom).toBe('');
  });

  test('lists one row per family with descriptions and the recommended tag, and a legacy value lands on its row', () => {
    const { menu } = renderMenu('opus[1m]', 700);
    // The trigger names the row and the 1M window the old value meant.
    expect(screen.getByRole('button', { name: 'Select model and reasoning effort' }).textContent).toContain('Opus 5.5 1M');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Opus 5\.5 1M/ }));

    const rows = within(menu).getAllByRole('menuitemradio').filter((row) => /\d\.\d/.test(row.textContent ?? ''));
    expect(rows.map((row) => row.querySelector('.truncate')?.firstChild?.textContent)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
    const opus = rows[1];
    expect(opus.getAttribute('aria-checked')).toBe('true');
    expect(within(opus).getByText('Recommended')).toBeTruthy();
    expect(within(opus).getByText('复杂推理和编码的首选')).toBeTruthy();
  });

  test('the 1M switch toggles the variant in place, and switching family keeps it', () => {
    const { menu, onSelectModel } = renderMenu('claude-opus-5-5[1m]', 700);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Opus 5\.5 1M/ }));
    const toggle = within(menu).getByRole('menuitemcheckbox', { name: /1M context/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onSelectModel).toHaveBeenLastCalledWith('claude-opus-5-5');
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.click(within(menu).getAllByRole('menuitemradio').find((row) => row.textContent?.startsWith('Sonnet 5.5'))!);
    expect(onSelectModel).toHaveBeenLastCalledWith('claude-sonnet-5-5[1m]');
  });
});
