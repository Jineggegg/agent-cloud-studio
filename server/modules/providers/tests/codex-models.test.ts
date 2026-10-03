import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PREDEFINED_MODELS,
  CodexProviderModels,
} from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('the curated fallback leads with GPT-6.1 Sol, the newest model Codex lists', () => {
  const [newest] = CODEX_PREDEFINED_MODELS.OPTIONS;
  assert.equal(newest.value, 'gpt-6.1-sol');
  assert.equal(newest.label, 'GPT-6.1 Sol');
  assert.deepEqual(newest.effort?.values.map((effort) => effort.value), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});

// ---------------------------------------------------------------------------
// The Codex CLI's live catalog (~/.codex/models_cache.json)

const level = (effort: string) => ({ effort, description: `${effort} reasoning` });

/** A cache shaped like the one Codex 0.156 writes, trimmed to the fields that matter here. */
const liveCache = (models: unknown[]) => JSON.stringify({
  fetched_at: '2026-10-03T01:23:16.306Z',
  etag: 'W/"b73c2a"',
  client_version: '0.156.1',
  identity: 'account',
  models,
});

const LIVE_MODELS = [
  {
    slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest workhorse model.', visibility: 'list', priority: 1.5,
    default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level),
  },
  {
    slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'Legacy coding model.', visibility: 'list', priority: 13,
    default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(level),
  },
  {
    slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence.', visibility: 'list', priority: 2,
    default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level),
  },
  {
    slug: 'gpt-reserve', display_name: 'GPT-Reserve', description: 'Hidden.', visibility: 'hide', priority: 4,
    supported_reasoning_levels: ['low'].map(level),
  },
  {
    slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', description: 'Previous generation workhorse model.', visibility: 'list', priority: 3,
    default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(level),
  },
  {
    slug: 'gpt-7-nova', display_name: 'GPT-7-Nova', description: 'A model this build has never heard of.', visibility: 'list', priority: 1,
    default_reasoning_level: 'high', supported_reasoning_levels: ['medium', 'high'].map(level),
  },
  {
    slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43,
    supported_reasoning_levels: ['low'].map(level),
  },
];

