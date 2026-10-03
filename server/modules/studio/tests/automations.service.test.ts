import assert from 'node:assert/strict';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import type { StudioAutomationInput, StudioProjectRecord, StudioPushMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createAutomationsService } from '../automations/automations.service.js';

// Monday 5 October 2026, 14:00 in Shanghai (06:00 UTC).
const MONDAY_AFTERNOON = Date.parse('2026-10-05T06:00:00Z');
const SHANGHAI = 'Asia/Shanghai';

type Mail = { id: string; subject: string; from: string; fromAddress: string; date: string; snippet: string; unread: boolean };

function project(overrides: Partial<StudioProjectRecord> = {}): StudioProjectRecord {
  return {
    id: 'prof', name: '超级教授', description: '', workspacePath: '', modules: ['agents', 'automations'], providers: ['claude'], tone: 'clay', glyph: 'graduation',
    links: [], remoteHost: '', remoteDir: '', updatedAt: '', product: 'professor', automation: { notify: true, mailAccountId: '', morningTime: '08:00' }, ...overrides,
  };
}

function fixture(options: { ai?: Parameters<typeof createAutomationsService>[0]['ai']; push?: { enabled: boolean; devices: number } } = {}) {
  const database = new Database(':memory:');
  let clock = MONDAY_AFTERNOON;
  const projects = new Map<string, StudioProjectRecord>([['prof', project()], ['plain', project({ id: 'plain', name: '普通项目', modules: ['agents'] })]]);
  const sent: StudioPushMessage[] = [];
  const mailCalls: { accountId: string; query: string; limit: number }[] = [];
  let inbox: Mail[] = [];
  let mailError: string | null = null;
  const pushState = options.push ?? { enabled: true, devices: 1 };
  const service = createAutomationsService({
    database,
    project(userId, id) {
      const found = projects.get(id);
      if (userId !== 1 || !found) throw new AppError('项目不存在', { statusCode: 404 });
      return found;
    },
    mail: {
      accounts: () => ({ accounts: [{ id: 'gmail-1', provider: 'gmail-imap', email: 'me@example.test' }, { id: 'outlook-1', provider: 'outlook', email: 'me@outlook.test' }] }),
      async messages(_userId, input) {
        mailCalls.push(input);
        return mailError ? { messages: [], errors: [{ message: mailError }] } : { messages: inbox, errors: [] };
      },
    },
    push: {
      status: () => pushState,
      async send(_userId, message) {
        sent.push(message);
        return { ...pushState, delivered: pushState.enabled ? pushState.devices : 0 };
      },
    },
    ai: options.ai,
    now: () => clock,
  });
  return {
    database, service, sent, mailCalls, projects,
    setInbox(mails: Mail[]) { inbox = mails; },
    failMail(message: string | null) { mailError = message; },
    at(instant: number | string) { clock = typeof instant === 'string' ? Date.parse(instant) : instant; },
  };
}

const daily = (time = '08:00'): Extract<StudioAutomationInput['trigger'], { kind: 'schedule' }> => ({ kind: 'schedule', repeat: 'daily', time, weekday: null, date: null, timeZone: SHANGHAI });
const notify = (message = '看一下课程反馈'): StudioAutomationInput => ({ title: '提醒', prompt: '每天早上提醒我看一下课程反馈', trigger: daily(), action: { kind: 'notify', message } });
const digest = (notifyWhen: 'important' | 'new' | 'always' = 'important', useAi = false): StudioAutomationInput => ({
  title: '「超级教授」邮件摘要', prompt: '每天早上读一下我邮箱里超级教授相关的邮件，有重要的就通知我', trigger: daily(),
  action: { kind: 'mail-digest', accountId: 'gmail-1', query: '超级教授', notifyWhen, useAi },
});
const mail = (id: string, date: string, subject = `课程 ${id}`): Mail => ({ id, subject, from: '王老师', fromAddress: 'wang@example.test', date, snippet: '请查看附件', unread: true });

