import { OFFERED_AGENT_PROVIDERS } from '@/shared/constants';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import { resolveModelChoice } from '@/shared/utils';

/**
 * Per-CLI model choices made in Studio settings and synced through the user's preferences: the model and
 * reasoning effort new sessions start with, and the models the user removed from the model menus (built-in
 * ones stay restorable from settings).
 */
export type ProviderModelPreferences = { model?: string; effort?: string; hidden?: string[] };
export type ModelDefaults = Partial<Record<LLMProvider, ProviderModelPreferences>>;

// The agents whose model choices Studio settings lists: the offered ones only (Cursor and OpenCode are hidden).
export const MODEL_PROVIDERS: LLMProvider[] = [...OFFERED_AGENT_PROVIDERS];

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** The stored choices, with anything malformed (an older or hand-edited value) dropped. */
export function readModelDefaults(): ModelDefaults {
  const stored = readUserPreference<unknown>('modelDefaults', {});
  if (!stored || typeof stored !== 'object') return {};
  const result: ModelDefaults = {};
  for (const provider of MODEL_PROVIDERS) {
    const entry = (stored as Record<string, unknown>)[provider];
    if (!entry || typeof entry !== 'object') continue;
    const { model, effort, hidden } = entry as Record<string, unknown>;
    result[provider] = {
      ...(isText(model) ? { model } : {}),
      ...(isText(effort) ? { effort } : {}),
      ...(Array.isArray(hidden) ? { hidden: hidden.filter(isText) } : {}),
    };
  }
  return result;
}

/** Merges a change into one provider's choices; `undefined` clears a field (back to the model's own default). */
export function writeProviderModelPreferences(provider: LLMProvider, change: ProviderModelPreferences) {
  const all = readModelDefaults();
  const next: ProviderModelPreferences = { ...all[provider], ...change };
  for (const key of Object.keys(next) as (keyof ProviderModelPreferences)[]) {
    if (next[key] === undefined) delete next[key];
  }
  writeUserPreference('modelDefaults', { ...all, [provider]: next });
}

/**
 * Makes the saved default the model and effort this device's chat composer starts with. The composer keeps its
 * last choice per device in localStorage, so this runs when a widget opens a new session and when a default is saved.
 */
export function applyModelDefaults(provider: LLMProvider) {
  const choice = readModelDefaults()[provider];
  try {
    if (choice?.model) localStorage.setItem(`${provider}-model`, choice.model);
    if (choice?.model || choice?.effort) localStorage.setItem(`${provider}-effort`, choice?.effort ?? 'default');
  } catch { /* Storage blocked: the composer keeps its own choice. */ }
}

/**
 * The catalog the model menus show: hidden models removed (never all of them) and the saved default, when still
 * visible, as the default. A default saved under a legacy value (`opus[1m]`, `default`) counts as the row that
 * replaced it, 1M variant included.
 */
export function visibleModelCatalog(catalog: ProviderModelsDefinition, choice: ProviderModelPreferences | undefined): ProviderModelsDefinition {
  const hidden = new Set(choice?.hidden ?? []);
  const options = catalog.OPTIONS.filter(option => !hidden.has(option.value));
  if (!options.length) return catalog;
  const preferred = [choice?.model, catalog.DEFAULT]
    .map(value => resolveModelChoice(options, value)?.value)
    .find(Boolean) ?? options[0].value;
  return { OPTIONS: options, DEFAULT: preferred };
}
