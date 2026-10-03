import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { api } from '@/shared/api';
import type {
  ChatMessage, PendingPermissionRequest, Project, WorkbenchChatChrome, WorkbenchChatProps, WorkbenchSessionItem, WorkbenchThread,
} from '@/shared/types';
import { WorkbenchChat } from '@/modules/workbench/chat/WorkbenchChat';

// The chat engine talks to the WebSocket and the session store; these tests fake it and check the column's rules.
const engine = vi.hoisted(() => ({
  calls: [] as {
    draftProvider: string;
    session: { id: string; __provider: string } | null;
    // A handoff's first-prompt rewrite and the new-session callback, as the column hands them to the engine.
    prepareNewSessionContent?: (content: string) => Promise<string>;
    onSessionCreated: (item: WorkbenchSessionItem) => void;
  }[],
  messages: [] as unknown[],
  sessionId: null as string | null,
  pending: [] as unknown[],
  selectModel: (() => Promise.resolve()) as (model: string) => Promise<void>,
  // The reasoning effort the composer shows and the levels the selected model accepts (none: no effort control).
  effort: 'default',
  effortOptions: [] as { value: string }[],
  selectEffort: (() => Promise.resolve()) as (effort: string) => Promise<void>,
  decide: (() => undefined) as (...args: unknown[]) => void,
  // Durable delivery and task recovery, as the inherited composer and useTaskRecovery report them.
  delivery: null as { requestId: string; state: 'sending' | 'unknown' | 'failed' } | null,
  preparedRecovery: null as { runId: string; scope: string } | null,
  recoveryRuns: [] as unknown[],
  prepareRecovery: (() => undefined) as (run: unknown) => void,
  cancelPreparedRecovery: (() => undefined) as () => void,
  // Both agents' catalogs as the engine holds them, and the per-provider model pick a provider switch records.
  catalog: {
    claude: { DEFAULT: 'opus', OPTIONS: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] },
    codex: { DEFAULT: 'gpt-5.5', OPTIONS: [{ value: 'gpt-5.5', label: 'GPT-5.5' }, { value: 'gpt-5.5-mini', label: 'GPT-5.5 mini' }] },
  } as Record<string, unknown>,
  selectProviderModel: (() => Promise.resolve()) as (...args: unknown[]) => Promise<unknown>,
  setInput: (() => undefined) as (value: string) => void,
  // A run in flight: whether one is going, whether it can be stopped, when it started, and the stop action.
  processing: false,
  canAbort: false,
  sessionActivity: null as { startedAt: number; statusText?: string } | null,
  abort: (() => undefined) as () => void,
  // The context budget the header's token ring reads.
  tokenBudget: { used: 50_000, total: 200_000 } as Record<string, unknown> | null,
  showCostModal: (() => undefined) as () => void,
}));

vi.mock('@/modules/workbench/chat/hooks/useWorkbenchAgentEngine', () => ({
  useWorkbenchAgentEngine: (args: (typeof engine.calls)[number]) => {
    engine.calls.push(args);
    const provider = args.session?.__provider ?? args.draftProvider;
    const noop = () => undefined;
    return {
      provider: {
        provider,
        currentProviderModel: 'opus',
        currentProviderModelOptions: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }],
        pendingPermissionRequests: engine.pending,
        permissionMode: 'default',
        availablePermissionModes: ['default', 'acceptEdits', 'plan'],
        selectPermissionMode: noop,
        currentProviderEffort: engine.effort,
        currentProviderEffortOptions: engine.effortOptions,
        providerModelCatalog: engine.catalog,
        providerModelActions: { create: noop, update: noop, remove: noop },
        selectProviderModel: (...args: unknown[]) => engine.selectProviderModel(...args),
        supportsMessageEditing: false,
      },
      session: {
        chatMessages: engine.messages,
        visibleMessages: engine.messages,
        isProcessing: engine.processing,
        canAbortSession: engine.canAbort,
        sessionActivity: engine.sessionActivity,
        tokenBudget: engine.tokenBudget,
        scrollContainerRef: createRef<HTMLDivElement>(),
        handleScroll: noop,
        isLoadingSessionMessages: false,
        loadEarlierMessages: noop,
        hasMoreMessages: false,
        allMessagesLoaded: true,
        isLoadingMoreMessages: false,
        isLoadingAllMessages: false,
        loadAllMessages: noop,
        createDiff: () => [],
        isUserScrolledUp: false,
        scrollToBottomAndReset: noop,
      },
      composer: {
        input: '',
        setInput: (value: string) => engine.setInput(value),
        textareaRef: createRef<HTMLTextAreaElement>(),
        attachedFiles: [],
        setAttachedFiles: noop,
        fileErrors: new Map(),
        getRootProps: () => ({}),
        getInputProps: () => ({ type: 'file', hidden: true }),
        isDragActive: false,
        openAttachmentPicker: noop,
        handleSubmit: noop,
        handleInputChange: noop,
        handleKeyDown: noop,
        handlePaste: noop,
        handleTextareaClick: noop,
        handleTextareaInput: noop,
        handleInputFocusChange: noop,
        showCommandMenu: false,
        filteredCommands: [],
        selectedCommandIndex: -1,
        handleCommandSelect: noop,
        handleToggleCommandMenu: noop,
        resetCommandMenuState: noop,
        showFileDropdown: false,
        filteredFiles: [],
        selectedFileIndex: -1,
        selectFile: noop,
        queuedDraft: null,
        editQueuedDraft: noop,
        deleteQueuedDraft: noop,
        editingAnchorId: null,
        cancelEditMessage: noop,
        handlePermissionDecision: (...decision: unknown[]) => engine.decide(...decision),
        handleGrantToolPermission: () => ({ success: true }),
        handleAbortSession: () => engine.abort(),
        beginEditMessage: noop,
        showCostModal: () => engine.showCostModal(),
        commandModalPayload: null,
        closeCommandModal: noop,
        delivery: engine.delivery,
        pendingContent: engine.delivery ? '原消息' : null,
        checkDelivery: () => Promise.resolve(),
        retryDelivery: () => Promise.resolve(),
        preparedRecovery: engine.preparedRecovery,
        prepareRecovery: (run: unknown) => engine.prepareRecovery(run),
        cancelPreparedRecovery: () => engine.cancelPreparedRecovery(),
      },
      recovery: { runs: engine.recoveryRuns, error: false, refresh: noop, resolve: () => Promise.resolve() },
      isConnected: true,
      sessionId: engine.sessionId,
      sendMessage: noop,
      selectModel: (model: string) => engine.selectModel(model),
      selectEffort: (effort: string) => engine.selectEffort(effort),
    };
  },
}));