test('automations are created, listed, switched off and on, edited and deleted only by their owner', () => {
  const f = fixture();
  try {
    const created = f.service.create(1, 'prof', notify());
    // Next 08:00 in Shanghai after Monday 14:00 is Tuesday 08:00 (00:00 UTC).
    assert.equal(created.nextRunAt, '2026-10-06T00:00:00.000Z');
    assert.equal(created.enabled, true);
    assert.equal(created.lastRun, null);
    assert.deepEqual(f.service.list(1, 'prof').map(item => item.id), [created.id]);

    const off = f.service.setEnabled(1, created.id, false);
    assert.equal(off.enabled, false);
    assert.equal(off.nextRunAt, null);
    const on = f.service.setEnabled(1, created.id, true);
    assert.equal(on.nextRunAt, '2026-10-06T00:00:00.000Z');

    const edited = f.service.update(1, created.id, { ...notify('写周报'), trigger: { ...daily('20:30') } });
    assert.equal(edited.nextRunAt, '2026-10-05T12:30:00.000Z');
    assert.deepEqual(edited.action, { kind: 'notify', message: '写周报' });

    // Another user sees nothing of it and cannot touch it.
    assert.throws(() => f.service.list(2, 'prof'), /项目不存在/);
    assert.throws(() => f.service.setEnabled(2, created.id, false), /自动化不存在/);
    assert.throws(() => f.service.remove(2, created.id), /自动化不存在/);

    assert.deepEqual(f.service.remove(1, created.id), { deleted: true });
    assert.deepEqual(f.service.list(1, 'prof'), []);
  } finally { f.database.close(); }
});

test('creating checks the project module, the mailbox, the time and that nothing leaves Studio', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.create(1, 'plain', notify()), /没有开启自动化模块/);
    assert.throws(() => f.service.create(1, 'prof', { ...digest(), action: { ...digest().action, accountId: 'someone-else' } as StudioAutomationInput['action'] }), /邮箱账户不存在/);
    assert.throws(() => f.service.create(1, 'prof', { ...notify(), trigger: { ...daily(), time: '25:00' } }), /HH:MM/);
    assert.throws(() => f.service.create(1, 'prof', { ...notify(), trigger: { ...daily(), timeZone: 'Mars/Olympus' } }), /时区/);
    assert.throws(() => f.service.create(1, 'prof', { ...notify(), trigger: { kind: 'schedule', repeat: 'once', time: '08:00', weekday: null, date: '2026-10-05', timeZone: SHANGHAI } }), /已经过了/);
    assert.throws(() => f.service.create(1, 'prof', { ...digest(), trigger: { kind: 'event', event: 'build-failed' } }), /只能发通知/);
    assert.throws(() => f.service.create(1, 'prof', { ...notify(), action: { kind: 'send-mail', to: 'boss@example.test' } as unknown as StudioAutomationInput['action'] }), /只能读取邮件或发通知/);
    assert.deepEqual(f.service.list(1, 'prof'), []);
  } finally { f.database.close(); }
});

test('schedules follow the owner’s time zone: weekdays skip the weekend, weekly picks its day, hourly its minute', () => {
  const f = fixture();
  try {
    // Friday 9 October, 21:00 in Shanghai.
    f.at('2026-10-09T13:00:00Z');
    const weekdays = f.service.create(1, 'prof', { ...notify(), trigger: { ...daily('08:00'), repeat: 'weekdays' } });
    assert.equal(weekdays.nextRunAt, '2026-10-12T00:00:00.000Z');
    const weekly = f.service.create(1, 'prof', { ...notify(), trigger: { ...daily('09:00'), repeat: 'weekly', weekday: 1 } });
    assert.equal(weekly.nextRunAt, '2026-10-12T01:00:00.000Z');
    const hourly = f.service.create(1, 'prof', { ...notify(), trigger: { ...daily('00:15'), repeat: 'hourly' } });
    assert.equal(hourly.nextRunAt, '2026-10-09T13:15:00.000Z');
    const once = f.service.create(1, 'prof', { ...notify(), trigger: { kind: 'schedule', repeat: 'once', time: '15:00', weekday: null, date: '2026-10-10', timeZone: SHANGHAI } });
    assert.equal(once.nextRunAt, '2026-10-10T07:00:00.000Z');
    // London is on summer time until 25 October: 08:00 there is 07:00 UTC, and 08:00 UTC after the change.
    const london = f.service.create(1, 'prof', { ...notify(), trigger: { ...daily('08:00'), timeZone: 'Europe/London' } });
    assert.equal(london.nextRunAt, '2026-10-10T07:00:00.000Z');
    f.at('2026-10-25T09:00:00Z');
    assert.equal(f.service.setEnabled(1, london.id, true).nextRunAt, '2026-10-26T08:00:00.000Z');
  } finally { f.database.close(); }
});

