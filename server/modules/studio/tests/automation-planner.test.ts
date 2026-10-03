import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planAutomation } from '../automations/automation-planner.service.js';

// Monday 5 October 2026, 14:00 in Shanghai.
const context = {
  projectName: '超级教授', morningTime: '07:30', defaultMailAccountId: '', aiAvailable: false, timeZone: 'Asia/Shanghai', now: Date.parse('2026-10-05T06:00:00Z'),
  accounts: [{ id: 'gmail-1', provider: 'gmail-imap', email: 'me@gmail.test' }, { id: 'outlook-1', provider: 'outlook', email: 'me@outlook.test' }],
};

test('the owner’s mail request becomes a daily read-only digest of the chosen mailbox that notifies only when important', async () => {
  const plan = await planAutomation('每天早上读一下我指定邮箱里超级教授相关的邮件，有重要的就通知我', context);
  assert.equal(plan.source, 'rules');
  assert.deepEqual(plan.draft.trigger, { kind: 'schedule', repeat: 'daily', time: '07:30', weekday: null, date: null, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(plan.draft.action, { kind: 'mail-digest', accountId: '', query: '超级教授', notifyWhen: 'important', useAi: false });
  assert.equal(plan.draft.title, '「超级教授」邮件摘要');
  // Two mailboxes and no default: the owner picks one before creating.
  assert.deepEqual(plan.needs, ['mail-account']);
  assert.ok(plan.notes.includes('请选择要读取的邮箱'));
  assert.ok(plan.notes.includes('没有 DeepSeek 时，有新的相关邮件就算重要'));

  const withDefault = await planAutomation('每天早上 8 点半读一下 Gmail 里关于期中考试的邮件，有新的就通知我', { ...context, aiAvailable: true });
  assert.deepEqual(withDefault.draft.action, { kind: 'mail-digest', accountId: 'gmail-1', query: '期中考试', notifyWhen: 'new', useAi: true });
  assert.equal(withDefault.draft.trigger.kind === 'schedule' && withDefault.draft.trigger.time, '08:30');
  assert.deepEqual(withDefault.needs, []);
  const projectDefault = await planAutomation('每小时看一下邮件，总结给我', { ...context, defaultMailAccountId: 'outlook-1' });
  assert.deepEqual(projectDefault.draft.trigger, { kind: 'schedule', repeat: 'hourly', time: '00:00', weekday: null, date: null, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(projectDefault.draft.action, { kind: 'mail-digest', accountId: 'outlook-1', query: '', notifyWhen: 'always', useAi: false });
});

test('“构建失败时给我发通知” is a build-failed event with a notification', async () => {
  const plan = await planAutomation('这个项目里构建失败时给我发通知', context);
  assert.deepEqual(plan.draft.trigger, { kind: 'event', event: 'build-failed' });
  assert.deepEqual(plan.draft.action, { kind: 'notify', message: '「超级教授」的 AI 开发失败了' });
  assert.equal(plan.draft.title, '构建失败通知');
});

test('reminders understand weekly, weekday, one-off and spoken times', async () => {
  const weekly = await planAutomation('每周一上午九点提醒我写周报', context);
  assert.deepEqual(weekly.draft.trigger, { kind: 'schedule', repeat: 'weekly', time: '09:00', weekday: 1, date: null, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(weekly.draft.action, { kind: 'notify', message: '写周报' });
  const weekdays = await planAutomation('工作日晚上8点半提醒我看一下 SNR', context);
  assert.deepEqual(weekdays.draft.trigger, { kind: 'schedule', repeat: 'weekdays', time: '20:30', weekday: null, date: null, timeZone: 'Asia/Shanghai' });
  const tomorrow = await planAutomation('明天下午3点提醒我交报告', context);
  assert.deepEqual(tomorrow.draft.trigger, { kind: 'schedule', repeat: 'once', time: '15:00', weekday: null, date: '2026-10-06', timeZone: 'Asia/Shanghai' });
  // 10:00 has passed today, so “上午十点” without a day is tomorrow.
  const next = await planAutomation('上午十点提醒我开会', context);
  assert.equal(next.draft.trigger.kind === 'schedule' && next.draft.trigger.date, '2026-10-06');
  await assert.rejects(planAutomation('提醒我喝水', context), /什么时候/);
});

test('requests to send mail, trade or act outside Studio are refused before anything else', async () => {
  for (const request of ['每天早上把超级教授的邮件转发给老板', '构建失败时给团队发邮件', '每天收盘前帮我买入 VUSA', '每天把重要邮件标记为已读', '有新邮件就发到微信群']) {
    await assert.rejects(planAutomation(request, context), (error: Error & { code?: string }) => error.code === 'AUTOMATION_OUTSIDE_STUDIO', request);
  }
});

test('what the rules do not understand goes to DeepSeek, whose answer is checked against the same vocabulary', async () => {
  const hints: string[] = [];
  const plan = await planAutomation('课程反馈多起来的时候帮我留意一下', { ...context, aiAvailable: true }, async (text, hint) => {
    hints.push(hint);
    assert.equal(text, '课程反馈多起来的时候帮我留意一下');
    return { title: '课程反馈', trigger: { kind: 'schedule', repeat: 'daily', time: '18:00' }, action: { kind: 'mail-digest', query: '课程反馈', notifyWhen: 'new' } };
  });
  assert.equal(plan.source, 'deepseek');
  assert.match(hints[0], /今天是 2026-10-05/);
  assert.deepEqual(plan.draft.action, { kind: 'mail-digest', accountId: '', query: '课程反馈', notifyWhen: 'new', useAi: true });
  assert.equal(plan.draft.trigger.kind === 'schedule' && plan.draft.trigger.time, '18:00');
  await assert.rejects(planAutomation('帮我管一下这个项目', context, async () => ({ unsupported: '需要在 Studio 之外操作' })), /做不了/);
  await assert.rejects(planAutomation('帮我管一下这个项目', context, async () => ({ trigger: { kind: 'webhook' }, action: { kind: 'shell' } })), /没看懂/);
  await assert.rejects(planAutomation('帮我管一下这个项目', context), /没看懂/);
});
