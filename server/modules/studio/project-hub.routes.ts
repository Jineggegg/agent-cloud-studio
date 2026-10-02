import express from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';
import type { StudioProjectInput, StudioTaskInput } from '@/shared/types.js';

import type { createProjectHubService } from './project-hub.service.js';
import type { createProjectMailService } from './project-mail.service.js';

function text(value: unknown) {
  if (typeof value !== 'string') throw new AppError('字段格式无效', { statusCode: 400 });
  return value;
}
function user(req: express.Request) {
  const id = Number((req as express.Request & { user?: { id: number } }).user?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('需要登录', { statusCode: 401 });
  return id;
}
function projectInput(body: Record<string, unknown>): StudioProjectInput {
  if (!Array.isArray(body.modules) || !body.modules.every(item => typeof item === 'string') ||
      !Array.isArray(body.providers) || !body.providers.every(item => typeof item === 'string')) {
    throw new AppError('项目模块或助手格式无效', { statusCode: 400 });
  }
  const links = body.links === undefined ? [] : body.links;
  if (!Array.isArray(links) || !links.every(link => link && typeof link === 'object' && typeof link.label === 'string' && typeof link.url === 'string')) {
    throw new AppError('网站链接格式无效', { statusCode: 400 });
  }
  return {
    name: text(body.name), description: text(body.description), workspacePath: text(body.workspacePath),
    modules: body.modules as StudioProjectInput['modules'], providers: body.providers as StudioProjectInput['providers'],
    // Older clients omit icon, links and remote fields; the service validates every value.
    tone: body.tone === undefined ? 'stone' : text(body.tone), glyph: body.glyph === undefined ? 'folder' : text(body.glyph),
    links: links.map(link => ({ label: link.label as string, url: link.url as string })),
    remoteHost: body.remoteHost === undefined ? '' : text(body.remoteHost),
    remoteDir: body.remoteDir === undefined ? '' : text(body.remoteDir),
  };
}
function taskInput(body: Record<string, unknown>): StudioTaskInput {
  const provider = text(body.provider);
  if (!['claude', 'codex', 'cursor', 'opencode'].includes(provider)) throw new AppError('助手无效', { statusCode: 400 });
  return { title: text(body.title), prompt: text(body.prompt), provider: provider as StudioTaskInput['provider'] };
}

/** Mounted by studio.module behind authentication; performs transport validation only. */
export function createProjectHubRouter(hub: ReturnType<typeof createProjectHubService>, mail: ReturnType<typeof createProjectMailService>) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Before the /:id routes, which would otherwise read "workbench" as a project id.
  router.post('/workbench/launch', asyncHandler(async (req, res) => { user(req); res.json(await hub.launchWorkbench(text(req.body?.provider))); }));
  router.get('/', asyncHandler(async (req, res) => { res.json(hub.list(user(req))); }));
  router.post('/', asyncHandler(async (req, res) => { res.status(201).json(hub.create(user(req), projectInput(req.body ?? {}))); }));
  router.get('/:id', asyncHandler(async (req, res) => { res.json(hub.get(user(req), String(req.params.id))); }));
  router.put('/:id', asyncHandler(async (req, res) => { res.json(hub.update(user(req), String(req.params.id), projectInput(req.body ?? {}))); }));
  router.delete('/:id', asyncHandler(async (req, res) => { res.json(hub.remove(user(req), String(req.params.id))); }));
  router.post('/:id/launch', asyncHandler(async (req, res) => { res.json(await hub.launch(user(req), String(req.params.id), text(req.body?.provider))); }));
  router.post('/:id/remote-launch', asyncHandler(async (req, res) => { res.json(hub.launchRemote(user(req), String(req.params.id), text(req.body?.agent))); }));
  router.get('/:id/links/status', asyncHandler(async (req, res) => { res.json(await hub.linkStatus(user(req), String(req.params.id))); }));
  router.get('/:id/sessions', asyncHandler(async (req, res) => { res.json(hub.sessions(user(req), String(req.params.id))); }));
  router.get('/:id/tasks', asyncHandler(async (req, res) => { res.json(hub.tasks(user(req), String(req.params.id))); }));
  router.post('/:id/tasks', asyncHandler(async (req, res) => { res.status(201).json(hub.saveTask(user(req), String(req.params.id), taskInput(req.body ?? {}))); }));
  router.put('/:id/tasks/:taskId', asyncHandler(async (req, res) => { res.json(hub.saveTask(user(req), String(req.params.id), taskInput(req.body ?? {}), String(req.params.taskId))); }));
  router.post('/:id/tasks/:taskId/schedule', asyncHandler(async (req, res) => {
    res.status(201).json(hub.scheduleTask(user(req), String(req.params.id), String(req.params.taskId), text(req.body?.sessionId), text(req.body?.scheduledFor)));
  }));
  router.get('/:id/mail/status', asyncHandler(async (req, res) => { res.json(mail.status(user(req), String(req.params.id))); }));
  // The door the page is on (Origin, else Host) decides where Google calls back (docs/network.md).
  router.post('/:id/mail/connect', asyncHandler(async (req, res) => {
    res.json(mail.begin(user(req), String(req.params.id), { origin: req.get('origin'), host: req.get('host') }));
  }));
  router.get('/:id/mail/messages', asyncHandler(async (req, res) => {
    const query = req.query.q === undefined ? '' : text(req.query.q);
    res.json(await mail.search(user(req), String(req.params.id), query));
  }));
  router.get('/:id/mail/messages/:messageId', asyncHandler(async (req, res) => { res.json(await mail.message(user(req), String(req.params.id), String(req.params.messageId))); }));
  return router;
}

/** Mounted before authentication by studio.module; OAuth state binds the callback to a signed-in user and project. */
export function createProjectMailCallbackRouter(mail: ReturnType<typeof createProjectMailService>) {
  const router = express.Router();
  router.get('/', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(await mail.complete(text(req.query.state), text(req.query.code)));
  }));
  return router;
}
