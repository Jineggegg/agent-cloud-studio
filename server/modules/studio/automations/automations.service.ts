import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type {
  StudioAutomationAction, StudioAutomationInput, StudioAutomationPlan, StudioAutomationRecord, StudioAutomationRun, StudioAutomationTrigger,
  StudioProjectRecord, StudioPushMessage, StudioPushStatus,
} from '@/shared/types.js';
import { AppError, isValidTimeZone, zonedDateParts, zonedTimeToInstant } from '@/shared/utils.js';

import { planAutomation } from './automation-planner.service.js';

// The parts of a Studio mail account and listing an automation reads (the mail service returns more).
type MailAccountSummary = { id: string; provider: string; email: string };
type MailMessageSummary = { id: string; subject: string; from: string; fromAddress: string; date: string; snippet: string; unread: boolean };
// What DeepSeek is shown of one new mail: sender, subject, date and the short preview, never the body.
type DigestMail = { from: string; subject: string; date: string; snippet: string };
type Dependencies = {
  database: Database.Database;
  // The signed-in owner's project; throws a 404 AppError for anyone else's.
  project: (userId: number, projectId: string) => StudioProjectRecord;
  // The Studio mail service (read-only): accounts and the newest messages of one account matching a search.
  mail: {
    accounts(userId: number): { accounts: MailAccountSummary[] };
    messages(userId: number, input: { accountId: string; query: string; limit: number }): Promise<{ messages: MailMessageSummary[]; errors: { message: string }[] }>;
  };
  // Web Push to the owner's subscribed browsers (a fake in tests).
  push: {
    status(userId: number): StudioPushStatus;
    send(userId: number, message: StudioPushMessage): Promise<StudioPushStatus & { delivered: number }>;
  };
  // DeepSeek, when the owner has a key: reads requests the rules do not understand and judges new mail.
  ai?: {
    available(userId: number): boolean;
    interpret(userId: number, text: string, hint: string): Promise<unknown>;
    summarise(userId: number, input: { query: string; messages: DigestMail[] }): Promise<{ important: boolean; summary: string }>;
  };
  now?: () => number;
};
type AutomationRow = {
  id: string; user_id: number; project_id: string; config: string; enabled: number; next_run_at: string | null; cursor: string | null;
  last_run_at: string | null; last_status: StudioAutomationRun['status'] | null; last_summary: string | null; created_at: string; updated_at: string;
};
// Where a mail digest left off: when it last read and which messages it already reported.
type MailCursor = { at: string; ids: string[] };
type Outcome = Omit<StudioAutomationRun, 'at'>;

const MAX_PER_PROJECT = 20;
const MAX_TITLE = 40;
const MAX_PROMPT = 500;
const MAX_QUERY = 60;
const MAX_MESSAGE = 120;
const MAX_SUMMARY = 500;
const MAX_PUSH_BODY = 240;
const MAIL_LIMIT = 30;
const SEEN_IDS = 60;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// A run due while the server was down is made up when it comes back within this window, and skipped after it.
const CATCH_UP_MS = 6 * HOUR_MS;
// A mail can carry a Date well before it reached the inbox; windows overlap by this much (seen ids dedupe).
const MAIL_OVERLAP_MS = 2 * HOUR_MS;
const POLL_MS = 30_000;
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REPEATS = ['once', 'hourly', 'daily', 'weekdays', 'weekly'];
const NOTIFY_WHEN = ['important', 'new', 'always'];
const COLUMNS = 'id, user_id, project_id, config, enabled, next_run_at, cursor, last_run_at, last_status, last_summary, created_at, updated_at';
// C0/C1 controls and direction overrides never reach a notification or the list.
const UNSAFE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g;

function fail(message: string, statusCode = 400, code = 'AUTOMATION_ERROR'): never {
  throw new AppError(message, { statusCode, code });
}