const withCacheDir = async (run: (paths: { dir: string; modelsCachePath: string; configPath: string }) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-models-'));
  try {
    await run({
      dir,
      modelsCachePath: path.join(dir, 'models_cache.json'),
      configPath: path.join(dir, 'config.toml'),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('prefers the live cache: listed models only, in Codex priority order, with readable names', async () => {
  await withCacheDir(async (paths) => {
    await writeFile(paths.modelsCachePath, liveCache(LIVE_MODELS));
    const catalog = await new CodexProviderModels(paths).getSupportedModels();

    assert.deepEqual(
      catalog.OPTIONS.map((option) => [option.value, option.label]),
      [
        ['gpt-7-nova', 'GPT-7 Nova'],
        ['gpt-6.1-sol', 'GPT-6.1 Sol'],
        ['gpt-6-astra', 'GPT-6 Astra'],
        ['gpt-6-sol', 'GPT-6 Sol'],
        ['gpt-5.5', 'GPT-5.5'],
      ],
    );
    assert.equal(catalog.DEFAULT, 'gpt-7-nova');
  });
});

test('takes reasoning efforts from the cache and describes known models in Chinese', async () => {
  await withCacheDir(async (paths) => {
    await writeFile(paths.modelsCachePath, liveCache(LIVE_MODELS));
    const catalog = await new CodexProviderModels(paths).getSupportedModels();
    const byValue = new Map(catalog.OPTIONS.map((option) => [option.value, option]));

    assert.deepEqual(byValue.get('gpt-7-nova')?.effort, {
      default: 'high',
      values: [{ value: 'medium' }, { value: 'high' }],
    });
    assert.equal(byValue.get('gpt-6-astra')?.effort?.default, 'medium');
    assert.deepEqual(
      byValue.get('gpt-6-astra')?.effort?.values.map((effort) => effort.value),
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    );
    assert.equal(byValue.get('gpt-6-sol')?.description, findCodexModel('gpt-6-sol')?.description);
    // A model the curated catalog does not know keeps Codex's own line.
    assert.equal(byValue.get('gpt-7-nova')?.description, 'A model this build has never heard of.');
  });
});

test('skips malformed entries instead of rejecting the whole cache', async () => {
  await withCacheDir(async (paths) => {
    await writeFile(paths.modelsCachePath, liveCache([
      null,
      'gpt-6-sol',
      { slug: '', visibility: 'list', priority: 1 },
      { slug: 'bad slug; rm -rf', visibility: 'list', priority: 1 },
      { slug: 'gpt-6-luna', visibility: 'list', priority: 'first', supported_reasoning_levels: [{ effort: 'Not An Effort!' }, null] },
      { slug: 'gpt-6-luna', display_name: 'Duplicate', visibility: 'list', priority: 0 },
      { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 3 },
    ]));
    const catalog = await new CodexProviderModels(paths).getSupportedModels();

    assert.deepEqual(catalog.OPTIONS.map((option) => option.value), ['gpt-6-sol', 'gpt-6-luna']);
    const luna = catalog.OPTIONS.find((option) => option.value === 'gpt-6-luna');
    assert.equal(luna?.label, 'GPT-6 Luna');
    assert.equal(luna?.effort, undefined);
  });
});

test('falls back to the curated catalog when the cache is missing, corrupt, oversized or not a file', async () => {
  await withCacheDir(async (paths) => {
    const adapter = () => new CodexProviderModels(paths);

    assert.equal(await adapter().getSupportedModels(), CODEX_PREDEFINED_MODELS, 'missing');

    await writeFile(paths.modelsCachePath, '{"models": [');
    assert.equal(await adapter().getSupportedModels(), CODEX_PREDEFINED_MODELS, 'corrupt JSON');

    await writeFile(paths.modelsCachePath, JSON.stringify({ models: 'gpt-6-sol' }));
    assert.equal(await adapter().getSupportedModels(), CODEX_PREDEFINED_MODELS, 'models not a list');

    await writeFile(paths.modelsCachePath, liveCache(LIVE_MODELS.map((model) => ({ ...model, visibility: 'hide' }))));
    assert.equal(await adapter().getSupportedModels(), CODEX_PREDEFINED_MODELS, 'nothing listed');

    // Valid JSON padded past the 4 MiB cap.
    await writeFile(paths.modelsCachePath, liveCache(LIVE_MODELS) + ' '.repeat(4 * 1024 * 1024));
    assert.equal(await adapter().getSupportedModels(), CODEX_PREDEFINED_MODELS, 'oversized');

    await rm(paths.modelsCachePath);
    await mkdir(paths.modelsCachePath);
    assert.equal(await adapter().getSupportedModels(), CODEX_PREDEFINED_MODELS, 'directory');
  });
});

test('reuses the parsed cache until its mtime or size changes', async () => {
  await withCacheDir(async (paths) => {
    const adapter = new CodexProviderModels(paths);
    const named = (name: string) => liveCache([{ ...LIVE_MODELS[1], display_name: name }]);

    await writeFile(paths.modelsCachePath, named('GPT-6-Astra'));
    // A whole-second mtime, so setting it again below reproduces it exactly (stat reports sub-ms precision).
    const mtime = new Date(Math.floor((await stat(paths.modelsCachePath)).mtimeMs / 1000) * 1000);
    await utimes(paths.modelsCachePath, mtime, mtime);
    assert.equal((await adapter.getSupportedModels()).OPTIONS[0].label, 'GPT-6 Astra');

    // Same size, same mtime: the memoized parse is served without re-reading.
    await writeFile(paths.modelsCachePath, named('GPT-6-Bstra'));
    await utimes(paths.modelsCachePath, mtime, mtime);
    assert.equal((await adapter.getSupportedModels()).OPTIONS[0].label, 'GPT-6 Astra');

    // Codex refreshing the file moves its mtime, and the new catalog is picked up.
    const later = new Date(mtime.getTime() + 5_000);
    await utimes(paths.modelsCachePath, later, later);
    assert.equal((await adapter.getSupportedModels()).OPTIONS[0].label, 'GPT-6 Bstra');

    // Removing it drops back to the curated catalog.
    await rm(paths.modelsCachePath);
    assert.equal(await adapter.getSupportedModels(), CODEX_PREDEFINED_MODELS);
  });
});

test('the configured model still wins as the active model; without one, the live default', async () => {
  await withCacheDir(async (paths) => {
    await writeFile(paths.modelsCachePath, liveCache(LIVE_MODELS));
    const adapter = new CodexProviderModels(paths);
    assert.deepEqual(await adapter.getCurrentActiveModel(), { model: 'gpt-7-nova' });

    await writeFile(paths.configPath, 'model = "gpt-6-sol"\n');
    assert.deepEqual(await adapter.getCurrentActiveModel(), { model: 'gpt-6-sol' });
  });
});