const project: Project = { projectId: 'p1', displayName: 'Agent Cloud Studio', fullPath: '/repo' };

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function renderChat(props: Partial<WorkbenchChatProps> & { chrome?: WorkbenchChatChrome } = {}) {
  const onSessionCreated = vi.fn();
  const onOpenFile = vi.fn();
  const utils = render(
    <WorkbenchChat
      project={project}
      session={null}
      provider="claude"
      hubProjectId={null}
      onSessionCreated={onSessionCreated}
      onOpenFile={onOpenFile}
      {...props}
    />,
    // The handoff prelude links to the original sessions, as inside the workbench's router.
    { wrapper: MemoryRouter },
  );
  return { ...utils, onSessionCreated, onOpenFile };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  engine.selectProviderModel = () => Promise.resolve();
  engine.setInput = () => undefined;
  engine.effort = 'default';
  engine.effortOptions = [];
  engine.calls.length = 0;
  engine.messages = [];
  engine.sessionId = null;
  engine.pending = [];
  engine.delivery = null;
  engine.preparedRecovery = null;
  engine.recoveryRuns = [];
  engine.processing = false;
  engine.canAbort = false;
  engine.sessionActivity = null;
  engine.abort = () => undefined;
  engine.tokenBudget = { used: 50_000, total: 200_000 };
  engine.showCostModal = () => undefined;
});

describe('one chat for every model', () => {
  test('before the first message the model menu lists Claude, Codex and DeepSeek models, and a pick switches the chat', async () => {
    const status = vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash', 'deepseek-v4-pro'], source: 'vault', baseUrl: '' } }));
    const selectProviderModel = vi.fn(() => Promise.resolve());
    engine.selectProviderModel = selectProviderModel;
    // What a DeepSeek chat reads to offer the agents' models.
    const models = vi.spyOn(api.providers, 'models').mockImplementation(async (provider: string) => json({
      success: true, data: { models: provider === 'codex' ? engine.catalog.codex : engine.catalog.claude },
    }));
    renderChat({ hubProjectId: 'hub1' });
    // An agent chat takes both agents' models from its engine and asks the server for none.
    expect(models).not.toHaveBeenCalled();
    await waitFor(() => expect(status).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '模型 Opus' }));
    const menu = screen.getByRole('menu', { name: '模型 Opus' });
    expect(within(within(menu).getByRole('group', { name: 'Claude Code' })).getAllByRole('menuitemradio').map((row) => row.textContent)).toEqual(['Opus', 'Sonnet']);
    expect(within(within(menu).getByRole('group', { name: 'Codex' })).getAllByRole('menuitemradio').map((row) => row.textContent)).toEqual(['GPT-5.5', 'GPT-5.5 mini']);
    const deepseek = within(menu).getByRole('group', { name: 'DeepSeek' });
    expect(await within(deepseek).findByRole('menuitemradio', { name: 'deepseek-v4-pro' })).toBeTruthy();
    // Every section carries the provider's official mark.
    expect(menu.querySelectorAll('.wbc-menu-title svg[data-brand]')).toHaveLength(3);

    // A Codex model: the same chat becomes a Codex chat with that model.
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'GPT-5.5 mini' }));
    expect(selectProviderModel).toHaveBeenCalledWith('codex', 'gpt-5.5-mini', null);
    expect(engine.calls.at(-1)?.draftProvider).toBe('codex');

    // A DeepSeek model: the chat turns into a DeepSeek chat with that model, still in the same column.
    await waitFor(() => expect(screen.queryAllByRole('menu')).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: /Codex · Opus/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'deepseek-v4-pro' }));
    expect(await screen.findByPlaceholderText('给 DeepSeek 发消息')).toBeTruthy();
    expect(screen.getByRole('button', { name: '模型 deepseek-v4-pro' })).toBeTruthy();

    // And back: DeepSeek's menu offers the agents' models (read from the server) until the first send.
    await waitFor(() => expect(models).toHaveBeenCalledWith('codex'));
    await waitFor(() => expect(screen.queryAllByRole('menu')).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: '模型 deepseek-v4-pro' }));
    fireEvent.click(await within(screen.getByRole('menu')).findByRole('menuitemradio', { name: 'Sonnet' }));
    await waitFor(() => expect(engine.calls.at(-1)?.draftProvider).toBe('claude'));
    expect(localStorage.getItem('claude-model')).toBe('sonnet');
  });

  test('an open session changes its own model in place and offers the other providers as a handoff', async () => {
    const selectModel = vi.fn(() => Promise.resolve());
    engine.selectModel = selectModel;
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'codex', title: '重构侧栏', updatedAt: null } });

    expect(engine.calls.at(-1)?.session).toMatchObject({ id: 's1', __provider: 'codex' });
    expect(screen.getByText('重构侧栏')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Codex · Opus/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('group', { name: 'Claude Code' })).toBeTruthy();
    // Without a Studio project DeepSeek is listed with the reason, as before.
    expect(within(within(menu).getByRole('group', { name: 'DeepSeek' })).queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(within(menu).getByText(/前面的对话会整理成摘要交给它/)).toBeTruthy();
    // A model of the same provider: changed in place, no handoff.
    fireEvent.click(within(within(menu).getByRole('group', { name: 'Codex' })).getByRole('menuitemradio', { name: 'Sonnet' }));
    await waitFor(() => expect(selectModel).toHaveBeenCalledWith('sonnet'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  test('once the first message is out, another provider’s model asks before handing the chat over', () => {
    engine.sessionId = 's-new';
    engine.messages = [{ type: 'user', content: '你好', timestamp: '2026-10-02T08:00:00.000Z' } satisfies ChatMessage];
    const selectProviderModel = vi.fn(() => Promise.resolve());
    engine.selectProviderModel = selectProviderModel;
    renderChat();
    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'GPT-5.5' }));
    const sheet = screen.getByRole('alertdialog', { name: '交给 Codex 继续？' });
    expect(within(sheet).getByText(/前面的对话会整理成摘要交给 Codex · GPT-5.5/)).toBeTruthy();
    // Nothing changes until the owner agrees.
    expect(engine.calls.at(-1)?.draftProvider).toBe('claude');
    expect(selectProviderModel).not.toHaveBeenCalled();
  });

  test('the token ring reports how full the context is', () => {
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    expect(screen.getByRole('button', { name: '上下文已用 25%（50K / 200K）' })).toBeTruthy();
  });
});

