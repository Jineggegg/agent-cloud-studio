import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { StudioMemoryToolCaller } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type Options = {
  // The shared server's streamable-HTTP endpoint (STUDIO_MEMORY_URL), e.g. http://127.0.0.1:8770/mcp.
  url: string;
  // Injected by tests to control the fail-fast window.
  now?: () => number;
};
type CallOptions = { signal?: AbortSignal; timeoutMs?: number };

const CALL_TIMEOUT_MS = 8000;
const PING_TIMEOUT_MS = 3000;
// After a failed connection, calls fail at once for this long instead of each waiting on a dead server.
const RETRY_AFTER_MS = 10_000;

function unavailable(): never {
  throw new AppError('共享记忆服务未运行或无法连接', { statusCode: 503, code: 'MEMORY_UNAVAILABLE' });
}

// Tool results arrive as structured content ({ result }) when the tool declares an output schema, else as text.
function decode(result: Record<string, unknown>) {
  const text = Array.isArray(result.content)
    ? result.content.map(part => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('\n')
    : '';
  if (result.isError) {
    throw new AppError(text.trim().slice(0, 300) || '记忆工具调用失败', { statusCode: 502, code: 'MEMORY_TOOL_ERROR' });
  }
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && 'result' in structured) return (structured as { result: unknown }).result;
  if (structured !== undefined) return structured;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

/**
 * Used by studio.module to give the memory service (routes and the DeepSeek bridge) one MCP session with the
 * shared basic-memory server. It connects lazily, shares the session between concurrent callers, reconnects
 * once when a reused session has gone away (the server restarted), and fails fast for a few seconds after a
 * failed connection so a stopped server never slows DeepSeek replies down.
 */
export function createMemoryMcpClient(options: Options): StudioMemoryToolCaller {
  const now = options.now ?? Date.now;
  let session: Promise<Client> | null = null;
  let downUntil = 0;

  async function open(timeoutMs: number) {
    const client = new Client({ name: 'agent-cloud-studio', version: '6.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(options.url));
    await client.connect(transport, { timeout: timeoutMs });
    return client;
  }
  function connect(timeoutMs: number) {
    if (now() < downUntil) unavailable();
    if (!session) {
      const opening = open(timeoutMs);
      session = opening;
      opening.catch(() => {
        if (session === opening) session = null;
        downUntil = now() + RETRY_AFTER_MS;
      });
    }
    return session;
  }
  function drop(client: Promise<Client>) {
    if (session === client) session = null;
    void client.then(value => value.close()).catch(() => {});
  }

  async function run<T>(work: (client: Client) => Promise<T>, { signal, timeoutMs }: Required<Pick<CallOptions, 'timeoutMs'>> & CallOptions): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const reused = session !== null;
      const pending = connect(timeoutMs);
      let client: Client;
      try { client = await pending; } catch { unavailable(); }
      try {
        return await work(client);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (signal?.aborted) throw signal.reason;
        // A slow answer on a session that did connect: the server is up but busy (its first call after a long idle
        // can take seconds). Keep the session and do not start the fail-fast window, which would report it as down.
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          throw new AppError('共享记忆服务响应超时，请稍后重试', { statusCode: 504, code: 'MEMORY_TIMEOUT' });
        }
        // A protocol error (unknown tool, invalid arguments) comes from a healthy server: keep the session.
        if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) {
          throw new AppError(error.message.slice(0, 300) || '记忆工具调用失败', { statusCode: 502, code: 'MEMORY_TOOL_ERROR' });
        }
        drop(pending);
        // A fresh session that fails means the server is really unreachable; a reused one may just be stale.
        if (!reused) {
          downUntil = now() + RETRY_AFTER_MS;
          unavailable();
        }
      }
    }
    unavailable();
  }

  return {
    call(name, args, callOptions = {}) {
      const timeoutMs = callOptions.timeoutMs ?? CALL_TIMEOUT_MS;
      return run(async client => decode(await client.callTool({ name, arguments: args }, undefined, { signal: callOptions.signal, timeout: timeoutMs })),
        { signal: callOptions.signal, timeoutMs });
    },
    async ping(callOptions = {}) {
      const timeoutMs = callOptions.timeoutMs ?? PING_TIMEOUT_MS;
      await run(client => client.ping({ signal: callOptions.signal, timeout: timeoutMs }), { signal: callOptions.signal, timeoutMs });
    },
  };
}