function oneLine(value: string, limit: number) {
  return value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// The first instant after `after` the trigger fires, or null (events, a one-off already past).
function nextRun(trigger: StudioAutomationTrigger, after: number): number | null {
  if (trigger.kind !== 'schedule') return null;
  const [hour, minute] = trigger.time.split(':').map(Number);
  const zone = trigger.timeZone;
  if (trigger.repeat === 'once') {
    const [year, month, day] = (trigger.date ?? '').split('-').map(Number);
    const at = zonedTimeToInstant({ year, month, day, hour, minute }, zone);
    return at > after ? at : null;
  }
  const local = zonedDateParts(after, zone);
  if (trigger.repeat === 'hourly') {
    let at = zonedTimeToInstant({ year: local.year, month: local.month, day: local.day, hour: local.hour, minute }, zone);
    while (at <= after) at += HOUR_MS;
    return at;
  }
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const weekday = day.getUTCDay();
    if (trigger.repeat === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (trigger.repeat === 'weekly' && weekday !== trigger.weekday) continue;
    const at = zonedTimeToInstant({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute }, zone);
    if (at > after) return at;
  }
  return null;
}

// How far back the first run of a mail digest reads: one period of its schedule.
function lookback(trigger: StudioAutomationTrigger) {
  if (trigger.kind !== 'schedule') return DAY_MS;
  return trigger.repeat === 'hourly' ? HOUR_MS : trigger.repeat === 'weekly' ? 7 * DAY_MS : trigger.repeat === 'weekdays' ? 3 * DAY_MS : DAY_MS;
}

function readCursor(value: string | null): MailCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as MailCursor;
    return typeof parsed.at === 'string' && Array.isArray(parsed.ids) ? parsed : null;
  } catch { return null; }
}

