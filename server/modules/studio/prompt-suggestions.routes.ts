import express from 'express';

import type { StudioPromptSuggestionInput } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createPromptSuggester } from './prompt-suggestions.service.js';

const ASSISTANTS: readonly StudioPromptSuggestionInput['assistant'][] = ['claude', 'codex', 'deepseek', 'assistant'];
const ROLES: readonly StudioPromptSuggestionInput['turns'][number]['role'][] = ['user', 'assistant', 'tool'];
// The composers send only the conversation tail; these bounds keep a request small whatever a client sends.
const MAX_TURNS = 24;
const MAX_TURN_TEXT = 8000;
const MAX_TOTAL_TEXT = 60_000;

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}

function invalid(message: string): never {
  throw new AppError(message, { statusCode: 400, code: 'SUGGESTION_INVALID' });
}

// `{ assistant, turns: [{ role, text }] }` with known roles, non-empty texts and bounded sizes.
function suggestionInput(body: unknown): StudioPromptSuggestionInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('请求格式无效');
  const fields = body as Record<string, unknown>;
  const assistant = fields.assistant ?? 'assistant';
  if (typeof assistant !== 'string' || !(ASSISTANTS as readonly string[]).includes(assistant)) invalid('助手类型无效');
  if (!Array.isArray(fields.turns) || !fields.turns.length || fields.turns.length > MAX_TURNS) invalid(`对话应为 1 到 ${MAX_TURNS} 条`);
  let total = 0;
  const turns = fields.turns.map((turn: unknown) => {
    const entry = turn && typeof turn === 'object' && !Array.isArray(turn) ? turn as Record<string, unknown> : {};
    if (typeof entry.role !== 'string' || !(ROLES as readonly string[]).includes(entry.role)) invalid('对话角色无效');
    if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > MAX_TURN_TEXT) invalid('对话内容无效');
    total += entry.text.length;
    return { role: entry.role as StudioPromptSuggestionInput['turns'][number]['role'], text: entry.text };
  });
  if (total > MAX_TOTAL_TEXT) invalid('对话内容太长');
  return { assistant: assistant as StudioPromptSuggestionInput['assistant'], turns };
}

/**
 * Used by studio.module, mounted at /api/studio/suggestions behind authentication: the chat composers' suggested
 * next message for the conversation tail they send. A client that goes away cancels the DeepSeek call.
 */
export function createPromptSuggestionsRouter(suggester: ReturnType<typeof createPromptSuggester>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/', asyncHandler(async (req, res) => {
    const userId = user(req);
    const input = suggestionInput(req.body);
    const aborted = new AbortController();
    res.on('close', () => { if (!res.writableEnded) aborted.abort(); });
    res.json(await suggester.suggest(userId, input, aborted.signal));
  }));
  return router;
}
