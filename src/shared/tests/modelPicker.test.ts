import { describe, expect, test } from 'vitest';

import { clampEffortLevel, formatModelIdLabel, placeAnchoredMenu, resolveModelChoice } from '@/shared/utils';

const CLAUDE = [
  { value: 'claude-fable-5-1', label: 'Fable 5.1', aliases: ['fable', 'best'], longContextValue: 'claude-fable-5-1[1m]' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', aliases: ['opus', 'default', 'opusplan'], longContextValue: 'claude-opus-5-5[1m]' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', aliases: ['haiku'] },
];

describe('resolveModelChoice', () => {
  test('maps saved values from the old alias catalog onto today\'s rows, 1M variant included', () => {
    expect(resolveModelChoice(CLAUDE, 'opus')).toMatchObject({ value: 'claude-opus-5-5', longContext: false });
    expect(resolveModelChoice(CLAUDE, 'opus[1m]')).toMatchObject({ value: 'claude-opus-5-5[1m]', longContext: true });
    expect(resolveModelChoice(CLAUDE, 'claude-opus-5-5[1m]')?.option.value).toBe('claude-opus-5-5');
    expect(resolveModelChoice(CLAUDE, 'best')?.value).toBe('claude-fable-5-1');
    expect(resolveModelChoice(CLAUDE, 'haiku[1m]')).toMatchObject({ value: 'claude-haiku-4-5-20251001', longContext: false });
    expect(resolveModelChoice(CLAUDE, 'claude-opus-4-8')).toBeNull();
    expect(resolveModelChoice(CLAUDE, '')).toBeNull();
  });
});

describe('formatModelIdLabel', () => {
  test('names reported ids the way the menus do', () => {
    expect(formatModelIdLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatModelIdLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelIdLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M');
    expect(formatModelIdLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(formatModelIdLabel('gpt-5.4-mini')).toBe('GPT-5.4 Mini');
    expect(formatModelIdLabel('deepseek-flash')).toBe('deepseek-flash');
  });
});

describe('clampEffortLevel', () => {
  test('keeps a supported level and the model-decides default', () => {
    expect(clampEffortLevel('high', ['low', 'high'])).toBe('high');
    expect(clampEffortLevel('default', ['low', 'high'])).toBe('default');
  });

  test('moves an unsupported level to the nearest one the new model has', () => {
    // GPT-6 Sol → GPT-5.5: max and ultra become xhigh, the top GPT-5.5 offers.
    expect(clampEffortLevel('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    expect(clampEffortLevel('ultra', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    // Claude's ultracode on a Codex model is its ultra.
    expect(clampEffortLevel('ultracode', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).toBe('ultra');
    // Equally near: the lower, faster level.
    expect(clampEffortLevel('ultra', ['low', 'high', 'xhigh', 'max', 'ultracode'])).toBe('max');
    expect(clampEffortLevel('medium', ['low', 'high'])).toBe('low');
  });

  test('a model without levels, or a level outside the known order, falls back to the default', () => {
    expect(clampEffortLevel('high', [])).toBe('default');
    expect(clampEffortLevel('turbo', ['low', 'high'])).toBe('default');
  });
});

describe('placeAnchoredMenu', () => {
  const bounds = { top: 0, bottom: 768, left: 0, right: 1024 };

  test('opens on the preferred side when the panel fits, clamped inside the viewport', () => {
    const placement = placeAnchoredMenu({ top: 700, bottom: 732, left: 990, right: 1020 }, {
      bounds, viewportHeight: 768, width: 300, preferredSide: 'above', align: 'start', contentHeight: 400,
    });
    expect(placement).toMatchObject({ side: 'above', bottom: 74, left: 1024 - 8 - 300, width: 300 });
    expect(placement.transformOrigin).toBe(`${1005 - 716}px bottom`);
  });

  test('flips when the preferred side is too short for the panel and the other side has more room', () => {
    const placement = placeAnchoredMenu({ top: 200, bottom: 232, left: 100, right: 160 }, {
      bounds, viewportHeight: 768, width: 300, preferredSide: 'above', align: 'start', contentHeight: 400,
    });
    expect(placement).toMatchObject({ side: 'below', top: 238 });
    expect(placement.maxHeight).toBe(768 - 232 - 6 - 8);
  });

  test('stays inside the visual viewport when iOS has panned it under the keyboard', () => {
    const placement = placeAnchoredMenu({ top: 500, bottom: 532, left: 100, right: 160 }, {
      bounds: { top: 300, bottom: 600, left: 0, right: 1024 }, viewportHeight: 768, width: 300, preferredSide: 'above', align: 'start',
    });
    expect(placement.side).toBe('above');
    expect(placement.maxHeight).toBe(500 - 6 - 8 - 300);
  });
});
