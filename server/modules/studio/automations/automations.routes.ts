import express from 'express';

import type {
  StudioAutomationAction, StudioAutomationInput, StudioAutomationNotifyWhen, StudioAutomationRepeat, StudioAutomationTrigger,
} from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createAutomationsService } from './automations.service.js';

function invalid(message: string): never {
  throw new AppError(message, { statusCode: 400, code: 'AUTOMATION_INVALID' });
}
function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id?: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}
function text(value: unknown, field: string, limit = 2000) {
  if (typeof value !== 'string' || value.length > limit) invalid(`${field}格式无效`);
  return value;
}
function record(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field}格式无效`);
  return value as Record<string, unknown>;
}
function trigger(value: unknown): StudioAutomationTrigger {
  const fields = record(value, '触发条件');
  if (fields.kind === 'event') return { kind: 'event', event: text(fields.event, '事件', 40) as 'build-failed' };
  if (fields.kind !== 'schedule') invalid('触发条件格式无效');
  const weekday = fields.weekday === null || fields.weekday === undefined ? null : Number(fields.weekday);
  if (weekday !== null && !Number.isInteger(weekday)) invalid('星期格式无效');
  return {
    kind: 'schedule', repeat: text(fields.repeat, '重复方式', 20) as StudioAutomationRepeat,
    time: text(fields.time, '时间', 5), weekday,
    date: fields.date === null || fields.date === undefined ? null : text(fields.date, '日期', 10),
    timeZone: text(fields.timeZone, '时区', 64),
  };
}
function action(value: unknown): StudioAutomationAction {
  const fields = record(value, '动作');
  if (fields.kind === 'notify') return { kind: 'notify', message: text(fields.message, '通知内容', 500) };
  if (fields.kind !== 'mail-digest') invalid('自动化只能读取邮件或发通知');
  if (typeof fields.useAi !== 'boolean') invalid('DeepSeek 开关格式无效');
  return {
    kind: 'mail-digest', accountId: text(fields.accountId, '邮箱', 100), query: text(fields.query ?? '', '关键词', 200),
    notifyWhen: text(fields.notifyWhen, '通知条件', 20) as StudioAutomationNotifyWhen, useAi: fields.useAi,
  };
}
function automationInput(body: unknown): StudioAutomationInput {
  const fields = record(body, '自动化');
  return { title: text(fields.title, '名称', 200), prompt: text(fields.prompt ?? '', '原话', 2000), trigger: trigger(fields.trigger), action: action(fields.action) };
}

/**
 * Used by studio.module, mounted at /api/studio/automations behind authentication: a project's automations (plan
 * from plain words, create, edit, switch on/off, delete, run now) and the owner's Web Push status and test
 * notification. Transport validation only; the automations service checks ownership and meaning.
 */
export function createAutomationsRouter(service: ReturnType<typeof createAutomationsService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/push', asyncHandler(async (req, res) => { res.json(service.pushStatus(user(req))); }));
  router.post('/push/test', asyncHandler(async (req, res) => { res.json(await service.testPush(user(req))); }));
  router.get('/projects/:projectId', asyncHandler(async (req, res) => { res.json(service.list(user(req), String(req.params.projectId))); }));
  router.post('/projects/:projectId/plan', asyncHandler(async (req, res) => {
    const userId = user(req);
    const body = record(req.body ?? {}, '请求');
    res.json(await service.plan(userId, String(req.params.projectId), text(body.text, '描述', 2000), text(body.timeZone, '时区', 64)));
  }));
  router.post('/projects/:projectId', asyncHandler(async (req, res) => {
    const userId = user(req);
    res.status(201).json(service.create(userId, String(req.params.projectId), automationInput(req.body)));
  }));
  router.put('/:id', asyncHandler(async (req, res) => {
    const userId = user(req);
    res.json(service.update(userId, String(req.params.id), automationInput(req.body)));
  }));
  router.patch('/:id', asyncHandler(async (req, res) => {
    const userId = user(req);
    const enabled = record(req.body ?? {}, '请求').enabled;
    if (typeof enabled !== 'boolean') invalid('开关格式无效');
    res.json(service.setEnabled(userId, String(req.params.id), enabled));
  }));
  router.delete('/:id', asyncHandler(async (req, res) => { res.json(service.remove(user(req), String(req.params.id))); }));
  router.post('/:id/run', asyncHandler(async (req, res) => { res.json(await service.runNow(user(req), String(req.params.id))); }));
  return router;
}
