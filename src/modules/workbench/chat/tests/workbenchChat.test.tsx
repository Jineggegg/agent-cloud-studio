import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { ChatMessage, PendingPermissionRequest, Project, WorkbenchChatProps } from '@/shared/types';
import { WorkbenchChat } from '@/modules/workbench/chat/WorkbenchChat';

// The chat engine talks to the WebSocket and the session store; these tests fake it and check the column's rules.
const engine = vi.hoisted(() => ({
  calls: [] as { draftProvider: string; session: { id: string; __provider: string } | null }[],
  messages: [] as unknown[],
  sessionId: null as string | null,
  pending: [] as unknown[],
  selectModel: (() => Promise.resolve()) as (model: string) => Promise<void>,
  decide: (() => undefined) as (...args: unknown[]) => void,
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
        currentProviderEffort: 'default',
        currentProviderEffortOptions: [],
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
      },
      sessionId: engine.sessionId,
      sendMessage: noop,
      selectModel: (model: string) => engine.selectModel(model),
      selectEffort: () => Promise.resolve(),
    };
  },
}));

const project: Project = { projectId: 'p1', displayName: 'Agent Cloud Studio', fullPath: '/repo' };

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function renderChat(props: Partial<WorkbenchChatProps> = {}) {
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
  engine.calls.length = 0;
  engine.messages = [];
  engine.sessionId = null;
  engine.pending = [];
});

describe('provider switching', () => {
  test('a new chat can switch between Claude Code, Codex and DeepSeek before its first message', async () => {
    vi.spyOn(api.studio, 'status').mockResolvedValue(json({ deepseek: { configured: true, models: ['deepseek-flash'], source: 'vault', baseUrl: '' } }));
    renderChat();

    fireEvent.click(screen.getByRole('button', { name: /Claude Code · Opus/ }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(
      expect.arrayContaining(['Claude Code', 'Codex', 'DeepSeek', 'Opus', 'Sonnet']),
    );
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
    renderChat({ provider: 'deepseek' });
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
