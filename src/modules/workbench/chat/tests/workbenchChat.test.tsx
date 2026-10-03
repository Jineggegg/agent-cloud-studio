import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';
import { api } from '@/shared/api';
import type { ChatMessage, PendingPermissionRequest, Project, WorkbenchChatChrome, WorkbenchChatProps } from '@/shared/types';
import { WorkbenchChat } from '@/modules/workbench/chat/WorkbenchChat';

// The chat engine talks to the WebSocket and the session store; these tests fake it and check the column's rules.
const engine = vi.hoisted(() => ({
  calls: [] as { draftProvider: string; session: { id: string; __provider: string } | null }[],
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
}));

vi.mock('@/modules/workbench/chat/hooks/useWorkbenchAgentEngine', () => ({
  useWorkbenchAgentEngine: (args: { draftProvider: string; session: { id: string; __provider: string } | null }) => {
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
        providerModelCatalog: {},
        providerModelActions: { create: noop, update: noop, remove: noop },
        selectProviderModel: noop,
        supportsMessageEditing: false,
      },
      session: {
        chatMessages: engine.messages,
        visibleMessages: engine.messages,
        isProcessing: false,
        canAbortSession: false,
        sessionActivity: null,
        tokenBudget: { used: 50_000, total: 200_000 },
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
        handleAbortSession: noop,
        beginEditMessage: noop,
        showCostModal: noop,
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
  );
  return { ...utils, onSessionCreated, onOpenFile };
}

afterEach(() => {
  engine.effort = 'default';
  engine.effortOptions = [];
  engine.calls.length = 0;
  engine.messages = [];
  engine.sessionId = null;
  engine.pending = [];
  engine.delivery = null;
  engine.preparedRecovery = null;
  engine.recoveryRuns = [];
});

describe('provider switching', () => {
  test('a new chat can switch between Claude Code, Codex and DeepSeek before its first message', async () => {
    vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash'], source: 'vault', baseUrl: '' } }));
    renderChat({ hubProjectId: 'hub1' });

    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    const menu = screen.getByRole('menu');
    for (const name of ['Claude Code', 'Codex', 'DeepSeek', 'Opus', 'Sonnet']) {
      expect(within(menu).getByRole('menuitemradio', { name })).toBeTruthy();
    }
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Codex' }));
    expect(engine.calls.at(-1)?.draftProvider).toBe('codex');

    fireEvent.click(screen.getByRole('button', { name: /Codex · Opus/ }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'DeepSeek' }));
    expect(await screen.findByPlaceholderText('给 DeepSeek 发消息')).toBeTruthy();
  });

  test('an open session keeps its provider; only the model can change', async () => {
    const selectModel = vi.fn(() => Promise.resolve());
    engine.selectModel = selectModel;
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'codex', title: '重构侧栏', updatedAt: null } });

    expect(engine.calls.at(-1)?.session).toMatchObject({ id: 's1', __provider: 'codex' });
    expect(screen.getByText('重构侧栏')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Codex · Opus/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('menuitemradio', { name: 'DeepSeek' })).toBeNull();
    expect(within(menu).getByText('对话开始后不能更换服务，可以新建一个对话。')).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Sonnet' }));
    await waitFor(() => expect(selectModel).toHaveBeenCalledWith('sonnet'));
  });

  test('once the first message is out, a new chat locks its provider too', () => {
    engine.sessionId = 's-new';
    engine.messages = [{ type: 'user', content: '你好', timestamp: '2026-10-02T08:00:00.000Z' } satisfies ChatMessage];
    renderChat();
    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    expect(within(screen.getByRole('menu')).queryByRole('menuitemradio', { name: 'Codex' })).toBeNull();
  });

  test('the token ring reports how full the context is', () => {
    renderChat({ session: { id: 's1', kind: 'agent', provider: 'claude', title: 't', updatedAt: null } });
    expect(screen.getByRole('button', { name: '上下文已用 25%（50K / 200K）' })).toBeTruthy();
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
    // Started: the provider is fixed and the model too.
    expect(screen.queryByRole('button', { name: /切换服务或模型/ })).toBeNull();
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
    expect(screen.getByLabelText('DeepSeek · deepseek-v4-pro')).toBeTruthy();
  });
});

describe('one rule with the shell', () => {
  test('without a Studio project DeepSeek is listed but disabled, with the same reason as the new-session menu', () => {
    renderChat({ hubProjectId: null });
    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    const deepseek = within(screen.getByRole('menu')).getByRole('menuitemradio', { name: /DeepSeek/ });
    expect((deepseek as HTMLButtonElement).disabled).toBe(true);
    expect(within(deepseek).getByText('需先在 Studio 中建立此项目')).toBeTruthy();
    fireEvent.click(deepseek);
    expect(engine.calls.at(-1)?.draftProvider).toBe('claude');
    expect(screen.queryByPlaceholderText('给 DeepSeek 发消息')).toBeNull();
  });

  test('a DeepSeek preselection the directory cannot honour starts Claude Code, like the shell', () => {
    renderChat({ provider: 'deepseek', hubProjectId: null });
    expect(engine.calls.at(-1)?.draftProvider).toBe('claude');
    expect(screen.getByRole('button', { name: /Claude Code · Opus/ })).toBeTruthy();
  });

  test('a Cursor launch runs Cursor and keeps it among the choices', () => {
    renderChat({ provider: 'cursor', hubProjectId: 'hub1' });
    expect(engine.calls.at(-1)?.draftProvider).toBe('cursor');
    fireEvent.click(screen.getByRole('button', { name: /Cursor · Opus/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: 'Cursor' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Codex' }));
    expect(engine.calls.at(-1)?.draftProvider).toBe('codex');
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
    expect(within(modelMenu).getAllByRole('menuitemradio').map((row) => row.textContent)).toEqual(['Opus', 'Sonnet']);
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
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Codex' }));
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
