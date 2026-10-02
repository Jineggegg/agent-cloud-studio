import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * `options.buildIsolation` (set only by the Studio build runner for unattended AI builds) must reach the SDK as
 * restrictions: no settings files or MCP servers, a PreToolUse hook that decides every tool call and fails closed,
 * and the OS sandbox when asked for. Driven through `queryClaudeSDK` with a query that captures its options.
 */

type Hook = (input: AnyRecord, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<AnyRecord>;

async function captureOptions(options: AnyRecord): Promise<AnyRecord> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-build-isolation-'));
  let captured: AnyRecord | null = null;
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    createQuery: ({ options: sdkOptions }) => {
      captured = sdkOptions;
      // A CLI that ends at once without saying anything.
      const iterator = (async function* () { /* nothing */ })();
      return Object.assign(iterator, { interrupt: async () => {} });
    },
  };
  const writer = { send: (_message: NormalizedMessage) => {}, userId: null };
  try {
    await queryClaudeSDK('hello', { sessionId: 'isolation-session', cwd, ...options }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  assert.ok(captured, 'the query was created');
  return captured;
}

const preToolUse = (sdkOptions: AnyRecord) => (sdkOptions.hooks?.PreToolUse?.[0]?.hooks?.[0] ?? null) as Hook | null;
const decide = async (hook: Hook, toolName: string, toolInput: unknown) => {
  const output = await hook({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 't1' }, 't1', { signal: new AbortController().signal });
  return output.hookSpecificOutput as { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
};

test('a build turn loads no settings or MCP servers and every tool call goes through the build policy hook', async () => {
  const reviewed: [string, unknown][] = [];
  const sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: ['registry.npmjs.org'] } };
  const sdkOptions = await captureOptions({
    permissionMode: 'default',
    buildIsolation: {
      reviewToolUse: (toolName: string, toolInput: unknown) => {
        reviewed.push([toolName, toolInput]);
        return toolName === 'Read' ? { allow: true } : { allow: false, reason: '受限模式只能运行 ls' };
      },
      sandbox,
      env: { npm_config_cache: '/home/owner/projects/app/.studio-cache/npm', LD_PRELOAD: '/tmp/evil.so', PATH: '/tmp' },
    },
  });

  assert.deepEqual(sdkOptions.settingSources, [], 'owner and project settings (allow rules, hooks) are not loaded');
  assert.equal(sdkOptions.strictMcpConfig, true);
  assert.equal(sdkOptions.mcpServers, undefined, 'no MCP servers are started for a build');
  assert.deepEqual(sdkOptions.sandbox, sandbox);
  assert.equal(sdkOptions.env.npm_config_cache, '/home/owner/projects/app/.studio-cache/npm');
  assert.notEqual(sdkOptions.env.LD_PRELOAD, '/tmp/evil.so', 'only package-cache variables may be set');
  assert.notEqual(sdkOptions.env.PATH, '/tmp');
  assert.ok(sdkOptions.hooks.Notification, 'the runtime keeps its own hooks');

  const hook = preToolUse(sdkOptions);
  assert.ok(hook, 'a PreToolUse hook decides every tool call');
  assert.deepEqual(await decide(hook, 'Read', { file_path: 'README.md' }), {
    hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Allowed by the Studio build policy.',
  });
  const denied = await decide(hook, 'Bash', { command: 'npm test' });
  assert.equal(denied.permissionDecision, 'deny');
  assert.equal(denied.permissionDecisionReason, '受限模式只能运行 ls');
  assert.deepEqual(reviewed, [['Read', { file_path: 'README.md' }], ['Bash', { command: 'npm test' }]]);
});

test('the build policy hook fails closed when the reviewer is missing, throws or answers oddly', async () => {
  for (const reviewToolUse of [undefined, () => { throw new Error('boom'); }, () => ({ allow: 'yes' }), () => null]) {
    const hook = preToolUse(await captureOptions({ buildIsolation: { reviewToolUse } }));
    assert.ok(hook);
    assert.equal((await decide(hook, 'Read', { file_path: 'README.md' })).permissionDecision, 'deny');
  }
});

