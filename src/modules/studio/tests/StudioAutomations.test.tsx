import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HubAutomation, HubAutomationInput, HubProject } from '@/shared/types';

const mocks = vi.hoisted(() => ({
  automations: { push: vi.fn(), testPush: vi.fn(), list: vi.fn(), plan: vi.fn(), create: vi.fn(), update: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), run: vi.fn() },
  mail: { accounts: vi.fn() },
  webPush: { permission: 'default' as NotificationPermission | 'unsupported', isSubscribed: false, isLoading: false, error: '', subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('@/shared/api', () => ({
  api: { studio: { automations: mocks.automations, mail: mocks.mail } },
  readApiJson: async (response: Response) => {
    const value = await response.json();
    if (!response.ok) throw Error(value.error);
    return value;
  },
}));
// This browser's permission and subscription are what the test sets; the server status comes from the API mock.
vi.mock('@/shared/hooks/useWebPush', () => ({ useWebPush: () => mocks.webPush }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const { StudioProjectTasks } = await import('@/modules/studio/StudioProjectTasks');
const { StudioPushBanner } = await import('@/modules/studio/StudioPushBanner');

const project: HubProject = {
  id: 'prof', name: '超级教授', description: '', workspacePath: '', modules: ['agents', 'automations'], providers: ['claude'], tone: 'clay', glyph: 'graduation',
  links: [], remoteHost: '', remoteDir: '', updatedAt: '1', product: 'professor',
};
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DRAFT: HubAutomationInput = {
  title: '「超级教授」邮件摘要', prompt: '每天早上读一下我指定邮箱里超级教授相关的邮件，有重要的就通知我',
  trigger: { kind: 'schedule', repeat: 'daily', time: '08:00', weekday: null, date: null, timeZone: ZONE },
  action: { kind: 'mail-digest', accountId: '', query: '超级教授', notifyWhen: 'important', useAi: true },
};
const stored = (input: HubAutomationInput, extra: Partial<HubAutomation> = {}): HubAutomation => ({
  ...input, id: 'a1', projectId: 'prof', enabled: true, nextRunAt: '2030-01-02T00:00:00.000Z', lastRun: null, createdAt: '', updatedAt: '', ...extra,
});
const ACCOUNTS = [{ id: 'gmail-1', provider: 'gmail-imap', email: 'me@gmail.test', displayName: '', status: 'ok', lastError: null, createdAt: '' }, { id: 'outlook-1', provider: 'outlook', email: 'me@outlook.test', displayName: '', status: 'ok', lastError: null, createdAt: '' }];

function setBrowser(permission: NotificationPermission | 'unsupported', isSubscribed = false) {
  Object.assign(mocks.webPush, { permission, isSubscribed, isLoading: false, error: '' });
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  setBrowser('granted', true);
  mocks.automations.push.mockImplementation(async () => Response.json({ enabled: true, devices: 1 }));
  mocks.automations.list.mockImplementation(async () => Response.json([]));
  mocks.mail.accounts.mockImplementation(async () => Response.json({ accounts: ACCOUNTS, outlookConfigured: true }));
});

describe('the 自动化 tab', () => {
  it('turns plain words into an automation the owner reviews, completes and creates', async () => {
    mocks.automations.plan.mockImplementation(async () => Response.json({ draft: DRAFT, needs: ['mail-account'], source: 'rules', notes: ['请选择要读取的邮箱'] }));
    mocks.automations.create.mockImplementation(async (_projectId: string, input: HubAutomationInput) => Response.json(stored(input), { status: 201 }));
    render(<StudioProjectTasks project={project} />);
    expect(await screen.findByText(/还没有自动化/)).toBeTruthy();

    // An example fills the box; the owner's own words are sent with this device's time zone.
    fireEvent.click(screen.getByRole('button', { name: /^每天早上读一下我邮箱里超级教授相关的邮件/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '想自动化什么' }), { target: { value: DRAFT.prompt } });
    fireEvent.click(screen.getByRole('button', { name: '生成自动化' }));
    const review = await screen.findByRole('form', { name: '确认自动化' });
    expect(mocks.automations.plan).toHaveBeenCalledWith('prof', DRAFT.prompt, ZONE);
    expect(within(review).getByText('请选择要读取的邮箱')).toBeTruthy();
    expect(within(review).getByText(/不会回复、转发、删除或标记已读/)).toBeTruthy();
    expect((within(review).getByLabelText('关键词') as HTMLInputElement).value).toBe('超级教授');
    expect(within(review).getByRole('radio', { name: '重要邮件' }).getAttribute('aria-checked')).toBe('true');

    // Nothing is created until a mailbox is chosen.
    const create = within(review).getByRole('button', { name: '创建' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(review).getByLabelText('邮箱'), { target: { value: 'outlook-1' } });
    fireEvent.change(within(review).getByLabelText('时间'), { target: { value: '07:30' } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);

    await waitFor(() => expect(mocks.automations.create).toHaveBeenCalledTimes(1));
    expect(mocks.automations.create.mock.calls[0]).toEqual(['prof', {
      ...DRAFT, trigger: { ...DRAFT.trigger, time: '07:30' }, action: { ...DRAFT.action, accountId: 'outlook-1' },
    }]);
    const list = await screen.findByRole('list', { name: '自动化列表' });
    expect(within(list).getByText('「超级教授」邮件摘要')).toBeTruthy();
    expect(within(list).getByText(/每天 07:30 · 读取 me@outlook.test 里「超级教授」相关的新邮件 · 有重要邮件时通知/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: '确认自动化' })).toBeNull();
    expect((screen.getByRole('textbox', { name: '想自动化什么' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows why a request was refused instead of creating anything', async () => {
    mocks.automations.plan.mockImplementation(async () => Response.json({ error: '自动化只能读取你的邮件、给你本人发通知，不会替你发邮件、下单或在 Studio 之外操作。' }, { status: 422 }));
    render(<StudioProjectTasks project={project} />);
    fireEvent.change(await screen.findByRole('textbox', { name: '想自动化什么' }), { target: { value: '每天把邮件转发给老板' } });
    fireEvent.click(screen.getByRole('button', { name: '生成自动化' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/不会替你发邮件/);
    expect(screen.queryByRole('form', { name: '确认自动化' })).toBeNull();
    expect(mocks.automations.create).not.toHaveBeenCalled();
  });

  it('lists automations with their next and last run, and switches, runs, edits and deletes them', async () => {
    const reminder = stored({ title: '构建失败通知', prompt: '', trigger: { kind: 'event', event: 'build-failed' }, action: { kind: 'notify', message: '「超级教授」的 AI 开发失败了' } }, {
      id: 'a2', nextRunAt: null, lastRun: { at: new Date().toISOString(), status: 'notified', summary: '「超级教授」的 AI 开发失败了：AI 没能完成开发' },
    });
    mocks.automations.list.mockImplementation(async () => Response.json([reminder]));
    mocks.automations.setEnabled.mockImplementation(async (_id: string, enabled: boolean) => Response.json({ ...reminder, enabled }));
    mocks.automations.run.mockImplementation(async () => Response.json(reminder));
    mocks.automations.update.mockImplementation(async (_id: string, input: HubAutomationInput) => Response.json({ ...reminder, ...input }));
    mocks.automations.remove.mockImplementation(async () => Response.json({ deleted: true }));
    render(<StudioProjectTasks project={project} />);
    const list = await screen.findByRole('list', { name: '自动化列表' });
    expect(within(list).getByText(/这个项目的 AI 开发失败时 · 通知：/)).toBeTruthy();
    expect(within(list).getByText(/等待触发 · 上次 今天 \d\d:\d\d 已通知/)).toBeTruthy();

    fireEvent.click(within(list).getByRole('switch', { name: '启用「构建失败通知」' }));
    await waitFor(() => expect(mocks.automations.setEnabled).toHaveBeenCalledWith('a2', false));
    await waitFor(() => expect(within(list).getByText(/已关闭/)).toBeTruthy());

    fireEvent.click(within(list).getByRole('button', { name: '立即运行「构建失败通知」' }));
    await waitFor(() => expect(mocks.automations.run).toHaveBeenCalledWith('a2'));

    fireEvent.click(within(list).getByRole('button', { name: '编辑「构建失败通知」' }));
    const form = await screen.findByRole('form', { name: '编辑自动化' });
    expect(within(form).getByText('这个项目的 AI 开发失败时')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('通知内容'), { target: { value: '去看看构建日志' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocks.automations.update).toHaveBeenCalledWith('a2', expect.objectContaining({ action: { kind: 'notify', message: '去看看构建日志' } })));

    fireEvent.click(within(list).getByRole('button', { name: '删除「构建失败通知」' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocks.automations.remove).toHaveBeenCalledWith('a2'));
    expect(await screen.findByText(/还没有自动化/)).toBeTruthy();
  });
});

describe('the notification check', () => {
  it('on an iPad outside the home screen, explains adding Studio to the home screen first', async () => {
    setBrowser('unsupported');
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
    render(<StudioPushBanner />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('先把 Studio 添加到主屏幕');
    expect(within(banner).queryByRole('button')).toBeNull();
    agent.mockRestore();
  });

  it('says clearly when notifications are off, and turns them on for this device', async () => {
    setBrowser('default');
    mocks.webPush.subscribe.mockImplementation(async () => true);
    const { unmount } = render(<StudioPushBanner />);
    expect(screen.getByRole('status').textContent).toContain('通知还没有开启');
    fireEvent.click(screen.getByRole('button', { name: '开启通知' }));
    await waitFor(() => expect(mocks.webPush.subscribe).toHaveBeenCalledTimes(1));
    // The server status is read again after subscribing.
    await waitFor(() => expect(mocks.automations.push).toHaveBeenCalledTimes(2));
    unmount();

    setBrowser('denied');
    const denied = render(<StudioPushBanner />);
    expect(screen.getByRole('status').textContent).toMatch(/通知被拒绝了.*系统设置/);
    expect(screen.queryByRole('button')).toBeNull();
    denied.unmount();

    setBrowser('granted', false);
    const here = render(<StudioPushBanner />);
    expect(screen.getByRole('button', { name: '在这台设备上开启' })).toBeTruthy();
    here.unmount();

    setBrowser('granted', true);
    mocks.automations.push.mockImplementation(async () => Response.json({ enabled: false, devices: 1 }));
    render(<StudioPushBanner />);
    expect(await screen.findByText('推送通知已关闭')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新开启' })).toBeTruthy();
  });

  it('when everything is on, says so and sends a test notification', async () => {
    mocks.automations.push.mockImplementation(async () => Response.json({ enabled: true, devices: 2 }));
    mocks.automations.testPush.mockImplementation(async () => Response.json({ enabled: true, devices: 2, delivered: 2 }));
    render(<StudioPushBanner />);
    expect(await screen.findByText('2 台设备会收到自动化的提醒')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送测试' }));
    expect(await screen.findByText(/已发出测试通知（2 台设备）/)).toBeTruthy();
  });
});
