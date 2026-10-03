import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type Database from 'better-sqlite3';

import type {
  StudioAgentProvider, StudioLinkStatus, StudioProductKind, StudioProjectAutomationDefaults, StudioProjectInput, StudioProjectLink,
  StudioProjectModule, StudioProjectRecord, StudioRemoteLaunch, StudioTaskInput,
} from '@/shared/types.js';
import { AppError, isSafeRemoteDirectory } from '@/shared/utils.js';

type Dependencies = {
  database: Database.Database;
  // Default workspaces for the built-in projects; empty when not present on this machine.
  professorPath?: string;
  snrPath?: string;
  trading212Path?: string;
  resolveWorkspace: (directory: string) => Promise<{ projectId: string; path: string }>;
  listSessions: (directory: string) => { id: string; provider: string; title: string }[];
  pendingSchedules: (userId: number, directory: string) => number;
  schedule: (input: { userId: number; sessionId: string; content: string; scheduledFor: string }) => { id: string };
  // Removes data other services keep for a project (DeepSeek conversations, mail tokens).
  forget?: (userId: number, projectId: string) => void;
  // Quick-browse links for the built-in Super Professor project (from server config).
  professorLinks?: StudioProjectLink[];
  // Names of SSH hosts the server owner configured; projects may only point at these.
  remoteHosts?: () => string[];
  // Built-in remote projects, one per configured host that has a default directory.
  remoteSeeds?: () => { host: string; label: string; dir: string }[];
  // Builds the terminal command for a remote agent from validated host, directory and agent.
  remoteCommand?: (host: string, dir: string, agent: 'claude' | 'codex' | 'shell') => StudioRemoteLaunch;
  // Checks whether links answer and may be framed; never returns page bodies.
  checkLinks?: (links: StudioProjectLink[]) => Promise<StudioLinkStatus[]>;
  // The scratch directory home-screen widgets open new agent sessions in, created on first use.
  workbench?: () => Promise<string>;
};

const MODULES = ['agents', 'mail', 'automations', 'snr-lab', 'trading212'];
// Cursor and OpenCode are hidden: a project saved with either now runs Claude Code instead (offeredProviders).
const AGENTS: StudioAgentProvider[] = ['claude', 'codex'];
const HIDDEN_AGENTS: string[] = ['cursor', 'opencode'];
const PROVIDERS = [...AGENTS, 'deepseek'];
const TONES = ['sage', 'clay', 'slate', 'graphite', 'sand', 'stone', 'moss', 'rose'];
const GLYPHS = ['activity', 'graduation', 'candles', 'mail', 'folder', 'terminal', 'sparkles', 'book', 'chart', 'globe'];
const PRODUCTS: StudioProductKind[] = ['snr', 'professor', 'trading212', 'mail', 'custom'];
// Every project may use these; each product adds its own. A module a project already has stays allowed, so an
// older project can still switch it off.
const GENERIC_MODULES: StudioProjectModule[] = ['agents', 'automations'];
const PRODUCT_MODULES: Record<StudioProductKind, StudioProjectModule[]> = {
  snr: ['snr-lab'], professor: [], trading212: ['trading212'], mail: ['mail'], custom: [],
};
const MODULE_NAMES: Record<StudioProjectModule, string> = {
  agents: 'AI 助手', automations: '自动化', 'snr-lab': 'K 线实验室', trading212: '股票分析', mail: '邮箱',
};
const DEFAULT_AUTOMATION: StudioProjectAutomationDefaults = { notify: true, mailAccountId: '', morningTime: '08:00' };
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAIL_ACCOUNT_ID = /^[A-Za-z0-9-]{1,100}$/;

// A project's providers with a hidden agent (Cursor, OpenCode) replaced by Claude Code, without duplicates.
function offeredProviders(providers: StudioProjectInput['providers']): StudioProjectInput['providers'] {
  const mapped = providers.map(provider => HIDDEN_AGENTS.includes(provider) ? 'claude' : provider);
  return [...new Set(mapped)];
}

function fail(message: string, statusCode = 400): never {
  throw new AppError(message, { statusCode, code: 'PROJECT_HUB_ERROR' });
}

// Projects saved before products existed: the built-ins are recognised by their integration module, or for
// 超级教授 by its name or its conventional folder; a project whose only integration is mail is the 邮件 product.
function inferProduct(config: StudioProjectInput): StudioProductKind {
  if (config.modules.includes('snr-lab')) return 'snr';
  if (config.modules.includes('trading212')) return 'trading212';
  const folder = path.posix.basename((config.workspacePath || config.remoteDir || '').replace(/\/+$/, ''));
  if (config.name.trim() === '超级教授' || folder === 'super-professor') return 'professor';
  if (config.modules.includes('mail')) return 'mail';
  return 'custom';
}