function clockLabel(instant: number, timeZone: string) {
  const parts = zonedDateParts(instant, timeZone);
  return `${parts.month}月${parts.day}日 ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/**
 * Used by studio.module (mounted at /api/studio/automations) and its tests: per-project automations the owner
 * describes in plain words. Each one is a schedule or a Studio event plus an action that stays inside Studio — a
 * read-only mail digest of one connected mailbox, summarised for the owner (by DeepSeek when available), or a Web
 * Push notification. A 30-second poll runs due schedules; `handleEvent` runs event automations (a failed AI build).
 */
export function createAutomationsService(deps: Dependencies) {
  const db = deps.database;
  const now = deps.now ?? Date.now;
  // Automations running in this process, so a slow run is never started twice (poll, event or 立即运行).
  const running = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_automations (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, project_id TEXT NOT NULL, config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, cursor TEXT,
      last_run_at TEXT, last_status TEXT, last_summary TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_automations_due ON studio_automations (enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS studio_automations_project ON studio_automations (user_id, project_id);
  `);

  const iso = (instant: number) => new Date(instant).toISOString();
  function config(row: AutomationRow): StudioAutomationInput {
    return JSON.parse(row.config) as StudioAutomationInput;
  }
  function toRecord(row: AutomationRow): StudioAutomationRecord {
    return {
      ...config(row), id: row.id, projectId: row.project_id, enabled: row.enabled === 1, nextRunAt: row.next_run_at,
      lastRun: row.last_run_at && row.last_status ? { at: row.last_run_at, status: row.last_status, summary: row.last_summary ?? '' } : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
  const read = (id: string) => db.prepare(`SELECT ${COLUMNS} FROM studio_automations WHERE id = ?`).get(id) as AutomationRow | undefined;
  function owned(userId: number, id: string) {
    const row = db.prepare(`SELECT ${COLUMNS} FROM studio_automations WHERE id = ? AND user_id = ?`).get(id, userId) as AutomationRow | undefined;
    if (!row) fail('自动化不存在', 404, 'AUTOMATION_NOT_FOUND');
    return row;
  }
  function automationProject(userId: number, projectId: string) {
    const project = deps.project(userId, projectId);
    if (!project.modules.includes('automations')) fail('这个项目没有开启自动化模块', 409, 'AUTOMATION_MODULE_OFF');
    return project;
  }

  function validTrigger(value: StudioAutomationTrigger, at: number): StudioAutomationTrigger {
    if (value?.kind === 'event') {
      if (value.event !== 'build-failed') fail('不支持这个触发条件');
      return { kind: 'event', event: 'build-failed' };
    }
    if (value?.kind !== 'schedule' || !REPEATS.includes(value.repeat)) fail('运行时间无效');
    if (!CLOCK_TIME.test(value.time)) fail('时间格式应为 HH:MM');
    if (!isValidTimeZone(value.timeZone)) fail('时区无效');
    const weekday = value.repeat === 'weekly' ? value.weekday : null;
    if (value.repeat === 'weekly' && !(Number.isInteger(weekday) && Number(weekday) >= 0 && Number(weekday) <= 6)) fail('请选择每周哪一天');
    let date: string | null = null;
    if (value.repeat === 'once') {
      const match = DATE.exec(value.date ?? '');
      const check = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
      if (!match || !check || check.getUTCDate() !== Number(match[3]) || check.getUTCMonth() !== Number(match[2]) - 1) fail('日期无效');
      date = value.date;
    }
    const trigger: StudioAutomationTrigger = { kind: 'schedule', repeat: value.repeat, time: value.time, weekday, date, timeZone: value.timeZone };
    if (trigger.repeat === 'once' && nextRun(trigger, at) === null) fail('这个时间已经过了');
    return trigger;
  }
  function validAction(userId: number, value: StudioAutomationAction, trigger: StudioAutomationTrigger): StudioAutomationAction {
    if (value?.kind === 'notify') {
      const message = oneLine(typeof value.message === 'string' ? value.message : '', MAX_MESSAGE);
      if (!message) fail('请写通知内容');
      return { kind: 'notify', message };
    }
    if (value?.kind !== 'mail-digest') fail('自动化只能读取邮件或发通知');
    if (trigger.kind === 'event') fail('构建失败时只能发通知');
    if (typeof value.accountId !== 'string' || !value.accountId) fail('请选择要读取的邮箱');
    if (!deps.mail.accounts(userId).accounts.some(account => account.id === value.accountId)) fail('这个邮箱账户不存在，请重新选择', 400, 'AUTOMATION_MAILBOX_MISSING');
    if (typeof value.query !== 'string' || value.query.length > MAX_QUERY) fail(`关键词最多 ${MAX_QUERY} 个字`);
    if (!NOTIFY_WHEN.includes(value.notifyWhen)) fail('通知条件无效');
    if (typeof value.useAi !== 'boolean') fail('DeepSeek 开关无效');
    return { kind: 'mail-digest', accountId: value.accountId, query: oneLine(value.query, MAX_QUERY), notifyWhen: value.notifyWhen, useAi: value.useAi };
  }
  function validInput(userId: number, input: StudioAutomationInput, at: number): StudioAutomationInput {
    const title = oneLine(typeof input.title === 'string' ? input.title : '', MAX_TITLE);
    if (!title) fail('请给自动化起个名字');
    if (typeof input.prompt !== 'string' || input.prompt.length > MAX_PROMPT) fail(`原话最多 ${MAX_PROMPT} 个字`);
    const trigger = validTrigger(input.trigger, at);
    return { title, prompt: input.prompt.trim(), trigger, action: validAction(userId, input.action, trigger) };
  }

  // Stores a run's outcome as the automation's last run; a mail digest also moves its cursor.
  function record(row: AutomationRow, outcome: Outcome, at: number, cursor?: string): StudioAutomationRun {
    const summary = outcome.summary.slice(0, MAX_SUMMARY);
    db.prepare('UPDATE studio_automations SET last_run_at = ?, last_status = ?, last_summary = ?, cursor = COALESCE(?, cursor) WHERE id = ?')
      .run(iso(at), outcome.status, summary, cursor ?? null, row.id);
    return { at: iso(at), status: outcome.status, summary };
  }

  // Pushes one message unless the project's notifications are off or no device can receive it; says what happened.
  async function push(userId: number, project: StudioProjectRecord, automationId: string, title: string, body: string): Promise<Outcome> {
    if (!project.automation.notify) return { status: 'skipped', summary: `${body}（这个项目的通知已在设置里关闭，没有推送）` };
    const result = await deps.push.send(userId, {
      title: oneLine(title, 80), body: body.slice(0, MAX_PUSH_BODY), tag: `automation:${automationId}`,
      url: `/projects/${encodeURIComponent(project.id)}?tab=automations`,
    });
    if (!result.enabled) return { status: 'skipped', summary: `${body}（推送通知已关闭，没有发出）` };
    if (!result.devices) return { status: 'skipped', summary: `${body}（还没有设备开启通知，没有发出）` };
    if (!result.delivered) return { status: 'error', summary: `${body}（推送服务没有接收这条通知）` };
    return { status: 'notified', summary: body };
  }

  async function mailDigest(row: AutomationRow, project: StudioProjectRecord, automation: StudioAutomationInput, at: number): Promise<{ outcome: Outcome; cursor?: string }> {
    const action = automation.action as Extract<StudioAutomationAction, { kind: 'mail-digest' }>;
    const previous = readCursor(row.cursor);
    const since = previous ? Date.parse(previous.at) - MAIL_OVERLAP_MS : at - lookback(automation.trigger);
    const seen = new Set(previous?.ids ?? []);
    const listing = await deps.mail.messages(row.user_id, { accountId: action.accountId, query: action.query, limit: MAIL_LIMIT });
    if (!listing.messages.length && listing.errors.length) return { outcome: { status: 'error', summary: `读取邮箱失败：${oneLine(listing.errors[0].message, 200)}` } };
    const fresh = listing.messages
      .filter(message => !seen.has(message.id) && message.date && Date.parse(message.date) > since)
      .sort((left, right) => right.date.localeCompare(left.date));
    const cursor = JSON.stringify({ at: iso(at), ids: [...fresh.map(message => message.id), ...seen].slice(0, SEEN_IDS) } satisfies MailCursor);
    const topic = action.query ? `「${action.query.replace(/^from:/, '')}」相关的` : '';
    let summary = `没有新的${topic}邮件`;
    let important = false;
    if (fresh.length) {
      const mails: DigestMail[] = fresh.slice(0, 20).map(message => ({
        from: oneLine(message.from || message.fromAddress, 80), subject: oneLine(message.subject || '（无主题）', 160), date: message.date, snippet: oneLine(message.snippet, 200),
      }));
      // Without DeepSeek (or when it fails) every new matching mail counts, and the summary lists the newest.
      summary = `${fresh.length} 封新的${topic}邮件：${mails.slice(0, 3).map(mail => `${mail.from}「${mail.subject}」`).join('；')}`;
      important = true;
      if (action.useAi && deps.ai?.available(row.user_id)) {
        try {
          const judged = await deps.ai.summarise(row.user_id, { query: action.query, messages: mails });
          summary = oneLine(judged.summary, 400) || summary;
          important = judged.important;
        } catch {
          summary = `${summary}（DeepSeek 暂时不可用，未判断重要性）`;
        }
      }
    }
    const wanted = action.notifyWhen === 'always' || (action.notifyWhen === 'new' && fresh.length > 0) || (action.notifyWhen === 'important' && important);
    if (!wanted) return { outcome: { status: 'quiet', summary: fresh.length ? `${summary}（不重要，没有通知）` : summary }, cursor };
    return { outcome: await push(row.user_id, project, row.id, `${project.name} · 邮件`, summary), cursor };
  }

  // Runs one automation now and records the outcome; never throws.
  async function execute(row: AutomationRow, detail?: string): Promise<StudioAutomationRun> {
    const at = now();
    if (running.has(row.id)) return { at: iso(at), status: 'skipped', summary: '上一次还在运行' };
    running.add(row.id);
    try {
      let project: StudioProjectRecord;
      try { project = deps.project(row.user_id, row.project_id); } catch { return record(row, { status: 'skipped', summary: '项目已不存在' }, at); }
      if (!project.modules.includes('automations')) return record(row, { status: 'skipped', summary: '这个项目的自动化模块已关闭' }, at);
      const automation = config(row);
      if (automation.action.kind === 'notify') {
        const body = detail ? `${automation.action.message}：${oneLine(detail, 160)}` : automation.action.message;
        return record(row, await push(row.user_id, project, row.id, project.name, body), at);
      }
      const { outcome, cursor } = await mailDigest(row, project, automation, at);
      return record(row, outcome, at, cursor);
    } catch (error) {
      return record(row, { status: 'error', summary: error instanceof AppError ? error.message : '运行失败' }, at);
    } finally {
      running.delete(row.id);
    }
  }

  // One poll: every due schedule is claimed (its next run written first, so a crash never repeats it) and run.
  async function tick() {
    const at = now();
    const due = db.prepare(`SELECT ${COLUMNS} FROM studio_automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`).all(iso(at)) as AutomationRow[];
    let ran = 0;
    for (const row of due) {
      if (running.has(row.id)) continue;
      const automation = config(row);
      const scheduledAt = Date.parse(row.next_run_at as string);
      const following = nextRun(automation.trigger, Math.max(at, scheduledAt));
      const claimed = db.prepare('UPDATE studio_automations SET next_run_at = ?, enabled = ? WHERE id = ? AND next_run_at = ?')
        .run(following === null ? null : iso(following), following === null ? 0 : 1, row.id, row.next_run_at).changes;
      if (!claimed) continue;
      if (at - scheduledAt > CATCH_UP_MS) {
        const zone = automation.trigger.kind === 'schedule' ? automation.trigger.timeZone : 'UTC';
        record(row, { status: 'skipped', summary: `错过了 ${clockLabel(scheduledAt, zone)} 这次：当时服务器没有运行` }, at);
        continue;
      }
      await execute(row);
      ran += 1;
    }
    return ran;
  }

  return {
    list(userId: number, projectId: string): StudioAutomationRecord[] {
      deps.project(userId, projectId);
      return (db.prepare(`SELECT ${COLUMNS} FROM studio_automations WHERE user_id = ? AND project_id = ? ORDER BY created_at, rowid`).all(userId, projectId) as AutomationRow[]).map(toRecord);
    },

    // The owner's words as an automation to review; nothing is stored until create.
    async plan(userId: number, projectId: string, text: string, timeZone: string): Promise<StudioAutomationPlan> {
      const project = automationProject(userId, projectId);
      if (!isValidTimeZone(timeZone)) fail('时区无效');
      const aiAvailable = Boolean(deps.ai?.available(userId));
      return planAutomation(text, {
        projectName: project.name, morningTime: project.automation.morningTime, defaultMailAccountId: project.automation.mailAccountId,
        accounts: deps.mail.accounts(userId).accounts.map(account => ({ id: account.id, provider: account.provider, email: account.email })),
        aiAvailable, timeZone, now: now(),
      }, aiAvailable && deps.ai ? (request, hint) => deps.ai!.interpret(userId, request, hint) : undefined);
    },

    create(userId: number, projectId: string, input: StudioAutomationInput): StudioAutomationRecord {
      automationProject(userId, projectId);
      const count = db.prepare('SELECT COUNT(*) AS count FROM studio_automations WHERE user_id = ? AND project_id = ?').get(userId, projectId) as { count: number };
      if (count.count >= MAX_PER_PROJECT) fail(`每个项目最多 ${MAX_PER_PROJECT} 个自动化`, 409, 'AUTOMATION_LIMIT');
      const at = now();
      const automation = validInput(userId, input, at);
      const next = nextRun(automation.trigger, at);
      const id = randomUUID();
      db.prepare(`INSERT INTO studio_automations (id, user_id, project_id, config, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(id, userId, projectId, JSON.stringify(automation), next === null ? null : iso(next), iso(at), iso(at));
      return toRecord(read(id) as AutomationRow);
    },

    // An edit re-plans the next run; a mail digest pointed at another mailbox or search starts reading afresh.
    update(userId: number, id: string, input: StudioAutomationInput): StudioAutomationRecord {
      const row = owned(userId, id);
      automationProject(userId, row.project_id);
      const at = now();
      const automation = validInput(userId, input, at);
      const before = config(row).action;
      const sameMail = before.kind === 'mail-digest' && automation.action.kind === 'mail-digest' &&
        before.accountId === automation.action.accountId && before.query === automation.action.query;
      const next = row.enabled === 1 ? nextRun(automation.trigger, at) : null;
      db.prepare('UPDATE studio_automations SET config = ?, next_run_at = ?, cursor = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(automation), next === null ? null : iso(next), sameMail ? row.cursor : null, iso(at), id);
      return toRecord(read(id) as AutomationRow);
    },

    setEnabled(userId: number, id: string, enabled: boolean): StudioAutomationRecord {
      const row = owned(userId, id);
      const at = now();
      const trigger = config(row).trigger;
      const next = enabled ? nextRun(trigger, at) : null;
      if (enabled && trigger.kind === 'schedule' && next === null) fail('这次提醒的时间已经过了，请先编辑时间', 409, 'AUTOMATION_PAST');
      db.prepare('UPDATE studio_automations SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, next === null ? null : iso(next), iso(at), id);
      return toRecord(read(id) as AutomationRow);
    },

    remove(userId: number, id: string) {
      owned(userId, id);
      db.prepare('DELETE FROM studio_automations WHERE id = ? AND user_id = ?').run(id, userId);
      return { deleted: true };
    },

    // 立即运行: the automation runs once now (even when it is off); its schedule is unchanged.
    async runNow(userId: number, id: string): Promise<StudioAutomationRecord> {
      const row = owned(userId, id);
      automationProject(userId, row.project_id);
      await execute(row);
      return toRecord(read(id) as AutomationRow);
    },

    // Called when something happens in a project (e.g. its AI build failed): its matching automations run now.
    async handleEvent(userId: number, projectId: string, event: 'build-failed', detail: string) {
      const rows = db.prepare(`SELECT ${COLUMNS} FROM studio_automations WHERE user_id = ? AND project_id = ? AND enabled = 1`).all(userId, projectId) as AutomationRow[];
      const matching = rows.filter(row => {
        const trigger = config(row).trigger;
        return trigger.kind === 'event' && trigger.event === event;
      });
      for (const row of matching) await execute(row, detail);
      return matching.length;
    },

    // A deleted project takes its automations with it.
    forgetProject(userId: number, projectId: string) {
      db.prepare('DELETE FROM studio_automations WHERE user_id = ? AND project_id = ?').run(userId, projectId);
    },

    pushStatus(userId: number): StudioPushStatus {
      return deps.push.status(userId);
    },

    // Sends the owner one test notification so they can see a device receives automations.
    async testPush(userId: number) {
      return deps.push.send(userId, { title: 'Agent Cloud Studio', body: '测试通知：这台设备可以收到自动化提醒了。', tag: 'automation:test', url: '/' });
    },

    tick,

    // Starts the poll that runs due schedules (and catches up right away); the timer never keeps the process alive.
    start(intervalMs = POLL_MS) {
      if (timer) return;
      const poll = () => {
        if (polling) return;
        polling = true;
        void tick().catch((error: unknown) => console.error('[studio-automations] poll failed', error instanceof Error ? error.message : error))
          .finally(() => { polling = false; });
      };
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
      const first = setTimeout(poll, 5_000);
      first.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