describe('the context usage card', () => {
  const SESSION = { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } as const;

  test('the ring blooms a small card with the basics instead of opening the old usage window', async () => {
    const showCostModal = vi.fn();
    engine.showCostModal = showCostModal;
    engine.tokenBudget = {
      used: 42_000, total: 200_000, inputTokens: 41_000, outputTokens: 1_000, cacheReadTokens: 30_000, cacheCreationTokens: 2_048,
    };
    renderChat({ session: SESSION });
    const ring = screen.getByRole('button', { name: '上下文已用 21%（42K / 200K）' });
    expect(ring.getAttribute('aria-haspopup')).toBe('dialog');

    fireEvent.click(ring);
    const card = await screen.findByRole('dialog', { name: '上下文用量' });
    expect(ring.getAttribute('aria-expanded')).toBe('true');
    expect(ring.getAttribute('aria-controls')).toBe(card.id);
    expect(within(card).getByText('21%')).toBeTruthy();
    expect(within(card).getByText('42K / 200K tokens')).toBeTruthy();
    expect(within(card).getByText('Claude Code · Opus')).toBeTruthy();
    expect(within(card).getByText('41,000')).toBeTruthy();
    expect(within(card).getByText('1,000')).toBeTruthy();
    expect(within(card).getByText('读 30,000 · 写 2,048')).toBeTruthy();
    // Below 80% there is nothing to warn about.
    expect(within(card).queryByRole('note')).toBeNull();
    // No new window, route or command: the old /cost panel is never asked for.
    expect(showCostModal).not.toHaveBeenCalled();

    // A second press on the ring closes it.
    fireEvent.click(ring);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '上下文用量' })).toBeNull());
    expect(ring.getAttribute('aria-expanded')).toBe('false');
  });

  test('a press outside or Escape closes the card, and Escape does not also stop the run', async () => {
    const abort = vi.fn();
    engine.abort = abort;
    engine.processing = true;
    engine.canAbort = true;
    renderChat({ session: SESSION });
    const ring = screen.getByRole('button', { name: /上下文已用 25%/ });

    fireEvent.click(ring);
    await screen.findByRole('dialog', { name: '上下文用量' });
    fireEvent.pointerDown(screen.getByRole('textbox', { name: '消息' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '上下文用量' })).toBeNull());

    fireEvent.click(ring);
    const card = await screen.findByRole('dialog', { name: '上下文用量' });
    fireEvent.keyDown(card, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '上下文用量' })).toBeNull());
    expect(abort).not.toHaveBeenCalled();
  });

  test('a nearly full window explains compaction in one line', async () => {
    engine.tokenBudget = { used: 172_000, total: 200_000 };
    renderChat({ session: SESSION });
    fireEvent.click(screen.getByRole('button', { name: /上下文已用 86%/ }));
    const card = await screen.findByRole('dialog', { name: '上下文用量' });
    expect(within(card).getByRole('note').textContent).toMatch(/自动压缩/);
  });
});

