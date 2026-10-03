import { useRef, useState } from 'react';
import type { ComponentProps, SetStateAction } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import { WorkbenchComposer } from '@/modules/workbench/chat/WorkbenchComposer';
import { WorkbenchDeepSeekChat } from '@/modules/workbench/chat/WorkbenchDeepSeekChat';

// The DeepSeek column's suggestion and conversation, faked so the tests drive the composer alone.
const deepseek = vi.hoisted(() => ({
  suggestion: '再举一个例子' as string | null,
  dismiss: (() => undefined) as () => void,
  send: (() => Promise.resolve(true)) as (message: string, model: string, includeSnr: boolean) => Promise<boolean>,
  sending: false,
}));

vi.mock('@/shared/hooks/useSuggestedPrompt', () => ({
  useSuggestedPrompt: () => ({ suggestion: deepseek.suggestion, dismiss: () => deepseek.dismiss() }),
}));

vi.mock('@/modules/workbench/chat/hooks/useDeepSeekConversation', () => ({
  useDeepSeekConversation: () => ({
    status: { deepseek: { configured: true, models: ['deepseek-flash'], source: 'vault', baseUrl: '' } },
    conversation: { id: 'c1', title: '旧对话', model: 'deepseek-flash', updated_at: null, messages: [] },
    loading: false,
    sending: deepseek.sending,
    sendingSince: null,
    error: null,
    send: (message: string, model: string, includeSnr: boolean) => deepseek.send(message, model, includeSnr),
    stop: () => undefined,
    clearError: () => undefined,
  }),
}));

// A stand-in for Safari's webkitSpeechRecognition that lets a test speak into the draft.
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
  speak(transcript: string) {
    act(() => this.onresult?.({ results: [{ isFinal: false, 0: { transcript } }] }));
  }
}
const speechScope = window as Window & { webkitSpeechRecognition?: unknown };

afterEach(() => {
  delete speechScope.webkitSpeechRecognition;
  FakeRecognition.instances = [];
  deepseek.suggestion = '再举一个例子';
  deepseek.dismiss = () => undefined;
  deepseek.send = () => Promise.resolve(true);
  deepseek.sending = false;
});

type ComposerProps = ComponentProps<typeof WorkbenchComposer>;
const noop = () => undefined;

/**
 * The agent composer over a small stand-in for the inherited composer hook: a real draft, and a transcript handler
 * that appends (or, with `replace`, stands in for the draft) and "sends" by reporting the text and clearing the field.
 */
function AgentComposer({ processing = false, onUsed, onSent }: { processing?: boolean; onUsed: () => void; onSent: (text: string) => void }) {
  const [input, setInputState] = useState('');
  const inputRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Cleared once the suggestion is used, as useSuggestedPrompt's dismiss does.
  const [suggestion, setSuggestion] = useState<string | null>('再举一个例子');
  const setInput = (next: SetStateAction<string>) => {
    inputRef.current = typeof next === 'function' ? next(inputRef.current) : next;
    setInputState(inputRef.current);
  };
  const composer = {
    input,
    setInput,
    textareaRef,
    attachedFiles: [],
    setAttachedFiles: noop,
    fileErrors: new Map(),
    getRootProps: () => ({}),
    getInputProps: () => ({ type: 'file', hidden: true }),
    isDragActive: false,
    openAttachmentPicker: noop,
    handleSubmit: () => { onSent(inputRef.current); setInput(''); },
    handleInputChange: (event: { target: { value: string } }) => setInput(event.target.value),
    handleKeyDown: noop,
    handlePaste: noop,
    handleTextareaClick: noop,
    handleTextareaInput: noop,
    handleInputFocusChange: noop,
    showCommandMenu: false,
    filteredCommands: [],
    selectedCommandIndex: -1,
    handleCommandSelect: noop,
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
    delivery: null,
    preparedRecovery: null,
    handleVoiceTranscript: (text: string, send?: boolean, options?: { replace?: boolean }) => {
      const base = options?.replace ? '' : inputRef.current.trim();
      setInput(base ? `${base} ${text}` : text);
      if (send) { onSent(inputRef.current); setInput(''); }
    },
  } as unknown as ComposerProps['composer'];
  return (
    <WorkbenchComposer
      composer={composer}
      provider="claude"
      permissionMode="default"
      permissionModes={['default']}
      onSelectPermissionMode={noop}
      model="opus"
      modelOptions={[{ value: 'opus', label: 'Opus' }]}
      modelSections={[]}
      effort="default"
      effortOptions={[]}
      onSelectEffort={noop}
      isProcessing={processing}
      canAbort={false}
      onAbort={noop}
      suggestion={suggestion}
      onSuggestionUsed={() => { onUsed(); setSuggestion(null); }}
    />
  );
}