test('a due notification is pushed once through the push sender and the next run is planned', async () => {
  const f = fixture();
  try {
    const created = f.service.create(1, 'prof', notify());
    assert.equal(await f.service.tick(), 0);
    f.at('2026-10-06T00:00:30Z');
    assert.equal(await f.service.tick(), 1);
    assert.equal(await f.service.tick(), 0);
    assert.deepEqual(f.sent, [{ title: '超级教授', body: '看一下课程反馈', tag: `automation:${created.id}`, url: '/projects/prof?tab=automations' }]);
    const [after] = f.service.list(1, 'prof');
    assert.equal(after.nextRunAt, '2026-10-07T00:00:00.000Z');
    assert.deepEqual(after.lastRun, { at: '2026-10-06T00:00:30.000Z', status: 'notified', summary: '看一下课程反馈' });
  } finally { f.database.close(); }
});

test('nothing is pushed when the project’s notifications are off or no device has push on, and the reason is shown', async () => {
  const f = fixture({ push: { enabled: true, devices: 0 } });
  try {
    const created = f.service.create(1, 'prof', notify());
    let result = await f.service.runNow(1, created.id);
    assert.equal(result.lastRun?.status, 'skipped');
    assert.match(result.lastRun?.summary ?? '', /还没有设备开启通知/);
    f.projects.set('prof', project({ automation: { notify: false, mailAccountId: '', morningTime: '08:00' } }));
    const sentBefore = f.sent.length;
    result = await f.service.runNow(1, created.id);
    assert.equal(result.lastRun?.status, 'skipped');
    assert.match(result.lastRun?.summary ?? '', /通知已在设置里关闭/);
    assert.equal(f.sent.length, sentBefore);
  } finally { f.database.close(); }
});

test('a one-off reminder switches itself off after it runs, and a run missed by hours is skipped, not replayed', async () => {
  const f = fixture();
  try {
    const once = f.service.create(1, 'prof', { ...notify('交报告'), trigger: { kind: 'schedule', repeat: 'once', time: '15:00', weekday: null, date: '2026-10-05', timeZone: SHANGHAI } });
    const daily8 = f.service.create(1, 'prof', notify());
    f.at('2026-10-05T07:00:10Z');
    await f.service.tick();
    const reminded = f.service.list(1, 'prof').find(item => item.id === once.id)!;
    assert.equal(reminded.enabled, false);
    assert.equal(reminded.nextRunAt, null);
    assert.equal(reminded.lastRun?.status, 'notified');
    assert.throws(() => f.service.setEnabled(1, once.id, true), /已经过了/);
    // The server was down from Tuesday 08:00 until 15:00: that run is reported as missed and the next is Wednesday.
    f.at('2026-10-06T07:00:00Z');
    await f.service.tick();
    const missed = f.service.list(1, 'prof').find(item => item.id === daily8.id)!;
    assert.equal(missed.lastRun?.status, 'skipped');
    assert.match(missed.lastRun?.summary ?? '', /错过了 10月6日 08:00/);
    assert.equal(missed.nextRunAt, '2026-10-07T00:00:00.000Z');
    assert.equal(f.sent.filter(message => message.body === '看一下课程反馈').length, 0);
  } finally { f.database.close(); }
});

test('a mail digest reads only the chosen mailbox, summarises new mail without DeepSeek and never reports a mail twice', async () => {
  const f = fixture();
  try {
    const created = f.service.create(1, 'prof', digest('important'));
    f.setInbox([mail('m2', '2026-10-05T23:30:00Z', '期中考试安排'), mail('m1', '2026-10-05T12:00:00Z', '课件更新'), mail('old', '2026-10-01T00:00:00Z')]);
    f.at('2026-10-06T00:00:05Z');
    await f.service.tick();
    assert.deepEqual(f.mailCalls, [{ accountId: 'gmail-1', query: '超级教授', limit: 30 }]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].title, '超级教授 · 邮件');
    assert.equal(f.sent[0].url, '/projects/prof?tab=automations');
    assert.equal(f.sent[0].body, '2 封新的「超级教授」相关的邮件：王老师「期中考试安排」；王老师「课件更新」');
    assert.doesNotMatch(f.sent[0].body, /请查看附件/);

    // The next morning nothing new arrived: no push, and the run says so.
    f.at('2026-10-07T00:00:05Z');
    await f.service.tick();
    assert.equal(f.sent.length, 1);
    const [quiet] = f.service.list(1, 'prof');
    assert.deepEqual(quiet.lastRun, { at: '2026-10-07T00:00:05.000Z', status: 'quiet', summary: '没有新的「超级教授」相关的邮件' });

    // A failing mailbox is an error and does not move the digest forward.
    f.failMail('应用专用密码已失效');
    const failed = await f.service.runNow(1, created.id);
    assert.equal(failed.lastRun?.status, 'error');
    assert.match(failed.lastRun?.summary ?? '', /读取邮箱失败：应用专用密码已失效/);
  } finally { f.database.close(); }
});