describe('the run status row', () => {
  const SESSION = { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } as const;
  const TODOS = [
    { content: '读代码', activeForm: '正在读代码', status: 'completed' },
    { content: '改样式', activeForm: '正在改样式', status: 'completed' },
    { content: '跑测试', activeForm: '正在跑测试', status: 'in_progress' },
    { content: '提交', activeForm: '正在提交', status: 'pending' },
  ];

  test('sits in the dock right above the composer with state, progress, time and stop; nothing floats at the top', () => {
    const abort = vi.fn();
    engine.abort = abort;
    engine.processing = true;
    engine.canAbort = true;
    engine.sessionActivity = { startedAt: Date.now() - 101_000 };
    engine.messages = [
      { type: 'user', content: '修一下样式', timestamp: '2026-10-02T08:00:00.000Z' },
      { type: 'assistant', content: '', isToolUse: true, toolName: 'TodoWrite', toolId: 't1', toolInput: { todos: TODOS }, toolResult: { content: 'ok' }, timestamp: '2026-10-02T08:00:01.000Z' },
    ] as ChatMessage[];
    const { container } = renderChat({ session: SESSION });

    const row = screen.getByRole('group', { name: '本轮运行状态' });
    // Inside the dock, before the composer; not in the header or over the transcript.
    const dock = container.querySelector('.wbc-dock');
    expect(dock?.contains(row)).toBe(true);
    expect(container.querySelector('.wbc-header')?.contains(row)).toBe(false);
    expect(container.querySelector('.wbc-scroll')?.contains(row)).toBe(false);
    const composer = screen.getByRole('textbox', { name: '消息' });
    expect(row.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.wbc-island')).toBeNull();

    // The model composing: 正在思考 with the typing dots as its glyph, and no separate dots in the transcript.
    expect(within(row).getByText('正在思考')).toBeTruthy();
    expect(row.querySelector('.wbc-run-dots')).toBeTruthy();
    expect(container.querySelector('.wbc-typing')).toBeNull();
    expect(within(row).getByText('2/4')).toBeTruthy();
    expect(within(row).getByText('1 分 41 秒')).toBeTruthy();

    // The step count unfolds the checklist.
    const toggle = within(row).getByRole('button', { name: /步骤 2\/4，展开步骤/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(row).getByRole('list', { name: '任务清单' })).toBeTruthy();
    expect(within(row).getByText('正在跑测试')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: '停止这一轮' }));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('names the running tool, and says when the run waits on the owner', () => {
    engine.processing = true;
    engine.messages = [
      { type: 'user', content: '跑一下测试', timestamp: '2026-10-02T08:00:00.000Z' },
      { type: 'assistant', content: '', isToolUse: true, toolName: 'Bash', toolId: 'b1', toolInput: { command: 'npm test' }, toolResult: null, timestamp: '2026-10-02T08:00:01.000Z' },
    ] as ChatMessage[];
    const { unmount } = renderChat({ session: SESSION });
    const row = screen.getByRole('group', { name: '本轮运行状态' });
    expect(within(row).getByText('正在运行 npm test')).toBeTruthy();
    expect(row.className).toContain('is-working');
    expect(row.querySelector('.wbc-run-dots')).toBeNull();
    // Without a way to stop there is no stop button.
    expect(within(row).queryByRole('button', { name: '停止这一轮' })).toBeNull();
    unmount();

    engine.pending = [{ requestId: 'r1', toolName: 'Bash', input: { command: 'npm test' } } satisfies PendingPermissionRequest];
    renderChat({ session: SESSION });
    const waiting = screen.getByRole('group', { name: '本轮运行状态' });
    expect(within(waiting).getByText('等你允许运行 npm test')).toBeTruthy();
    expect(waiting.className).toContain('is-waiting');
  });

  test('says the run finished once it ends', () => {
    engine.processing = true;
    const { rerender } = renderChat({ session: SESSION });
    expect(screen.getByRole('group', { name: '本轮运行状态' })).toBeTruthy();
    engine.processing = false;
    rerender(
      <WorkbenchChat project={project} session={SESSION} provider="claude" hubProjectId={null} onSessionCreated={vi.fn()} onOpenFile={vi.fn()} />,
    );
    expect(within(screen.getByRole('group', { name: '本轮运行状态' })).getByText('本轮完成')).toBeTruthy();
  });
});

describe('permission flow in the column', () => {
  test('a pending tool prompt rises above the composer and answers through the engine', () => {
    const decide = vi.fn();
    engine.decide = decide;
    engine.pending = [{ requestId: 'r1', toolName: 'Bash', input: { command: 'rm -rf dist' } } satisfies PendingPermissionRequest];
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });

    expect(screen.getByText('rm -rf dist')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(decide).toHaveBeenCalledWith('r1', { allow: false, message: 'User denied tool use' });
  });

  test('a question replaces the composer until it is answered', () => {
    engine.pending = [{
      requestId: 'q1', toolName: 'AskUserQuestion',
      input: { questions: [{ question: '继续吗？', options: [{ label: '继续' }, { label: '停下' }] }] },
    } satisfies PendingPermissionRequest];
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    expect(screen.getByRole('heading', { name: '继续吗？' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '消息' })).toBeNull();
  });
});

describe('durable sends and task recovery', () => {
  test('an unconfirmed send is shown above the composer and blocks another send until the receipt arrives', () => {
    engine.delivery = { requestId: 'req-1', state: 'unknown' };
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    expect(screen.getByRole('button', { name: /Check delivery|核对送达/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('an interrupted run is offered for continuation, and a prepared continuation can drop its link', () => {
    const prepare = vi.fn();
    const cancel = vi.fn();
    engine.prepareRecovery = prepare;
    engine.cancelPreparedRecovery = cancel;
    const run = { runId: 'run-1', requestId: 'req-0', sessionId: 's1', projectPath: '/repo', provider: 'claude', state: 'interrupted', content: '整理接口', startedAt: '2026-10-02T10:00:00Z' };
    engine.recoveryRuns = [run];
    const { unmount } = renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: /Prepare continuation|准备继续/ }));
    expect(prepare).toHaveBeenCalledWith(run);
    unmount();

    engine.recoveryRuns = [];
    engine.preparedRecovery = { runId: 'run-1', scope: 's1' };
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: '取消续接关联' }));
    expect(cancel).toHaveBeenCalled();
  });
});