const field = () => screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
const chip = () => screen.queryByRole('group', { name: '输入建议' });

describe('the agent composer suggestion', () => {
  test('an empty field shows the suggestion faintly in place, with no chip', () => {
    const { container } = render(<AgentComposer onUsed={vi.fn()} onSent={vi.fn()} />);
    expect(container.querySelector('.wbc-suggestion')?.textContent).toBe('再举一个例子');
    expect(chip()).toBeNull();
  });

  test('typed text moves it to a chip; clearing the field brings back the faint one', () => {
    const { container } = render(<AgentComposer onUsed={vi.fn()} onSent={vi.fn()} />);
    fireEvent.change(field(), { target: { value: '帮我看看' } });
    expect(container.querySelector('.wbc-suggestion')).toBeNull();
    expect(within(chip() as HTMLElement).getByText('再举一个例子')).toBeTruthy();
    fireEvent.change(field(), { target: { value: '' } });
    expect(container.querySelector('.wbc-suggestion')?.textContent).toBe('再举一个例子');
  });

  test('tapping the chip while dictating stops the microphone and puts the suggestion in place of the draft', () => {
    speechScope.webkitSpeechRecognition = FakeRecognition;
    const onUsed = vi.fn();
    const onSent = vi.fn();
    render(<AgentComposer onUsed={onUsed} onSent={onSent} />);
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    FakeRecognition.instances[0].speak('修一下登录页');
    expect(field().value).toBe('修一下登录页');

    fireEvent.click(screen.getByRole('button', { name: '用建议替换输入：再举一个例子' }));
    expect(FakeRecognition.instances[0].stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '语音输入' }).getAttribute('aria-pressed')).toBe('false');
    expect(field().value).toBe('再举一个例子');
    expect(onUsed).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();
  });

  test('its 发送 sends the suggestion as it is and leaves the dictated draft out', () => {
    speechScope.webkitSpeechRecognition = FakeRecognition;
    const onUsed = vi.fn();
    const onSent = vi.fn();
    render(<AgentComposer onUsed={onUsed} onSent={onSent} />);
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    FakeRecognition.instances[0].speak('修一下登录页');

    fireEvent.click(screen.getByRole('button', { name: '发送建议：再举一个例子' }));
    expect(FakeRecognition.instances[0].stop).toHaveBeenCalled();
    expect(onSent).toHaveBeenCalledWith('再举一个例子');
    expect(onUsed).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('');
  });

  test('no chip while a run is going', () => {
    render(<AgentComposer processing onUsed={vi.fn()} onSent={vi.fn()} />);
    fireEvent.change(field(), { target: { value: '帮我看看' } });
    expect(chip()).toBeNull();
  });
});

const project: Project = { projectId: 'p1', displayName: 'Agent Cloud Studio', fullPath: '/repo' };

function renderDeepSeek() {
  return render(
    <WorkbenchDeepSeekChat
      project={project}
      conversationId="c1"
      title="旧对话"
      hubProjectId={null}
      providerChoices={null}
      catalogs={{ claude: null, codex: null, deepseek: null }}
      draftModel={null}
      onDraftModelChange={noop}
      onSelectProvider={noop}
      onSessionCreated={noop}
    />,
    { wrapper: MemoryRouter },
  );
}

describe('the DeepSeek composer suggestion', () => {
  test('a draft shows the chip; tapping it fills the field and dismisses the suggestion', () => {
    const dismiss = vi.fn();
    deepseek.dismiss = dismiss;
    const { container } = renderDeepSeek();
    expect(container.querySelector('.wbc-suggestion')?.textContent).toBe('再举一个例子');
    fireEvent.change(field(), { target: { value: '换个话题' } });
    fireEvent.click(screen.getByRole('button', { name: '用建议替换输入：再举一个例子' }));
    expect(field().value).toBe('再举一个例子');
    expect(dismiss).toHaveBeenCalled();
  });

  test('its 发送 stops dictation and sends the suggestion, not the dictated draft', async () => {
    speechScope.webkitSpeechRecognition = FakeRecognition;
    const send = vi.fn(() => Promise.resolve(true));
    const dismiss = vi.fn();
    deepseek.send = send;
    deepseek.dismiss = dismiss;
    renderDeepSeek();
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }));
    FakeRecognition.instances[0].speak('今天的进度');
    expect(field().value).toBe('今天的进度');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送建议：再举一个例子' })); });
    expect(FakeRecognition.instances[0].stop).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('再举一个例子', 'deepseek-flash', false);
    expect(dismiss).toHaveBeenCalled();
    expect(field().value).toBe('');
  });

  test('no chip while a reply is coming', () => {
    deepseek.sending = true;
    renderDeepSeek();
    fireEvent.change(field(), { target: { value: '换个话题' } });
    expect(chip()).toBeNull();
  });
});