test('with DeepSeek the digest pushes only what it judges important, and it is shown previews, not bodies', async () => {
  const judged: { query: string; messages: { from: string; subject: string; date: string; snippet: string }[] }[] = [];
  let important = false;
  const f = fixture({
    ai: {
      available: () => true,
      interpret: async () => null,
      async summarise(_userId, input) {
        judged.push(input);
        return { important, summary: important ? '王老师要你周三前确认期中考试安排。' : '只有课程通讯，没有需要处理的邮件。' };
      },
    },
  });
  try {
    const created = f.service.create(1, 'prof', digest('important', true));
    f.setInbox([mail('n1', '2026-10-05T05:00:00Z', '本周通讯')]);
    let result = await f.service.runNow(1, created.id);
    assert.equal(result.lastRun?.status, 'quiet');
    assert.equal(f.sent.length, 0);
    assert.deepEqual(judged[0], { query: '超级教授', messages: [{ from: '王老师', subject: '本周通讯', date: '2026-10-05T05:00:00Z', snippet: '请查看附件' }] });

    important = true;
    f.setInbox([mail('n2', '2026-10-05T05:30:00Z', '期中考试安排'), mail('n1', '2026-10-05T05:00:00Z', '本周通讯')]);
    result = await f.service.runNow(1, created.id);
    assert.equal(result.lastRun?.status, 'notified');
    assert.deepEqual(f.sent.map(message => message.body), ['王老师要你周三前确认期中考试安排。']);
    // Only the mail it had not seen yet went to DeepSeek.
    assert.deepEqual(judged[1].messages.map(message => message.subject), ['期中考试安排']);
  } finally { f.database.close(); }
});

test('“构建失败时” automations run when the project’s AI build fails, with the reason, and only for that project', async () => {
  const f = fixture();
  try {
    const event = f.service.create(1, 'prof', { title: '构建失败通知', prompt: '构建失败时给我发通知', trigger: { kind: 'event', event: 'build-failed' }, action: { kind: 'notify', message: '「超级教授」的 AI 开发失败了' } });
    assert.equal(event.nextRunAt, null);
    f.service.create(1, 'prof', notify());
    assert.equal(await f.service.handleEvent(1, 'other-project', 'build-failed', 'x'), 0);
    assert.equal(await f.service.handleEvent(1, 'prof', 'build-failed', 'AI 没能完成开发'), 1);
    assert.deepEqual(f.sent.map(message => message.body), ['「超级教授」的 AI 开发失败了：AI 没能完成开发']);
    // A failed build opens the project page itself; scheduled runs open its 自动化 tab.
    assert.deepEqual(f.sent.map(message => message.url), ['/projects/prof']);
    f.service.setEnabled(1, event.id, false);
    assert.equal(await f.service.handleEvent(1, 'prof', 'build-failed', 'again'), 0);
    // Deleting the project removes its automations.
    f.service.forgetProject(1, 'prof');
    assert.deepEqual(f.service.list(1, 'prof'), []);
  } finally { f.database.close(); }
});

test('the push status and test notification go through the push sender', async () => {
  const f = fixture({ push: { enabled: true, devices: 2 } });
  try {
    assert.deepEqual(f.service.pushStatus(1), { enabled: true, devices: 2 });
    assert.deepEqual(await f.service.testPush(1), { enabled: true, devices: 2, delivered: 2 });
    assert.equal(f.sent[0].tag, 'automation:test');
  } finally { f.database.close(); }
});

test('an event during startup waits for the first poll, so nothing is pushed before the server is ready', async () => {
  const f = fixture();
  try {
    f.service.create(1, 'prof', { title: '构建失败通知', prompt: '', trigger: { kind: 'event', event: 'build-failed' }, action: { kind: 'notify', message: '开发失败了' } });
    f.service.start(60_000, 20);
    assert.equal(await f.service.handleEvent(1, 'prof', 'build-failed', '服务器重启，开发中断了'), 0);
    assert.equal(f.sent.length, 0);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(f.sent.map(message => message.body), ['开发失败了：服务器重启，开发中断了']);
    // After the first poll events run at once.
    assert.equal(await f.service.handleEvent(1, 'prof', 'build-failed', 'again'), 1);
  } finally {
    f.service.stop();
    f.database.close();
  }
});