describe('DeepSeek', () => {
  test('the first send creates the conversation in the project space, thinks, then shows the reply', async () => {
    vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash', 'deepseek-v4-pro'], source: 'vault', baseUrl: '' } }));
    const create = vi.spyOn(api.studio, 'createConversation').mockResolvedValue(json({ id: 'c1', title: '新对话', model: 'deepseek-flash', updated_at: '2026-10-02T08:00:00.000Z', messages: [] }));
    let release: (value: Response) => void = () => undefined;
    vi.spyOn(api.studio, 'send').mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const reload = vi.spyOn(api.studio, 'conversation');
    const { onSessionCreated, rerender } = renderChat({ provider: 'deepseek', hubProjectId: 'hub1' });

    const field = await screen.findByRole('textbox', { name: '消息' });
    await waitFor(() => expect(screen.getByText(/DeepSeek · deepseek-flash/)).toBeTruthy());
    fireEvent.change(field, { target: { value: '总结一下这个项目' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith('deepseek-flash', 'project:hub1'));
    expect(onSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', kind: 'deepseek', provider: 'deepseek', title: '总结一下这个项目' }));
    expect(await screen.findByRole('status', { name: 'DeepSeek 正在思考' })).toBeTruthy();
    expect(screen.getByText('总结一下这个项目')).toBeTruthy();

    // The shell routes to the new conversation; the column keeps what it has instead of reloading.
    rerender(
      <WorkbenchChat
        project={project}
        session={{ id: 'c1', kind: 'deepseek', provider: 'deepseek', title: '总结一下这个项目', updatedAt: null }}
        provider="deepseek"
        hubProjectId="hub1"
        onSessionCreated={onSessionCreated}
        onOpenFile={vi.fn()}
      />,
    );
    await act(async () => {
      release(json({
        id: 'c1', title: '总结一下这个项目', model: 'deepseek-flash', updated_at: '2026-10-02T08:00:05.000Z',
        messages: [
          { id: 1, role: 'user', content: '总结一下这个项目', status: 'complete' },
          { id: 2, role: 'assistant', content: '这是一个 **iPad 优先** 的工作台。', status: 'complete' },
        ],
      }));
    });
    expect(await screen.findByText('iPad 优先')).toBeTruthy();
    expect(screen.getByText('iPad 优先').tagName).toBe('STRONG');
    expect(reload).not.toHaveBeenCalled();
    // The thinking line plays its exit before it leaves the DOM.
    await waitFor(() => expect(screen.queryByRole('status', { name: 'DeepSeek 正在思考' })).toBeNull());
    // Started: the model is fixed, and the agents are offered as a handoff.
    fireEvent.click(screen.getByRole('button', { name: '模型 deepseek-flash' }));
    const menu = screen.getByRole('menu', { name: '模型 deepseek-flash' });
    expect(within(menu).getByText('这个对话的模型已固定。')).toBeTruthy();
    expect(within(menu).getByRole('group', { name: 'Codex' })).toBeTruthy();
    expect(within(menu).getByText(/前面的对话会整理成摘要交给它/)).toBeTruthy();
  });

  test('without a key the column says where to add one', async () => {
    vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: false, models: [], source: null, baseUrl: '' } }));
    renderChat({ provider: 'deepseek', hubProjectId: 'hub1' });
    expect(await screen.findByRole('heading', { name: '还没有 DeepSeek 密钥' })).toBeTruthy();
  });

  test('an existing conversation loads from the general DeepSeek space', async () => {
    vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash'], source: 'vault', baseUrl: '' } }));
    vi.spyOn(api.studio, 'conversation').mockResolvedValue(json({
      id: 'c9', title: '旧对话', model: 'deepseek-v4-pro', updated_at: '2026-10-01T08:00:00.000Z',
      messages: [{ id: 1, role: 'user', content: '在吗', status: 'complete' }, { id: 2, role: 'assistant', content: '在的', status: 'complete' }],
    }));
    renderChat({ provider: 'claude', session: { id: 'c9', kind: 'deepseek', provider: 'deepseek', title: '旧对话', updatedAt: null } });
    expect(await screen.findByText('在的')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'DeepSeek · deepseek-v4-pro，切换模型' })).toBeTruthy();
  });
});

describe('one rule with the shell', () => {
  test('without a Studio project DeepSeek is listed without models, with the same reason as the new-session menu', () => {
    renderChat({ hubProjectId: null });
    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    const deepseek = within(screen.getByRole('menu')).getByRole('group', { name: 'DeepSeek' });
    expect(within(deepseek).queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(within(deepseek).getByText('需先在 Studio 中建立此项目')).toBeTruthy();
    expect(engine.calls.at(-1)?.draftProvider).toBe('claude');
    expect(screen.queryByPlaceholderText('给 DeepSeek 发消息')).toBeNull();
  });

  test('a DeepSeek preselection the directory cannot honour starts Claude Code, like the shell', () => {
    renderChat({ provider: 'deepseek', hubProjectId: null });
    expect(engine.calls.at(-1)?.draftProvider).toBe('claude');
    expect(screen.getByRole('button', { name: /Claude Code · Opus/ })).toBeTruthy();
  });

  test('Cursor and OpenCode are never offered', () => {
    renderChat({ hubProjectId: 'hub1' });
    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual(['Claude Code', 'Codex', 'DeepSeek']);
    expect(within(menu).queryByText(/Cursor|OpenCode/)).toBeNull();
  });
});

describe('the composer', () => {
  test('has no slash-command button (typing / still works) and shows official marks', () => {
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'codex', title: 't', updatedAt: null } });
    expect(screen.queryByRole('button', { name: '命令' })).toBeNull();
    expect(screen.getByRole('button', { name: '添加图片或文件' })).toBeTruthy();
    expect(screen.getByRole('banner').querySelector('svg[data-brand="openai"]')).toBeTruthy();
  });

  test('hides the microphone where the browser has no speech recognition', () => {
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    expect(screen.queryByRole('button', { name: '语音输入' })).toBeNull();
  });

  describe('with speech recognition', () => {
    // A stand-in for Safari's webkitSpeechRecognition: it records how it was set up and lets the test speak.
    class FakeRecognition {
      static instances: FakeRecognition[] = [];
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn(() => this.onend?.());
      abort = vi.fn(() => this.onend?.());
      constructor() { FakeRecognition.instances.push(this); }
      speak(...phrases: [string, boolean][]) {
        act(() => this.onresult?.({ results: phrases.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) }));
      }
    }
    const scope = window as Window & { webkitSpeechRecognition?: unknown };

    afterEach(() => {
      delete scope.webkitSpeechRecognition;
      FakeRecognition.instances = [];
    });

    test('dictates Chinese into the DeepSeek draft live and keeps listening until tapped again', async () => {
      scope.webkitSpeechRecognition = FakeRecognition;
      vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash'], source: 'vault', baseUrl: '' } }));
      renderChat({ provider: 'deepseek', hubProjectId: 'hub1' });
      const field = await screen.findByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
      fireEvent.change(field, { target: { value: '请总结：' } });

      fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
      const [first] = FakeRecognition.instances;
      expect(first).toMatchObject({ lang: 'zh-CN', continuous: true, interimResults: true });
      expect(first.start).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '停止语音输入' }).getAttribute('aria-pressed')).toBe('true');

      first.speak(['今天', true], ['的进度', false]);
      expect(field.value).toBe('请总结：今天的进度');
      // Safari ends a recognition after a pause; dictation picks up again on its own.
      act(() => first.onend?.());
      expect(FakeRecognition.instances).toHaveLength(2);
      FakeRecognition.instances[1].speak(['和风险', true]);
      expect(field.value).toBe('请总结：今天的进度和风险');

      fireEvent.click(screen.getByRole('button', { name: '停止语音输入' }));
      expect(FakeRecognition.instances[1].stop).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '语音输入' }).getAttribute('aria-pressed')).toBe('false');
    });

    test('writes into the agent composer through its own draft', () => {
      scope.webkitSpeechRecognition = FakeRecognition;
      const setInput = vi.fn();
      engine.setInput = setInput;
      renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
      fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
      FakeRecognition.instances[0].speak(['修一下登录页', false]);
      expect(setInput).toHaveBeenLastCalledWith('修一下登录页');
    });
  });
});

