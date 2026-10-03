import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

// Catalogs the mocked models endpoint serves per provider; none unless a test sets one.
const served = vi.hoisted(() => ({ catalogs: {} as Record<string, unknown> }));

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: string) => okJson({
        success: true,
        data: served.catalogs[provider] ? { models: served.catalogs[provider] } : null,
      }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async () => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null }),
  );
};

beforeEach(() => {
  served.catalogs = {};
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('codex-model', 'codex-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'codex');
  });
  assert.equal(result.current.currentProviderModel, 'codex-active');
});

test('a saved Cursor selection falls back to Claude Code, and only the offered agents’ catalogs are read', async () => {
  writeUserPreference('selectedProvider', 'cursor');
  const catalog = { DEFAULT: 'm', OPTIONS: [{ value: 'm', label: 'M' }] };
  served.catalogs = { claude: catalog, codex: catalog, cursor: catalog, opencode: catalog };

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.deepEqual(Object.keys(result.current.providerModelCatalog).sort(), ['claude', 'codex']);
  });
  assert.equal(result.current.provider, 'claude');
});

const EFFORT = { default: 'high', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] };
// The simplified Claude catalog: one row per family, the old aliases kept on the rows that replaced them.
const CLAUDE_CATALOG = {
  DEFAULT: 'claude-opus-5-5',
  OPTIONS: [
    { value: 'claude-fable-5-1', label: 'Fable 5.1', aliases: ['fable', 'best'], longContextValue: 'claude-fable-5-1[1m]', effort: EFFORT },
    { value: 'claude-opus-5-5', label: 'Opus 5.5', recommended: true, aliases: ['opus', 'default', 'opusplan'], longContextValue: 'claude-opus-5-5[1m]', effort: EFFORT },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', aliases: ['sonnet'], longContextValue: 'claude-sonnet-5-5[1m]', effort: EFFORT },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', aliases: ['haiku'] },
  ],
};

test('a model saved under an old catalog value is kept as the row that replaced it', async () => {
  served.catalogs.claude = CLAUDE_CATALOG;
  writeUserPreference('selectedProvider', 'claude');
  localStorage.setItem('claude-model', 'opus[1m]');
  localStorage.setItem('claude-effort', 'max');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-opus-5-5[1m]');
  });
  assert.equal(localStorage.getItem('claude-model'), 'claude-opus-5-5[1m]');
  assert.equal(result.current.currentProviderModel, 'claude-opus-5-5[1m]');
  // The 1M variant keeps its row's effort levels, so the saved effort survives.
  assert.deepEqual(result.current.currentProviderEffortOptions.map((option) => option.value), ['low', 'high', 'max']);
  assert.equal(result.current.currentProviderEffort, 'max');
});

test('the old Default and Best rows become the recommended model and Fable', async () => {
  served.catalogs.claude = CLAUDE_CATALOG;
  localStorage.setItem('claude-model', 'default');
  const first = await renderProviderState();
  await waitFor(() => {
    assert.equal(first.result.current.providerModels.claude, 'claude-opus-5-5');
  });
  first.unmount();
  vi.resetModules();

  localStorage.setItem('claude-model', 'best');
  const second = await renderProviderState();
  await waitFor(() => {
    assert.equal(second.result.current.providerModels.claude, 'claude-fable-5-1');
  });
});

test('switching to a model without the chosen effort clamps it to the nearest level that model has', async () => {
  const levels = (values: string[]) => ({ default: 'medium', values: values.map((value) => ({ value })) });
  served.catalogs.codex = {
    DEFAULT: 'gpt-6-sol',
    OPTIONS: [
      { value: 'gpt-6-sol', label: 'GPT-6 Sol', effort: levels(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) },
      { value: 'gpt-6-luna', label: 'GPT-6 Luna', effort: levels(['low', 'medium', 'high', 'xhigh', 'max']) },
      { value: 'gpt-5.5', label: 'GPT-5.5', effort: levels(['low', 'medium', 'high', 'xhigh']) },
    ],
  };
  writeUserPreference('selectedProvider', 'codex');
  localStorage.setItem('codex-model', 'gpt-6-sol');
  localStorage.setItem('codex-effort', 'ultra');

  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.deepEqual(result.current.currentProviderEffortOptions.map((option) => option.value).at(-1), 'ultra');
  });
  assert.equal(result.current.currentProviderEffort, 'ultra');

  act(() => {
    result.current.setStoredProviderModel('codex', 'gpt-6-luna');
  });
  await waitFor(() => {
    assert.equal(result.current.currentProviderEffort, 'max');
  });
  assert.equal(localStorage.getItem('codex-effort'), 'max');

  act(() => {
    result.current.setStoredProviderModel('codex', 'gpt-5.5');
  });
  await waitFor(() => {
    assert.equal(result.current.currentProviderEffort, 'xhigh');
  });
  assert.equal(localStorage.getItem('codex-effort'), 'xhigh');
});
