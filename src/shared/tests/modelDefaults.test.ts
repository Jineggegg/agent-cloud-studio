import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@/shared/api', () => ({ api: { user: { preferences: vi.fn(), savePreferences: vi.fn(async () => Response.json({})) } } }));

import { applyModelDefaults, readModelDefaults, visibleModelCatalog, writeProviderModelPreferences } from '@/shared/modelDefaults';
import { resetUserPreferences } from '@/shared/userSettings';

const CATALOG = {
  DEFAULT: 'default',
  OPTIONS: [
    { value: 'default', label: 'Default' },
    { value: 'fable', label: 'Fable', effort: { default: 'high', values: [{ value: 'high' }, { value: 'max' }] } },
    { value: 'haiku', label: 'Haiku' },
  ],
};

beforeEach(() => { resetUserPreferences(); localStorage.clear(); });

test('hidden models leave the menus, and the saved default becomes the catalog default while it is visible', () => {
  expect(visibleModelCatalog(CATALOG, { hidden: ['haiku'], model: 'fable' })).toEqual({ DEFAULT: 'fable', OPTIONS: CATALOG.OPTIONS.slice(0, 2) });
  // A hidden default falls back to the catalog's own default, then to the first visible model.
  expect(visibleModelCatalog(CATALOG, { hidden: ['fable'], model: 'fable' }).DEFAULT).toBe('default');
  expect(visibleModelCatalog(CATALOG, { hidden: ['default'] }).DEFAULT).toBe('fable');
  // Hiding everything is ignored rather than leaving a provider without a model.
  expect(visibleModelCatalog(CATALOG, { hidden: ['default', 'fable', 'haiku'] })).toBe(CATALOG);
});

test('choices merge per provider, clear with undefined, drop malformed values and seed the composer', () => {
  writeProviderModelPreferences('claude', { model: 'fable', effort: 'max' });
  writeProviderModelPreferences('codex', { hidden: ['gpt-5.4', 42 as unknown as string] });
  writeProviderModelPreferences('claude', { effort: undefined });
  expect(readModelDefaults()).toEqual({ claude: { model: 'fable' }, codex: { hidden: ['gpt-5.4'] } });
  applyModelDefaults('claude');
  expect(localStorage.getItem('claude-model')).toBe('fable');
  expect(localStorage.getItem('claude-effort')).toBe('default');
  // Nothing saved for Cursor: the composer keeps its own choice.
  applyModelDefaults('cursor');
  expect(localStorage.getItem('cursor-model')).toBeNull();
});

test('a default saved under an old catalog value resolves to the row that replaced it, 1M included', () => {
  const simplified = {
    DEFAULT: 'claude-opus-5-5',
    OPTIONS: [
      { value: 'claude-fable-5-1', label: 'Fable 5.1', aliases: ['fable', 'best'], longContextValue: 'claude-fable-5-1[1m]' },
      { value: 'claude-opus-5-5', label: 'Opus 5.5', aliases: ['opus', 'default'], longContextValue: 'claude-opus-5-5[1m]' },
    ],
  };
  expect(visibleModelCatalog(simplified, { model: 'opus[1m]' }).DEFAULT).toBe('claude-opus-5-5[1m]');
  expect(visibleModelCatalog(simplified, { model: 'best' }).DEFAULT).toBe('claude-fable-5-1');
  // Hiding the row hides its legacy names too.
  expect(visibleModelCatalog(simplified, { model: 'fable', hidden: ['claude-fable-5-1'] }).DEFAULT).toBe('claude-opus-5-5');
});