describe('reasoning effort is its own control beside the model chip', () => {
  test('the model menu lists models only, and the effort popover sets the level and opens the model menu', async () => {
    const selectEffort = vi.fn(() => Promise.resolve());
    engine.selectEffort = selectEffort;
    engine.effort = 'high';
    engine.effortOptions = [{ value: 'low' }, { value: 'high' }, { value: 'max' }];
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });

    fireEvent.click(screen.getByRole('button', { name: '模型 Opus' }));
    const modelMenu = screen.getByRole('menu', { name: '模型 Opus' });
    expect(within(modelMenu).queryByText('思考强度')).toBeNull();
    expect(within(within(modelMenu).getByRole('group', { name: 'Claude Code' })).getAllByRole('menuitemradio').map((row) => row.textContent)).toEqual(['Opus', 'Sonnet']);
    fireEvent.keyDown(modelMenu, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: '思考强度：高' }));
    const popover = screen.getByRole('dialog', { name: '思考强度' });
    fireEvent.keyDown(within(popover).getByRole('slider'), { key: 'ArrowRight' });
    await waitFor(() => expect(selectEffort).toHaveBeenCalledWith('max'));

    fireEvent.click(within(popover).getByRole('button', { name: /^Opus/ }));
    expect(screen.getByRole('menu', { name: '模型 Opus' })).toBeTruthy();
  });
});

describe('the column header is the workbench title bar', () => {
  test('it carries the shell controls and the project name, and reports a provider switch to the shell', () => {
    const onProviderChange = vi.fn();
    renderChat({
      hubProjectId: 'hub1',
      chrome: {
        leading: <button type="button">显示会话列表</button>,
        trailing: <button type="button">终端</button>,
        projectName: '超级教授',
        onProviderChange,
      },
    });
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: '显示会话列表' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: '终端' })).toBeTruthy();
    expect(within(header).getByText('新会话')).toBeTruthy();
    expect(within(header).getByText('超级教授')).toBeTruthy();
    fireEvent.click(within(header).getByRole('button', { name: /Claude Code · Opus/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'GPT-5.5' }));
    expect(onProviderChange).toHaveBeenCalledWith('codex');
  });
});