// A product-specific module may only be switched on in its own product (or kept where it is already on).
function assertProductModules(product: StudioProductKind, modules: StudioProjectModule[], current: StudioProjectModule[]) {
  const allowed = new Set<StudioProjectModule>([...GENERIC_MODULES, ...PRODUCT_MODULES[product], ...current]);
  const foreign = modules.find(module => !allowed.has(module));
  if (foreign) fail(`「${MODULE_NAMES[foreign]}」不属于这个项目，只能在对应的产品里开启`);
}

const MAX_LINKS = 8;

function validLink(link: StudioProjectLink) {
  if (!link || typeof link.label !== 'string' || typeof link.url !== 'string') return false;
  if (!link.label.trim() || link.label.length > 40 || link.url.length > 500) return false;
  try {
    const url = new URL(link.url);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch { return false; }
}

function validate(input: StudioProjectInput, remoteHosts: string[]) {
  if (!input.name.trim() || input.name.length > 80) fail('项目名称须为 1 到 80 个字符');
  if (input.description.length > 1000 || input.workspacePath.length > 1000) fail('项目说明或路径过长');
  if (input.workspacePath && !path.isAbsolute(input.workspacePath)) fail('工作目录必须为绝对路径');
  if (input.modules.some(value => !MODULES.includes(value)) || new Set(input.modules).size !== input.modules.length) fail('项目模块无效');
  if (input.providers.some(value => !PROVIDERS.includes(value)) || new Set(input.providers).size !== input.providers.length) fail('项目模型无效');
  if (input.modules.includes('agents') && !input.providers.length) fail('启用 AI 助手时至少选择一个模型');
  if (!TONES.includes(input.tone) || !GLYPHS.includes(input.glyph)) fail('项目图标无效');
  if (!Array.isArray(input.links) || input.links.length > MAX_LINKS || !input.links.every(validLink)) fail(`网站链接无效（最多 ${MAX_LINKS} 个，http/https）`);
  if (input.remoteHost) {
    if (!remoteHosts.includes(input.remoteHost)) fail('远程主机未在服务器配置中');
    // Home-relative or absolute, no spaces, quotes or parent hops (shared with the remote-hosts service).
    if (!isSafeRemoteDirectory(input.remoteDir)) fail('远程目录无效');
  } else if (input.remoteDir) {
    fail('未选择远程主机时不能设置远程目录');
  }
  if (input.automation !== undefined) {
    const defaults = input.automation;
    if (!defaults || typeof defaults !== 'object' || typeof defaults.notify !== 'boolean' ||
        typeof defaults.mailAccountId !== 'string' || typeof defaults.morningTime !== 'string') fail('通知与自动化设置无效');
    if (defaults.mailAccountId && !MAIL_ACCOUNT_ID.test(defaults.mailAccountId)) fail('默认邮箱无效');
    if (!CLOCK_TIME.test(defaults.morningTime)) fail('“早上”的时间格式应为 HH:MM');
  }
}

/** Used by studio.module and tests for per-user projects (the home-screen icons), drafts and explicit scheduling. */
export function createProjectHubService(deps: Dependencies) {
  const db = deps.database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_projects (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS studio_project_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  function owned(userId: number, id: string): StudioProjectRecord {
    const row = db.prepare('SELECT config, updated_at FROM studio_projects WHERE id = ? AND user_id = ?').get(id, userId) as { config: string; updated_at: string } | undefined;
    if (!row) fail('项目不存在', 404);
    // Projects saved before icons, links, remote hosts or automation defaults existed get neutral defaults.
    const stored = { tone: 'stone', glyph: 'folder', links: [], remoteHost: '', remoteDir: '', ...JSON.parse(row.config) } as StudioProjectInput & { product?: StudioProductKind };
    let product = stored.product;
    if (!product || !PRODUCTS.includes(product)) {
      // Decided once and stored (without touching updated_at), so switching a module off later never changes it.
      product = inferProduct(stored);
      db.prepare('UPDATE studio_projects SET config = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.config), product }), id);
    }
    return {
      ...stored, providers: offeredProviders(stored.providers ?? []),
      automation: { ...DEFAULT_AUTOMATION, ...stored.automation }, product, id, updatedAt: row.updated_at,
    };
  }
  const remoteHosts = () => deps.remoteHosts?.() ?? [];
  // `product` is fixed when a project is created; `automation` keeps the stored values when an older client omits it.
  function save(userId: number, id: string, input: StudioProjectInput, product: StudioProductKind, previous?: StudioProjectAutomationDefaults) {
    validate(input, remoteHosts());
    const config: StudioProjectInput & { product: StudioProductKind } = {
      name: input.name.trim(), description: input.description, workspacePath: input.workspacePath.trim(),
      modules: input.modules, providers: input.providers, tone: input.tone, glyph: input.glyph,
      links: input.links.map(link => ({ label: link.label.trim(), url: link.url.trim() })),
      remoteHost: input.remoteHost, remoteDir: input.remoteHost ? input.remoteDir : '',
      automation: input.automation
        ? { notify: input.automation.notify, mailAccountId: input.automation.mailAccountId, morningTime: input.automation.morningTime }
        : previous ?? DEFAULT_AUTOMATION,
      product,
    };
    db.prepare('INSERT INTO studio_projects VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
      .run(id, userId, JSON.stringify(config), new Date().toISOString());
    return owned(userId, id);
  }
  function tasks(userId: number, id: string) {
    owned(userId, id);
    return (db.prepare('SELECT id, config, updated_at FROM studio_project_tasks WHERE project_id = ? ORDER BY updated_at DESC').all(id) as { id: string; config: string; updated_at: string }[])
      .map(row => ({ id: row.id, ...JSON.parse(row.config), updatedAt: row.updated_at }));
  }
  function sessions(userId: number, id: string) {
    const project = owned(userId, id);
    return project.workspacePath ? deps.listSessions(project.workspacePath).filter(item => project.providers.includes(item.provider as StudioAgentProvider)) : [];
  }
  function executionLocked(userId: number, project: StudioProjectRecord) {
    return Boolean(project.workspacePath && deps.pendingSchedules(userId, project.workspacePath));
  }
  // Built-in products seeded once for a new user, in home-screen order.
  function seed(userId: number) {
    const models: StudioProjectInput['providers'] = ['claude', 'codex', 'deepseek'];
    const defaults: (StudioProjectInput & { product: StudioProductKind })[] = [
      { name: 'SNR 3.0', description: 'K 线回放 · HPA / EL / AOI 研究实验室', workspacePath: deps.snrPath ?? '', modules: ['agents', 'snr-lab'], providers: models, tone: 'sage', glyph: 'activity', links: [], remoteHost: '', remoteDir: '', product: 'snr' },
      { name: '超级教授', description: '医疗器械 AI 教学网站', workspacePath: deps.professorPath ?? '', modules: ['agents', 'automations'], providers: models, tone: 'clay', glyph: 'graduation', links: deps.professorLinks ?? [], remoteHost: '', remoteDir: '', product: 'professor' },
      { name: 'Trading 212', description: '股票分析 Studio · 盈亏、曲线与持仓', workspacePath: deps.trading212Path ?? '', modules: ['agents', 'trading212'], providers: models, tone: 'moss', glyph: 'candles', links: [], remoteHost: '', remoteDir: '', product: 'trading212' },
      // Each configured remote host with a default directory becomes its own icon (e.g. AJ), an ordinary project.
      ...(deps.remoteSeeds?.() ?? []).map(seed => ({
        name: seed.label, description: `远程主机 · ${seed.dir}`, workspacePath: '', modules: ['agents'] as StudioProjectInput['modules'],
        providers: ['claude', 'codex', 'deepseek'] as StudioProjectInput['providers'], tone: 'graphite', glyph: 'globe', links: [], remoteHost: seed.host, remoteDir: seed.dir,
        product: 'custom' as const,
      })),
    ];
    db.transaction(() => { for (const { product, ...input } of defaults) save(userId, randomUUID(), input, product); })();
  }
  return {
    list(userId: number) {
      const listIds = () => db.prepare('SELECT id FROM studio_projects WHERE user_id = ? ORDER BY rowid').all(userId) as { id: string }[];
      let ids = listIds();
      if (!ids.length) { seed(userId); ids = listIds(); }
      return ids.map(({ id }) => owned(userId, id));
    },
    get: owned,
    // A new project is the product its modules make it (an ordinary project unless it enables an integration).
    create(userId: number, submitted: StudioProjectInput) {
      const input = { ...submitted, providers: offeredProviders(submitted.providers) };
      validate(input, remoteHosts());
      return save(userId, randomUUID(), input, inferProduct(input));
    },
    update(userId: number, id: string, submitted: StudioProjectInput) {
      const input = { ...submitted, providers: offeredProviders(submitted.providers) };
      const previous = owned(userId, id);
      validate(input, remoteHosts());
      const executionChanged = previous.workspacePath !== input.workspacePath.trim() ||
        previous.providers.some(provider => !input.providers.includes(provider)) ||
        (previous.modules.includes('automations') && !input.modules.includes('automations')) ||
        (previous.modules.includes('agents') && !input.modules.includes('agents'));
      if (executionChanged && executionLocked(userId, previous)) {
        fail('请先取消此项目的待执行任务，再更改工作目录、助手或执行模块', 409);
      }
      assertProductModules(previous.product, input.modules, previous.modules);
      return save(userId, id, input, previous.product, previous.automation);
    },
    remove(userId: number, id: string) {
      const project = owned(userId, id);
      if (executionLocked(userId, project)) fail('请先取消此项目的待执行任务，再删除项目', 409);
      db.transaction(() => {
        db.prepare('DELETE FROM studio_project_tasks WHERE project_id = ?').run(id);
        db.prepare('DELETE FROM studio_projects WHERE id = ? AND user_id = ?').run(id, userId);
      })();
      deps.forget?.(userId, id);
      return { deleted: true };
    },
    // Without a provider the workbench opens a new chat with the agent this device used last; the chat's model menu
    // can still switch between Claude Code, Codex and DeepSeek before the first message.
    async launch(userId: number, id: string, provider: string) {
      const project = owned(userId, id);
      if (project.remoteHost) fail('这个项目运行在远程主机上，请使用远程会话');
      if (provider && !AGENTS.includes(provider as StudioAgentProvider)) fail('该模型不在开发工具中运行');
      if (provider && (!project.modules.includes('agents') || !project.providers.includes(provider as StudioAgentProvider))) fail('该项目未启用此助手');
      if (!provider && !project.modules.includes('agents') && !project.providers.includes('deepseek')) fail('该项目未启用 AI 助手');
      if (!project.workspacePath) fail('请先在设置中填写项目工作目录');
      const workspace = await deps.resolveWorkspace(project.workspacePath);
      const base = `/work/${encodeURIComponent(workspace.projectId)}`;
      return { url: provider ? `${base}?new=${encodeURIComponent(provider)}` : base };
    },
    // A new agent session outside any project: the Claude and Codex widgets open the scratch directory in the
    // workbench, with the same /work URL shape as launch so the browser never goes through the legacy redirect.
    async launchWorkbench(provider: string) {
      if (!AGENTS.includes(provider as StudioAgentProvider)) fail('该模型不在开发工具中运行');
      if (!deps.workbench) fail('工作台不可用', 503);
      const workspace = await deps.resolveWorkspace(await deps.workbench());
      return { url: `/work/${encodeURIComponent(workspace.projectId)}?new=${encodeURIComponent(provider)}` };
    },
    // The server, never the browser, decides the remote command from the project's validated config.
    launchRemote(userId: number, id: string, agent: string) {
      const project = owned(userId, id);
      if (!project.remoteHost) fail('这个项目没有配置远程主机');
      if (!remoteHosts().includes(project.remoteHost)) fail('远程主机已从服务器配置中移除', 409);
      if (agent !== 'shell' && agent !== 'claude' && agent !== 'codex') fail('远程会话只支持 Claude Code、Codex 或终端');
      if (agent !== 'shell' && (!project.modules.includes('agents') || !project.providers.includes(agent))) fail('该项目未启用此助手');
      if (!deps.remoteCommand) fail('远程会话不可用', 503);
      return deps.remoteCommand(project.remoteHost, project.remoteDir, agent);
    },
    async linkStatus(userId: number, id: string) {
      const project = owned(userId, id);
      if (!project.links.length) return [];
      if (!deps.checkLinks) return project.links.map(link => ({ url: link.url, ok: false, status: null, latencyMs: null, frameable: false }));
      return deps.checkLinks(project.links);
    },
    sessions,
    tasks,
    saveTask(userId: number, id: string, input: StudioTaskInput, taskId?: string) {
      const project = owned(userId, id);
      if (!project.modules.includes('automations')) fail('自动化模块未启用');
      if (!input.title.trim() || input.title.length > 120 || !input.prompt.trim() || input.prompt.length > 16000) fail('任务名称或指令无效');
      if (!project.providers.includes(input.provider)) fail('任务助手未在此项目启用');
      if (taskId && !db.prepare('SELECT 1 FROM studio_project_tasks WHERE id = ? AND project_id = ?').get(taskId, id)) fail('任务不存在', 404);
      const target = taskId ?? randomUUID();
      db.prepare('INSERT INTO studio_project_tasks VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at')
        .run(target, id, JSON.stringify({ ...input, title: input.title.trim() }), new Date().toISOString());
      return tasks(userId, id).find(item => item.id === target);
    },
    scheduleTask(userId: number, id: string, taskId: string, sessionId: string, scheduledFor: string) {
      const project = owned(userId, id);
      if (!project.modules.includes('automations') || !project.modules.includes('agents')) fail('请先启用助手与自动化模块');
      const task = tasks(userId, id).find(item => item.id === taskId);
      if (!task) fail('任务不存在', 404);
      if (!project.providers.includes(task.provider)) fail('任务助手未在此项目启用');
      if (!sessions(userId, id).some(item => item.id === sessionId && item.provider === task.provider)) fail('请选择此项目下匹配助手的会话');
      const instant = new Date(scheduledFor);
      if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) fail('执行时间必须在未来');
      return deps.schedule({
        userId, sessionId, content: task.prompt,
        scheduledFor: instant.toISOString(),
      });
    },
  };
}
