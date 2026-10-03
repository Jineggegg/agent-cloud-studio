import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createWorkbenchActivityService } from './workbench-activity.service.js';
import type { createWorkbenchService } from './workbench.service.js';
import type { createWorkbenchThreadsService } from './workbench-threads.service.js';

const SEGMENT_KINDS = ['agent', 'deepseek'] as const;
const PROVIDERS = ['claude', 'codex', 'deepseek'] as const;

function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}

function invalid(message: string): never {
  throw new AppError(message, { statusCode: 400, code: 'WORKBENCH_INVALID' });
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalid(`${field}格式无效`);
  return value;
}

function optionalText(value: unknown, field: string, limit: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return text(value, field, limit);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(`${field}无效`);
  return value as T;
}

function fields(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field}格式无效`);
  return value as Record<string, unknown>;
}

// A stretch of a conversation: `{ kind: 'agent' | 'deepseek', id }`, optionally with the model label the chat showed.
function segment(value: unknown, field: string) {
  const body = fields(value, field);
  return {
    kind: oneOf(body.kind, SEGMENT_KINDS, `${field}类型`),
    id: text(body.id, `${field}编号`, 200),
    modelLabel: optionalText(body.modelLabel, `${field}模型`, 120),
  };
}

/**
 * Used by studio.module, mounted at /api/studio/workbench behind authentication, for the workbench shell: the hub
 * links, the project switcher's running / needs-you marks (with the activity service), and (with the threads service) conversations handed between providers — the handoff summary, the link
 * between the sessions, renaming and forgetting a chain.
 */
export function createWorkbenchRouter(
  service: ReturnType<typeof createWorkbenchService>,
  threads?: ReturnType<typeof createWorkbenchThreadsService>,
  activity?: Pick<ReturnType<typeof createWorkbenchActivityService>, 'snapshot'>,
) {
  const router = express.Router();
  router.get('/hub-links', asyncHandler(async (req, res) => { res.json(service.hubLinks(user(req))); }));
  // The project switcher's marks: { projects: { [ideProjectId]: { running, attention, attentionSessionIds } } }.
  if (activity) {
    router.get('/activity', asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await activity.snapshot(user(req)));
    }));
  }
  if (!threads) return router;

  router.get('/threads', asyncHandler(async (req, res) => {
    res.json(threads.list(user(req), text(req.query.projectId, '项目', 200)));
  }));
  router.post('/handoffs', asyncHandler(async (req, res) => {
    const userId = user(req);
    const body = fields(req.body, '请求');
    const from = segment(body.from, '来源会话');
    res.json(await threads.handoff(userId, {
      projectId: text(body.projectId, '项目', 200),
      from: { kind: from.kind, id: from.id },
      toProvider: oneOf(body.toProvider, PROVIDERS, '目标服务'),
      fromModelLabel: from.modelLabel,
    }));
  }));
  router.post('/threads', asyncHandler(async (req, res) => {
    const userId = user(req);
    const body = fields(req.body, '请求');
    res.status(201).json(threads.link(userId, {
      projectId: text(body.projectId, '项目', 200),
      title: optionalText(body.title, '名称', 200) ?? '',
      from: segment(body.from, '来源会话'),
      to: segment(body.to, '新会话'),
    }));
  }));
  router.patch('/threads/:threadId', asyncHandler(async (req, res) => {
    const userId = user(req);
    res.json(threads.rename(userId, text(req.params.threadId, '对话', 200), text(fields(req.body, '请求').title, '名称', 200)));
  }));
  router.delete('/threads/:threadId', asyncHandler(async (req, res) => {
    threads.remove(user(req), text(req.params.threadId, '对话', 200));
    res.json({ ok: true });
  }));
  return router;
}
