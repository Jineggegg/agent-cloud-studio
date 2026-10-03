import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  readSmallRegularFile,
} from '@/shared/utils.js';

/**
 * Curated Codex catalog shipped as immutable CloudCLI defaults.
 *
 * Used by the Codex provider adapter below whenever the Codex CLI's live catalog
 * (`~/.codex/models_cache.json`) is missing or unusable, and for its Chinese
 * descriptions of the models it knows.
 */
export const CODEX_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      description: '最新主力模型，适合编码和日常工作',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      description: '最强的 GPT，适合最复杂、要求最高的工作',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-sol',
      label: 'GPT-6 Sol',
      description: '上一代主力模型',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      description: '快速、省用量，适合较简单的任务',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      description: '更早一代的主力模型',
      effort: {
        default: 'low',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-terra',
      label: 'GPT-5.6 Terra',
      description: '更早一代的均衡模型，适合直截了当的工作',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          { value: 'ultra' },
        ],
      },
    },
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: '更早一代的快速、省用量的模型',
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'gpt-5.5',
      label: 'GPT-5.5',
      description: '旧版编码模型',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4',
      label: 'GPT-5.4',
      description: '旧版日常编码模型',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
    {
      value: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: '小而快，适合简单的编码任务',
      effort: {
        default: 'medium',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }],
      },
    },
  ],
  DEFAULT: 'gpt-5.6-sol',
};

const CODEX_HOME = path.join(os.homedir(), '.codex');
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');
// Written by the Codex CLI from the models endpoint; the CLI refreshes it itself.
const CODEX_MODELS_CACHE_PATH = path.join(CODEX_HOME, 'models_cache.json');
// The real cache is a few hundred KB (it embeds each model's base instructions);
// anything far larger is not Codex's cache and is not worth parsing.
const CODEX_MODELS_CACHE_MAX_BYTES = 4 * 1024 * 1024;
// Slugs go straight to the Codex CLI as `--model`; keep them to plain id characters.
const CODEX_MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const CODEX_EFFORT_VALUE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;

