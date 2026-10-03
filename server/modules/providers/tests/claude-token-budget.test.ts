import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  extractCumulativeTokenBudget,
  extractTokenBudget,
  queryClaudeSDK,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/** Runs `body` with `CONTEXT_WINDOW` set to `value` (or unset), restoring it afterwards. */
async function withContextWindowEnv(value: string | undefined, body: () => unknown): Promise<void> {
  const previous = process.env.CONTEXT_WINDOW;
  if (value === undefined) {
    delete process.env.CONTEXT_WINDOW;
  } else {
    process.env.CONTEXT_WINDOW = value;
  }
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env.CONTEXT_WINDOW;
    } else {
      process.env.CONTEXT_WINDOW = previous;
    }
  }
}

const assistantWithPrompt = (promptTokens: number) => ({
  type: 'assistant',
  message: {
    usage: { input_tokens: 10, cache_read_input_tokens: promptTokens - 10, output_tokens: 0 },
  },
});

test('assistant usage produces a cumulative budget', () => {
  const budget = extractTokenBudget({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 500,
      },
    },
  });

  assert.ok(budget);
  assert.equal(budget.inputTokens, 42_012);
  assert.equal(budget.outputTokens, 500);
  assert.equal(budget.used, 42_512);
});

test('system task events with tool-usage shaped usage emit no budget', () => {
  // task_progress/task_notification carry usage {total_tokens, tool_uses,
  // duration_ms}; reading Anthropic keys off it produced a used: 0 budget
  // that flashed "0" in the composer mid-generation.
  const budget = extractTokenBudget({
    type: 'system',
    subtype: 'task_progress',
    task_id: 't-1',
    usage: { total_tokens: 5_000, tool_uses: 3, duration_ms: 1_200 },
  });

  assert.equal(budget, null);
});

test('subagent messages emit no budget for the parent session', () => {
  // A subagent's usage is its own context window; surfacing it made the
  // session counter drop to the subagent's number and bounce back.
  const budget = extractTokenBudget({
    type: 'assistant',
    parent_tool_use_id: 'toolu_123',
    message: { usage: { input_tokens: 900, output_tokens: 10 } },
  });

  assert.equal(budget, null);
});

test('a turn-ending result emits no budget', () => {
  // `result.usage` is the turn's bill: every request it made, summed, each
  // subagent's included. A four-request turn therefore reports roughly four
  // times the context the conversation holds, so publishing it made the
  // counter leap when the turn ended and fall back on the next turn's first
  // assistant message.
  const budget = extractTokenBudget({
    type: 'result',
    usage: {
      input_tokens: 18,
      cache_creation_input_tokens: 8_138,
      cache_read_input_tokens: 40_460,
      output_tokens: 166,
    },
    modelUsage: {
      'claude-sonnet-5': { inputTokens: 929, outputTokens: 177 },
    },
  });

  assert.equal(budget, null);
});

test('the cumulative reader stays available for SDK builds with no assistant usage', () => {
  const fromUsage = extractCumulativeTokenBudget({
    type: 'result',
    usage: { input_tokens: 18, cache_read_input_tokens: 40_460, output_tokens: 166 },
  });

  assert.ok(fromUsage);
  assert.equal(fromUsage.used, 40_644);

  const fromModelUsage = extractCumulativeTokenBudget({
    type: 'result',
    modelUsage: {
      'claude-sonnet-5': { cumulativeInputTokens: 1_000, cumulativeOutputTokens: 200 },
    },
  });

  assert.ok(fromModelUsage);
  assert.equal(fromModelUsage.used, 1_200);
});

test('the cumulative reader ignores anything that is not a result', () => {
  assert.equal(
    extractCumulativeTokenBudget({
      type: 'assistant',
      message: { usage: { input_tokens: 10, output_tokens: 2 } },
    }),
    null,
  );
});

test('a 1M model measures the budget against a 1,000,000-token window', async () => {
  await withContextWindowEnv(undefined, () => {
    // The owner's case: 176K on Opus 5.5 1M is ~18 %, not "176K / 160K".
    const budget = extractTokenBudget(assistantWithPrompt(176_000), { models: ['claude-opus-5-5[1m]'] });
    assert.ok(budget);
    assert.equal(budget.used, 176_000);
    assert.equal(budget.total, 1_000_000);

    // A legacy alias with the suffix counts the same.
    assert.equal(extractTokenBudget(assistantWithPrompt(1_000), { models: ['opus[1m]'] })?.total, 1_000_000);
  });
});

test('a standard model measures the budget against a 200,000-token window', async () => {
  await withContextWindowEnv(undefined, () => {
    assert.equal(extractTokenBudget(assistantWithPrompt(50_000), { models: ['claude-sonnet-5-5'] })?.total, 200_000);
    // With nothing known about the model, current Claude models' window applies.
    assert.equal(extractTokenBudget(assistantWithPrompt(50_000))?.total, 200_000);
  });
});