test('ordinary chat turns keep their settings sources and get no build hook or sandbox', async () => {
  const sdkOptions = await captureOptions({});
  assert.deepEqual(sdkOptions.settingSources, ['project', 'user', 'local']);
  assert.equal(preToolUse(sdkOptions), null);
  assert.equal(sdkOptions.sandbox, undefined);
  assert.equal(sdkOptions.strictMcpConfig, undefined);
});

/** Runs `body` with extra process.env entries, restoring the previous values afterwards. */
async function withEnv<T>(entries: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(entries).map(name => [name, process.env[name]]));
  const assign = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(entries);
  try {
    return await body();
  } finally {
    assign(previous);
  }
}

test('a build turn inherits only allowlisted environment variables, not the whole server process.env (review: env)', async () => {
  const serverEnv = {
    STUDIO_TEST_SERVER_SECRET: 'server-only', DATABASE_URL: 'postgres://studio', GITHUB_TOKEN: 'not-for-builds', LD_PRELOAD: '/tmp/x.so',
    ANTHROPIC_BASE_URL: 'https://api.example.test', CLAUDE_CONFIG_DIR: '/home/owner/.claude', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', TERM: 'xterm',
    HTTPS_PROXY: 'http://127.0.0.1:7890', AWS_REGION: 'us-east-1', CLAUDE_CODE_USE_BEDROCK: undefined,
  };
  const build = await withEnv(serverEnv, () => captureOptions({ buildIsolation: { reviewToolUse: () => ({ allow: true }) } }));
  for (const name of ['STUDIO_TEST_SERVER_SECRET', 'DATABASE_URL', 'GITHUB_TOKEN', 'LD_PRELOAD', 'AWS_REGION']) {
    assert.equal(build.env[name], undefined, `${name} stays out of the build turn`);
  }
  for (const name of ['ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'LC_ALL', 'LANG', 'TERM', 'HTTPS_PROXY']) {
    assert.equal(build.env[name], serverEnv[name as keyof typeof serverEnv], `${name} reaches Claude Code`);
  }
  assert.equal(build.env.PATH, process.env.PATH);
  assert.equal(build.env.HOME, process.env.HOME);
  assert.ok(build.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, 'the runtime keeps its own variable');
  assert.ok(Object.keys(build.env).every(name => /^(PATH|HOME|USER|SHELL|TMPDIR|LANG|TERM|NODE_EXTRA_CA_CERTS|ANTHROPIC_\w+|LC_\w+|CLAUDE_\w+|https?_proxy|no_proxy)$/i.test(name)), Object.keys(build.env).join(' '));

  // Cloud credentials only when Claude Code authenticates through that cloud.
  const bedrock = await withEnv({ ...serverEnv, CLAUDE_CODE_USE_BEDROCK: '1' }, () => captureOptions({ buildIsolation: { reviewToolUse: () => ({ allow: true }) } }));
  assert.equal(bedrock.env.AWS_REGION, 'us-east-1');
  assert.equal(bedrock.env.GITHUB_TOKEN, undefined);

  // The commit identity and cache locations from the build runner are added on top; nothing else is.
  const sandboxed = await captureOptions({
    buildIsolation: {
      reviewToolUse: () => ({ allow: true }),
      env: { GIT_AUTHOR_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test', UV_CACHE_DIR: '/w/.studio-cache/uv', NODE_OPTIONS: '--require /tmp/x.js' },
    },
  });
  assert.equal(sandboxed.env.GIT_AUTHOR_NAME, 'Owner');
  assert.equal(sandboxed.env.GIT_COMMITTER_EMAIL, 'owner@example.test');
  assert.equal(sandboxed.env.UV_CACHE_DIR, '/w/.studio-cache/uv');
  assert.equal(sandboxed.env.NODE_OPTIONS, undefined);

  // Ordinary chat turns still forward the whole environment.
  const chat = await withEnv(serverEnv, () => captureOptions({}));
  assert.equal(chat.env.STUDIO_TEST_SERVER_SECRET, 'server-only');
});