/** `GPT-6-Astra` or `gpt-6-astra` → `GPT-6 Astra`; names of other shapes pass through. */
const readableCodexModelName = (name: string): string => {
  const match = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(name);
  if (!match) {
    return name;
  }

  const variant = (match[2] ?? '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return variant ? `GPT-${match[1]} ${variant}` : `GPT-${match[1]}`;
};

const readEffortOptions = (entry: Record<string, unknown>): ProviderModelOption['effort'] => {
  const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
  const values: string[] = [];
  for (const level of levels) {
    const effort = readOptionalString(readObjectRecord(level)?.effort);
    if (effort && CODEX_EFFORT_VALUE.test(effort) && !values.includes(effort)) {
      values.push(effort);
    }
  }
  if (values.length === 0) {
    return undefined;
  }

  const preferred = readOptionalString(entry.default_reasoning_level);
  return {
    ...(preferred && values.includes(preferred) ? { default: preferred } : {}),
    values: values.map((value) => ({ value })),
  };
};

/**
 * Turns the parsed cache into a catalog: the models Codex lists in its own picker
 * (`visibility: "list"`), ordered by Codex's `priority`, with its display names and
 * reasoning efforts. Returns null when nothing usable is left, so the caller falls
 * back to the curated catalog instead of showing an empty menu.
 */
const buildCatalogFromModelsCache = (parsed: unknown): ProviderModelsDefinition | null => {
  const models = readObjectRecord(parsed)?.models;
  if (!Array.isArray(models)) {
    return null;
  }

  const curated = new Map(CODEX_PREDEFINED_MODELS.OPTIONS.map((option) => [option.value, option]));
  const listed: { option: ProviderModelOption; priority: number; index: number }[] = [];
  const seen = new Set<string>();
  models.forEach((candidate, index) => {
    const entry = readObjectRecord(candidate);
    const slug = readOptionalString(entry?.slug);
    if (!entry || !slug || !CODEX_MODEL_SLUG.test(slug) || entry.visibility !== 'list' || seen.has(slug)) {
      return;
    }
    seen.add(slug);

    const displayName = readOptionalString(entry.display_name);
    const liveDescription = readOptionalString(entry.description);
    const effort = readEffortOptions(entry);
    // Chinese copy for the models the curated catalog knows; the live English line for new ones.
    const description = curated.get(slug)?.description
      ?? (liveDescription && liveDescription.length <= MAX_DESCRIPTION_LENGTH ? liveDescription : undefined);
    listed.push({
      option: {
        value: slug,
        label: readableCodexModelName(displayName && displayName.length <= MAX_LABEL_LENGTH ? displayName : slug),
        ...(description ? { description } : {}),
        ...(effort ? { effort } : {}),
      },
      priority: typeof entry.priority === 'number' && Number.isFinite(entry.priority)
        ? entry.priority
        : Number.POSITIVE_INFINITY,
      index,
    });
  });
  if (listed.length === 0) {
    return null;
  }

  // Codex's own order; the cache's order breaks ties.
  listed.sort((left, right) => left.priority - right.priority || left.index - right.index);
  const options = listed.map((item) => item.option);
  // A new chat starts on the model Codex ranks first, as Codex itself does without a configured model.
  return { OPTIONS: options, DEFAULT: options[0].value };
};

type CodexModelsCacheMemo = {
  mtimeMs: number;
  size: number;
  catalog: ProviderModelsDefinition | null;
};

type CodexProviderModelsPaths = {
  configPath?: string;
  modelsCachePath?: string;
};

/**
 * Provider registry model adapter for Codex: the Codex CLI's live model catalog when it
 * has one, the curated catalog otherwise, and the model set in the Codex config.
 *
 * Used by the Codex provider (`codex.provider.ts`); tests construct it with temp paths.
 */
export class CodexProviderModels implements IProviderModels {
  private readonly configPath: string;
  private readonly modelsCachePath: string;
  // The last parse, reused until the cache file's mtime or size changes.
  private modelsCacheMemo: CodexModelsCacheMemo | null = null;

  constructor(paths: CodexProviderModelsPaths = {}) {
    this.configPath = paths.configPath ?? CODEX_CONFIG_PATH;
    this.modelsCachePath = paths.modelsCachePath ?? CODEX_MODELS_CACHE_PATH;
  }

  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return (await this.readLiveCatalog()) ?? CODEX_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }

  /**
   * Reads `models_cache.json`, never throwing: a missing, oversized, non-regular or
   * malformed file yields null. The parse is memoized against the file's mtime and size,
   * so the menus' frequent catalog reads cost one `stat` each.
   */
  private async readLiveCatalog(): Promise<ProviderModelsDefinition | null> {
    let info: { mtimeMs: number; size: number; isFile(): boolean };
    try {
      info = await stat(this.modelsCachePath);
    } catch {
      this.modelsCacheMemo = null;
      return null;
    }

    const memo = this.modelsCacheMemo;
    if (memo && memo.mtimeMs === info.mtimeMs && memo.size === info.size) {
      return memo.catalog;
    }

    let catalog: ProviderModelsDefinition | null = null;
    if (info.isFile() && info.size <= CODEX_MODELS_CACHE_MAX_BYTES) {
      try {
        catalog = buildCatalogFromModelsCache(
          JSON.parse(await readSmallRegularFile(this.modelsCachePath, CODEX_MODELS_CACHE_MAX_BYTES)),
        );
      } catch {
        // Unreadable, grown past the cap since the stat, or not JSON: use the curated catalog.
        catalog = null;
      }
    }

    this.modelsCacheMemo = { mtimeMs: info.mtimeMs, size: info.size, catalog };
    return catalog;
  }
}