describe('in-chat file links', () => {
  test('use the shell palette ops: the line number survives and folders go to the file tree', () => {
    const openFileInEditor = vi.fn();
    const openDirectory = vi.fn();
    function ShellOps() {
      usePaletteOpsRegister({ openFileInEditor, openDirectory });
      return null;
    }
    engine.messages = [{ type: 'assistant', id: 'r1', content: '改在 [src/a.ts:42](src/a.ts:42)，配置在 [src/lib/](src/lib/)。', timestamp: '2026-10-02T08:00:00.000Z' } satisfies ChatMessage];
    const onOpenFile = vi.fn();
    render(
      <PaletteOpsProvider>
        <ShellOps />
        <WorkbenchChat project={project} session={{ id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null }} provider="claude"
          hubProjectId={null} onSessionCreated={vi.fn()} onOpenFile={onOpenFile} />
      </PaletteOpsProvider>,
    );
    fireEvent.click(screen.getByText('src/a.ts:42'));
    expect(openFileInEditor).toHaveBeenCalledWith('src/a.ts', 42);
    fireEvent.click(screen.getByText('src/lib/'));
    expect(openDirectory).toHaveBeenCalledWith('src/lib/');
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

describe('edge cases', () => {
  test('DeepSeek sends even when its status could not be read; the server gives the real answer', async () => {
    vi.spyOn(api.studio, 'status').mockRejectedValue(new Error('网络断开'));
    const create = vi.spyOn(api.studio, 'createConversation').mockResolvedValue(json({ id: 'c2', title: '新对话', model: 'deepseek-flash', updated_at: null, messages: [] }));
    vi.spyOn(api.studio, 'send').mockResolvedValue(json({ id: 'c2', title: '你好', model: 'deepseek-flash', updated_at: null, messages: [] }));
    renderChat({ provider: 'deepseek', hubProjectId: 'hub1' });
    await screen.findByText('网络断开');
    fireEvent.change(screen.getByRole('textbox', { name: '消息' }), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(screen.queryByText(/还没有 API 密钥/)).toBeNull();
  });

  test('a question prompt without usable questions still offers a way out', () => {
    const decide = vi.fn();
    engine.decide = decide;
    engine.pending = [{ requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [] } } satisfies PendingPermissionRequest];
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    expect(screen.getByRole('heading', { name: 'Claude Code 想问你一个问题' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    expect(decide).toHaveBeenCalledWith('q1', { allow: true, updatedInput: { questions: [], answers: {} } });
  });

  test('a question without options shows its text and the free answer instead of crashing', () => {
    engine.pending = [{ requestId: 'q2', toolName: 'AskUserQuestion', input: { questions: [{ question: '叫什么名字？' }] } } satisfies PendingPermissionRequest];
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    expect(screen.getByRole('heading', { name: '叫什么名字？' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '其他' })).toBeTruthy();
  });
});

describe('handing a conversation to another provider', () => {
  const CONTEXT = '<handoff>\n这段对话之前由 Claude Code（Opus）进行……\n\n## 目标\n把侧栏改成可折叠\n</handoff>';
  const EARLIER = {
    success: true,
    data: {
      messages: [
        { id: 'm1', kind: 'text', role: 'user', content: '把侧栏改成可折叠', timestamp: '2026-10-03T08:00:00.000Z' },
        { id: 'm2', kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'src/Sidebar.tsx' } },
        { id: 'm3', kind: 'text', role: 'assistant', content: '好的，侧栏已经可以折叠。', timestamp: '2026-10-03T08:01:00.000Z' },
      ],
      hasMore: false,
    },
  };
  const THREAD: WorkbenchThread = {
    id: 't1', projectId: 'p1', title: '折叠侧栏', createdAt: '2026-10-03T08:02:00.000Z', updatedAt: '2026-10-03T08:02:00.000Z',
    segments: [
      { kind: 'agent', provider: 'claude', sessionId: 's1', modelLabel: 'Opus', handoffAt: null },
      { kind: 'agent', provider: 'codex', sessionId: 's2', modelLabel: 'GPT-5.5', handoffAt: '2026-10-03T08:02:00.000Z' },
    ],
  };

  // Confirms the sheet; the sheet plays its exit before the choice takes effect.
  async function confirmHandoff() {
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '交接' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  }

  test('Claude Code to Codex: a summary seeds the new session, the earlier messages stay above a divider and the chain is recorded', async () => {
    const handoff = vi.spyOn(api.studio.workbench, 'handoff').mockResolvedValue(json({ summary: '## 目标\n侧栏折叠的需求', context: CONTEXT }));
    const history = vi.spyOn(api.providers, 'sessionMessages').mockResolvedValue(json(EARLIER));
    const link = vi.spyOn(api.studio.workbench, 'linkThread').mockResolvedValue(json(THREAD));
    const selectProviderModel = vi.fn(() => Promise.resolve());
    engine.selectProviderModel = selectProviderModel;
    engine.sessionId = 's1';
    const onThreadChange = vi.fn();
    const session: WorkbenchSessionItem = { id: 's1', kind: 'agent', provider: 'claude', title: '折叠侧栏', updatedAt: null };
    const { onSessionCreated, rerender } = renderChat({ session, onThreadChange });

    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'GPT-5.5' }));
    // The engine's own session id belongs to the session being left; the new chat has none.
    engine.sessionId = null;
    await confirmHandoff();

    // The column becomes a new Codex chat, with the picked model recorded the way the agent view records it.
    expect(selectProviderModel).toHaveBeenCalledWith('codex', 'gpt-5.5', null);
    expect(engine.calls.at(-1)).toMatchObject({ draftProvider: 'codex', session: null });
    expect(handoff).toHaveBeenCalledWith({ projectId: 'p1', from: { kind: 'agent', id: 's1', modelLabel: 'Opus' }, toProvider: 'codex' });
    // The conversation so far stays on screen above the handoff divider, with the summary to look at and a way back.
    expect(history).toHaveBeenCalledWith('s1', { limit: 40, offset: 0 });
    expect(await screen.findByText('好的，侧栏已经可以折叠。')).toBeTruthy();
    expect(screen.getByText('把侧栏改成可折叠')).toBeTruthy();
    expect(screen.getByText('将交给 Codex · GPT-5.5 继续')).toBeTruthy();
    expect(await screen.findByText('查看交接摘要')).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消交接' })).toBeTruthy();

    // The owner's next message goes out with the summary appended.
    const call = engine.calls.at(-1)!;
    expect(await call.prepareNewSessionContent?.('再加一个快捷键')).toBe(`再加一个快捷键\n\n${CONTEXT}`);

    // Its session is created: the shell is told, and the chain is recorded with both sessions.
    const created: WorkbenchSessionItem = { id: 's2', kind: 'agent', provider: 'codex', title: '再加一个快捷键', updatedAt: null };
    act(() => call.onSessionCreated(created));
    expect(onSessionCreated).toHaveBeenCalledWith(created);
    await waitFor(() => expect(link).toHaveBeenCalledWith({
      projectId: 'p1', title: '折叠侧栏',
      from: { kind: 'agent', id: 's1', modelLabel: 'Opus' },
      to: { kind: 'agent', id: 's2', modelLabel: 'GPT-5.5' },
    }));
    await waitFor(() => expect(onThreadChange).toHaveBeenCalledWith(THREAD));

    // The shell routes to the new session: one thread on screen, the divider now says who took over.
    rerender(
      <WorkbenchChat project={project} session={{ ...created, thread: THREAD }} thread={THREAD} provider="claude" hubProjectId={null}
        onSessionCreated={onSessionCreated} onOpenFile={vi.fn()} onThreadChange={onThreadChange} />,
    );
    expect(engine.calls.at(-1)?.session).toMatchObject({ id: 's2', __provider: 'codex' });
    expect(await screen.findByText(/已交接给 Codex · GPT-5.5/)).toBeTruthy();
    expect(screen.getByText('好的，侧栏已经可以折叠。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消交接' })).toBeNull();
  });

  test('DeepSeek to Claude Code: the agent model is recorded for this device and the DeepSeek messages stay above', async () => {
    vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash', 'deepseek-v4-pro'], source: 'vault', baseUrl: '' } }));
    vi.spyOn(api.providers, 'models').mockImplementation(async (provider: string) => json({
      success: true, data: { models: provider === 'codex' ? engine.catalog.codex : engine.catalog.claude },
    }));
    vi.spyOn(api.studio, 'conversation').mockResolvedValue(json({
      id: 'c9', title: '起名字', model: 'deepseek-v4-pro', updated_at: '2026-10-03T08:00:00.000Z',
      messages: [{ id: 1, role: 'user', content: '帮我给侧栏功能起个名字', status: 'complete' }, { id: 2, role: 'assistant', content: '叫「折叠侧栏」如何？', status: 'complete' }],
    }));
    const handoff = vi.spyOn(api.studio.workbench, 'handoff').mockResolvedValue(json({ summary: 's', context: '<handoff>\ns\n</handoff>' }));
    renderChat({ hubProjectId: 'hub1', session: { id: 'c9', kind: 'deepseek', provider: 'deepseek', title: '起名字', updatedAt: null } });

    expect(await screen.findByText('叫「折叠侧栏」如何？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek · deepseek-v4-pro，切换模型' }));
    const claude = within(screen.getByRole('menu')).getByRole('group', { name: 'Claude Code' });
    fireEvent.click(await within(claude).findByRole('menuitemradio', { name: 'Sonnet' }));
    expect(screen.getByRole('alertdialog', { name: '交给 Claude Code 继续？' })).toBeTruthy();
    await confirmHandoff();

    expect(localStorage.getItem('claude-model')).toBe('sonnet');
    expect(engine.calls.at(-1)).toMatchObject({ draftProvider: 'claude', session: null });
    expect(handoff).toHaveBeenCalledWith({ projectId: 'p1', from: { kind: 'deepseek', id: 'c9', modelLabel: 'deepseek-v4-pro' }, toProvider: 'claude' });
    expect(await screen.findByText('叫「折叠侧栏」如何？')).toBeTruthy();
    expect(screen.getByText('将交给 Claude Code · Sonnet 继续')).toBeTruthy();
  });

  test('Codex to DeepSeek: the first DeepSeek message carries the summary and the new conversation joins the chain', async () => {
    vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash', 'deepseek-v4-pro'], source: 'vault', baseUrl: '' } }));
    vi.spyOn(api.providers, 'sessionMessages').mockResolvedValue(json(EARLIER));
    vi.spyOn(api.studio.workbench, 'handoff').mockResolvedValue(json({ summary: 's', context: CONTEXT }));
    const create = vi.spyOn(api.studio, 'createConversation').mockResolvedValue(json({ id: 'c1', title: '新对话', model: 'deepseek-v4-pro', updated_at: '2026-10-03T08:05:00.000Z', messages: [] }));
    const send = vi.spyOn(api.studio, 'send').mockResolvedValue(json({
      id: 'c1', title: '帮我写发布说明', model: 'deepseek-v4-pro', updated_at: '2026-10-03T08:05:05.000Z',
      messages: [
        { id: 1, role: 'user', content: `帮我写发布说明\n\n${CONTEXT}`, status: 'complete' },
        { id: 2, role: 'assistant', content: '发布说明如下。', status: 'complete' },
      ],
    }));
    const link = vi.spyOn(api.studio.workbench, 'linkThread').mockResolvedValue(json({
      ...THREAD, segments: [THREAD.segments[0], { kind: 'deepseek', provider: 'deepseek', sessionId: 'c1', modelLabel: 'deepseek-v4-pro', handoffAt: '2026-10-03T08:05:00.000Z' }],
    }));
    engine.sessionId = 's1';
    renderChat({ hubProjectId: 'hub1', session: { id: 's1', kind: 'agent', provider: 'codex', title: '折叠侧栏', updatedAt: null } });

    fireEvent.click(screen.getByRole('button', { name: /Codex · Opus/ }));
    const deepseek = within(screen.getByRole('menu')).getByRole('group', { name: 'DeepSeek' });
    fireEvent.click(await within(deepseek).findByRole('menuitemradio', { name: 'deepseek-v4-pro' }));
    await confirmHandoff();

    const field = await screen.findByPlaceholderText('给 DeepSeek 发消息');
    expect(await screen.findByText('将交给 DeepSeek · deepseek-v4-pro 继续')).toBeTruthy();
    fireEvent.change(field, { target: { value: '帮我写发布说明' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith('deepseek-v4-pro', 'project:hub1'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('c1', `帮我写发布说明\n\n${CONTEXT}`, false, expect.anything()));
    await waitFor(() => expect(link).toHaveBeenCalledWith(expect.objectContaining({
      from: { kind: 'agent', id: 's1', modelLabel: 'Opus' }, to: { kind: 'deepseek', id: 'c1', modelLabel: 'deepseek-v4-pro' },
    })));
    // The owner's row shows their words; the summary it carried is folded beneath.
    expect(await screen.findByText('发布说明如下。')).toBeTruthy();
    expect(screen.getByText('帮我写发布说明')).toBeTruthy();
    expect(screen.getByText('附带了交接摘要')).toBeTruthy();
  });

  test('a handoff can be called off before the next message, returning to the session', async () => {
    vi.spyOn(api.studio.workbench, 'handoff').mockResolvedValue(json({ summary: 's', context: CONTEXT }));
    vi.spyOn(api.providers, 'sessionMessages').mockResolvedValue(json(EARLIER));
    engine.sessionId = 's1';
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: '折叠侧栏', updatedAt: null } });
    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'GPT-5.5' }));
    await confirmHandoff();
    fireEvent.click(await screen.findByRole('button', { name: '取消交接' }));
    expect(engine.calls.at(-1)?.session).toMatchObject({ id: 's1', __provider: 'claude' });
    expect(screen.queryByText(/将交给 Codex/)).toBeNull();
  });

  test('reopening a handed-over conversation shows it whole; an earlier stretch can no longer be handed on', async () => {
    vi.spyOn(api.providers, 'sessionMessages').mockResolvedValue(json(EARLIER));
    engine.messages = [{ type: 'user', content: `再加一个快捷键\n\n${CONTEXT}`, timestamp: '2026-10-03T08:02:00.000Z' } satisfies ChatMessage];
    const latest = renderChat({ session: { id: 's2', kind: 'agent', provider: 'codex', title: '折叠侧栏', updatedAt: null }, thread: THREAD });
    expect(await screen.findByText('好的，侧栏已经可以折叠。')).toBeTruthy();
    expect(screen.getByText(/已交接给 Codex · GPT-5.5/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开原会话' }).getAttribute('href')).toBe('/work/p1/s/s1');
    expect(screen.getByText('再加一个快捷键')).toBeTruthy();
    expect(screen.getByText('附带了交接摘要')).toBeTruthy();
    latest.unmount();

    // The first stretch opened on its own: its provider stays, and the menu says where the conversation went on.
    engine.messages = [];
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: '折叠侧栏', updatedAt: null }, thread: THREAD });
    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('group', { name: 'Codex' })).toBeNull();
    expect(within(menu).getByText(/已经交给其他模型继续了/)).toBeTruthy();
  });
});