test('a prompt larger than the standard window implies the 1M variant', async () => {
  await withContextWindowEnv(undefined, () => {
    // Only the long-context variant can have served it, whatever the id says.
    assert.equal(extractTokenBudget(assistantWithPrompt(404_009), { models: ['claude-opus-5-5'] })?.total, 1_000_000);
  });
});

test('the SDK-reported window wins over the model-derived one', async () => {
  await withContextWindowEnv(undefined, () => {
    assert.equal(
      extractTokenBudget(assistantWithPrompt(50_000), { models: ['claude-opus-5-5[1m]'], reportedContextWindow: 400_000 })?.total,
      400_000,
    );

    // A result's own modelUsage is read for its window, matched to the session's model
    // rather than a subagent's.
    const fromResult = extractCumulativeTokenBudget({
      type: 'result',
      usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 100 },
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 900_000, contextWindow: 200_000 },
        'claude-opus-5-5[1m]': { inputTokens: 10, cacheReadInputTokens: 40_000, contextWindow: 1_000_000 },
      },
    }, { models: ['claude-opus-5-5'] });
    assert.equal(fromResult?.total, 1_000_000);

    // Without a model match, the entry that carried the most prompt is the conversation's.
    const unmatched = extractCumulativeTokenBudget({
      type: 'result',
      usage: { input_tokens: 10, output_tokens: 1 },
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 100, contextWindow: 200_000 },
        'claude-custom': { inputTokens: 5_000, cacheReadInputTokens: 30_000, contextWindow: 500_000 },
      },
    });
    assert.equal(unmatched?.total, 500_000);
  });
});

test('CONTEXT_WINDOW stays an explicit override', async () => {
  await withContextWindowEnv('180000', () => {
    assert.equal(
      extractTokenBudget(assistantWithPrompt(50_000), { models: ['claude-opus-5-5[1m]'], reportedContextWindow: 1_000_000 })?.total,
      180_000,
    );
  });
  await withContextWindowEnv('not-a-number', () => {
    assert.equal(extractTokenBudget(assistantWithPrompt(50_000), { models: ['claude-opus-5-5[1m]'] })?.total, 1_000_000);
  });
});

/** Drives `queryClaudeSDK` over a fixed SDK stream and returns the token budgets it published. */
async function runScriptedBudgets(model: string, messages: Array<Record<string, unknown>>) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-token-budget-'));
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const requestedModels: unknown[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery: ({ options }) => {
      requestedModels.push(options.model);
      const iterator = (async function* () {
        yield* messages;
      })();
      return Object.assign(iterator, { interrupt: async () => {} });
    },
  };

  try {
    await queryClaudeSDK('hello', { sessionId: `budget-${model}`, cwd, model }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  return {
    requestedModels,
    budgets: sent
      .filter((message) => message.kind === 'status' && message.text === 'token_budget')
      .map((message) => message.tokenBudget as { used: number; total: number }),
  };
}

test('a live run of a 1M model reports its budget against 1M from the first message', async () => {
  await withContextWindowEnv(undefined, async () => {
    const { requestedModels, budgets } = await runScriptedBudgets('claude-opus-5-5[1m]', [
      { type: 'system', subtype: 'init', session_id: 'native-1m', model: 'claude-opus-5-5[1m]' },
      { ...assistantWithPrompt(176_000), session_id: 'native-1m', parent_tool_use_id: null },
      { type: 'result', subtype: 'success', session_id: 'native-1m', result: 'ok', duration_ms: 1, num_turns: 1 },
    ]);

    assert.deepEqual(requestedModels, ['claude-opus-5-5[1m]']);
    assert.deepEqual(budgets.map(({ used, total }) => [used, total]), [[176_000, 1_000_000]]);
  });
});

test('a live run republishes its budget when the result reports the real window', async () => {
  await withContextWindowEnv(undefined, async () => {
    // The CLI ran a long-context window this run could not infer from the model id.
    const { budgets } = await runScriptedBudgets('claude-sonnet-5-5', [
      { type: 'system', subtype: 'init', session_id: 'native-std', model: 'claude-sonnet-5-5' },
      { ...assistantWithPrompt(50_000), session_id: 'native-std', parent_tool_use_id: null },
      {
        type: 'result', subtype: 'success', session_id: 'native-std', result: 'ok', duration_ms: 1, num_turns: 1,
        usage: { input_tokens: 10, cache_read_input_tokens: 150_000, output_tokens: 10 },
        modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, cacheReadInputTokens: 150_000, contextWindow: 1_000_000 } },
      },
    ]);

    // The result's summed bill is never published; only the last assistant budget, re-measured.
    assert.deepEqual(budgets.map(({ used, total }) => [used, total]), [[50_000, 200_000], [50_000, 1_000_000]]);
  });
});
