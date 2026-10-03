import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import {
  FileText,
  ImagePlus,
  ListPlus,
  Map as MapIcon,
  PencilLine,
  Shield,
  ShieldOff,
  Sparkle,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type { PermissionMode, ProviderModelOption, WorkbenchMenuSection } from '@/shared/types';
import { resolveModelChoice } from '@/shared/utils';
import type { useWorkbenchAgentEngine } from '@/modules/workbench/chat/hooks/useWorkbenchAgentEngine';
import { useSpeechDictation } from '@/modules/workbench/chat/hooks/useSpeechDictation';
import { WorkbenchEffortControl } from '@/modules/workbench/chat/WorkbenchEffortControl';
import { WorkbenchMenu } from '@/modules/workbench/chat/WorkbenchMenu';
import { WorkbenchMicButton } from '@/modules/workbench/chat/WorkbenchMicButton';
import { WorkbenchSendButton } from '@/modules/workbench/chat/WorkbenchSendButton';
import { WorkbenchSuggestedInput } from '@/modules/workbench/chat/WorkbenchSuggestedInput';
import { WorkbenchSuggestionChip } from '@/modules/workbench/chat/WorkbenchSuggestionChip';
import { modelShortLabel, permissionModeCopy, providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

type ComposerState = ReturnType<typeof useWorkbenchAgentEngine>['composer'];

type WorkbenchComposerProps = {
  composer: ComposerState;
  provider: string;
  permissionMode: PermissionMode;
  permissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  model: string;
  modelOptions: ProviderModelOption[];
  // The one model menu (oneModelMenuSections), shared with the header pill.
  modelSections: WorkbenchMenuSection[];
  effort: string;
  effortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  isProcessing: boolean;
  canAbort: boolean;
  onAbort: () => void;
  // The suggested next message (useSuggestedPrompt): faint in the empty field (Send sends it), a chip once it has text.
  suggestion?: string | null;
  // Called when the suggestion is sent or filled in, so it does not show again before the next answer.
  onSuggestionUsed?: () => void;
  // The run status pill (WorkbenchRunStatus), shown at the toolbar's right end just left of the send/stop disc.
  runStatus?: ReactNode;
};

const POPOVER_SPRING = { type: 'spring', stiffness: 520, damping: 36, mass: 0.7 } as const;

/** A pending attachment: an image thumbnail (object URL revoked on unmount) or a file chip. */
function AttachmentTile({ file, error, onRemove }: { file: File; error?: string; onRemove: () => void }) {
  // Thumbnail URL for an image file, created once per file and revoked when the tile goes.
  const previewUrl = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <m.li
      className={`wbc-attachment${error ? ' is-error' : ''}`}
      layout
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={POPOVER_SPRING}
      title={error ?? file.name}
    >
      {previewUrl ? <img src={previewUrl} alt={file.name} /> : <span className="wbc-attachment-file"><FileText size={18} aria-hidden="true" /><span>{file.name}</span></span>}
      <button type="button" className="wbc-attachment-remove" aria-label={`移除 ${file.name}`} onClick={onRemove}><X size={12} strokeWidth={3} /></button>
    </m.li>
  );
}

/**
 * Used by WorkbenchAgentChat as the input dock: an auto-growing field (Enter sends, Shift+Enter breaks the line),
 * image attachments by drop, paste or picker, dictation where the browser has speech recognition, typed slash
 * commands and @ file mentions, the permission-mode and model chips, the reasoning-effort control, and the spring
 * send/stop disc. All sending behaviour comes from the inherited composer hook. With the field empty, a suggested
 * next message shows faintly: Send (or Enter) sends it as it is. Once the field has text (typed or dictated) it moves to
 * a chip above the field, which fills it in or sends it; clearing the field brings back the faint one. While a run
 * lasts, the chat's run status pill sits at the toolbar's right end, beside the disc that then stops the run.
 */
export function WorkbenchComposer({
  composer,
  provider,
  permissionMode,
  permissionModes,
  onSelectPermissionMode,
  model,
  modelOptions,
  modelSections,
  effort,
  effortOptions,
  onSelectEffort,
  isProcessing,
  canAbort,
  onAbort,
  suggestion = null,
  onSuggestionUsed,
  runStatus = null,
}: WorkbenchComposerProps) {
  const {
    input,
    setInput,
    textareaRef,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    handleInputFocusChange,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    handleCommandSelect,
    resetCommandMenuState,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    selectFile,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    editingAnchorId,
    cancelEditMessage,
    delivery,
    preparedRecovery,
    handleVoiceTranscript,
  } = composer;
  const commandListRef = useRef<HTMLDivElement>(null);
  const hasContent = Boolean(input.trim()) || attachedFiles.length > 0;
  const sendMode = isProcessing ? (hasContent ? 'queue' : 'stop') : 'send';
  // Until the server confirms (or refuses) the last send, the button stays off so one draft never runs twice; a
  // prepared continuation must be sent explicitly once the current run ends, never queued (as in ChatComposer).
  const sendBlocked = delivery?.state === 'sending' || delivery?.state === 'unknown' || (Boolean(preparedRecovery) && isProcessing);
  // The suggestion is offered only between runs; editing a sent message or a recovery draft hides it.
  const offeredSuggestion = suggestion && !isProcessing && !editingAnchorId && !preparedRecovery ? suggestion : null;
  // An empty field shows it faintly in place; once the field has content (typed or dictated) it moves to a chip.
  const shownSuggestion = offeredSuggestion && !hasContent ? offeredSuggestion : null;
  const chipSuggestion = offeredSuggestion && hasContent ? offeredSuggestion : null;
  // Dictation writes into the same draft the keyboard does.
  const dictation = useSpeechDictation({ text: input, onText: setInput, onError: (message) => toast.error(message) });
  // The transcript hook mirrors the text into the composer's ref, so submitting reads it at once (as dictation does).
  // A suggestion stands in for the whole draft, so the microphone stops first and its late words are dropped.
  const takeSuggestion = (text: string | null, send: boolean) => {
    if (!text || (send && sendBlocked)) return;
    if (dictation.listening) dictation.stop();
    onSuggestionUsed?.();
    handleVoiceTranscript(text, send, { replace: true });
    if (!send) textareaRef.current?.focus();
  };
  const sendSuggestion = () => takeSuggestion(shownSuggestion, true);
  const modeCopy = permissionModeCopy(permissionMode);
  const modelName = modelShortLabel(model, modelOptions);
  // The effort control's stops: the levels this model accepts (the `default` sentinel is not a stop).
  const effortLevels = useMemo(
    () => effortOptions.map((option) => option.value).filter((value) => value !== DEFAULT_EFFORT_VALUE),
    [effortOptions],
  );
  const recommendedEffort = resolveModelChoice(modelOptions, model)?.option.effort?.default;
  // Whether the model menu is open; held here because the effort popover's model row opens it too.
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  // Keep the highlighted slash command in view while arrowing through a long list.
  useEffect(() => {
    if (!showCommandMenu || selectedCommandIndex < 0) return;
    commandListRef.current?.querySelector<HTMLElement>(`[data-index="${selectedCommandIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedCommandIndex, showCommandMenu]);

  const rootProps = getRootProps() as Record<string, unknown>;

  return (
    <div className={`wbc-composer-wrap${isDragActive ? ' is-dragging' : ''}`} {...rootProps}>
      <input {...(getInputProps() as Record<string, unknown>)} />

      <AnimatePresence>
        {queuedDraft && (
          <m.div
            key="queued"
            className="wbc-queued"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={POPOVER_SPRING}
          >
            <ListPlus size={15} aria-hidden="true" />
            <span className="wbc-queued-text"><strong>已排队</strong>{queuedDraft.content}</span>
            <button type="button" className="wbc-mini-button" onClick={editQueuedDraft}><PencilLine size={14} /><span>编辑</span></button>
            <button type="button" className="wbc-mini-button" aria-label="删除排队的消息" onClick={deleteQueuedDraft}><Trash2 size={14} /></button>
          </m.div>
        )}
        {editingAnchorId && (
          <m.div key="editing" className="wbc-editing" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={POPOVER_SPRING}>
            <PencilLine size={15} aria-hidden="true" />
            <span>正在改写已发送的消息，发送后会替换它和之后的回复（文件改动不会撤回）</span>
            <button type="button" className="wbc-mini-button" onClick={cancelEditMessage}>取消</button>
          </m.div>
        )}
      </AnimatePresence>

      <form
        className="wbc-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (shownSuggestion) sendSuggestion();
          else void handleSubmit(event);
        }}
      >
        <AnimatePresence>
          {showCommandMenu && filteredCommands.length > 0 && (
            <m.div
              key="commands"
              ref={commandListRef}
              className="wbc-popover"
              role="listbox"
              aria-label="命令"
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, transition: { duration: 0.12 } }}
              transition={POPOVER_SPRING}
            >
              {filteredCommands.map((command, index) => (
                <button
                  key={`${command.namespace ?? ''}-${command.name}`}
                  type="button"
                  role="option"
                  data-index={index}
                  aria-selected={index === selectedCommandIndex}
                  className={`wbc-popover-item${index === selectedCommandIndex ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => handleCommandSelect(command, index, true)}
                  onClick={() => handleCommandSelect(command, index, false)}
                >
                  <span className="wbc-popover-name">{command.name}</span>
                  {command.description && <span className="wbc-popover-hint">{command.description}</span>}
                </button>
              ))}
              <button type="button" className="wbc-popover-close" onClick={resetCommandMenuState}>关闭</button>
            </m.div>
          )}
          {showFileDropdown && filteredFiles.length > 0 && (
            <m.div
              key="files"
              className="wbc-popover"
              role="listbox"
              aria-label="引用文件"
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, transition: { duration: 0.12 } }}
              transition={POPOVER_SPRING}
            >
              {filteredFiles.map((file, index) => (
                <button
                  key={file.path}
                  type="button"
                  role="option"
                  aria-selected={index === selectedFileIndex}
                  className={`wbc-popover-item${index === selectedFileIndex ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectFile(file)}
                >
                  <span className="wbc-popover-name">{file.name}</span>
                  <span className="wbc-popover-hint is-mono">{file.path}</span>
                </button>
              ))}
            </m.div>
          )}
        </AnimatePresence>

        {attachedFiles.length > 0 && (
          <ul className="wbc-attachments-strip" aria-label="待发送的附件">
            <AnimatePresence initial={false}>
              {attachedFiles.map((file, index) => (
                <AttachmentTile
                  key={`${file.name}-${file.lastModified}-${index}`}
                  file={file}
                  error={fileErrors.get(file.name)}
                  onRemove={() => setAttachedFiles((previous) => previous.filter((_, current) => current !== index))}
                />
              ))}
            </AnimatePresence>
          </ul>
        )}

        <WorkbenchSuggestionChip
          suggestion={chipSuggestion}
          sendDisabled={sendBlocked}
          onFill={() => takeSuggestion(chipSuggestion, false)}
          onSend={() => takeSuggestion(chipSuggestion, true)}
        />

        <WorkbenchSuggestedInput suggestion={shownSuggestion}>
          <textarea
            ref={textareaRef}
            className="wbc-input"
            rows={1}
            dir="auto"
            aria-label="消息"
            aria-description={shownSuggestion ? `建议的下一条：${shownSuggestion}。直接发送即可` : undefined}
            enterKeyHint="send"
            placeholder={shownSuggestion ? '' : `给 ${providerLabel(provider)} 发消息`}
            value={input}
            onChange={handleInputChange}
            onKeyDown={(event) => {
              const composing = event.nativeEvent.isComposing || event.keyCode === 229;
              if (shownSuggestion && !composing && event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                sendSuggestion();
                return;
              }
              handleKeyDown(event);
            }}
            onPaste={handlePaste}
            onClick={handleTextareaClick}
            onInput={handleTextareaInput}
            onFocus={() => handleInputFocusChange(true)}
            onBlur={() => handleInputFocusChange(false)}
          />
        </WorkbenchSuggestedInput>

        <div className="wbc-composer-bar">
          <button type="button" className="wbc-tool-button" aria-label="添加图片或文件" title="添加图片或文件" onClick={openAttachmentPicker}>
            <ImagePlus size={18} strokeWidth={2} />
          </button>
          {dictation.supported && <WorkbenchMicButton listening={dictation.listening} onToggle={dictation.toggle} />}
          <WorkbenchMenu
            label={`权限：${modeCopy.label}`}
            triggerClassName={`wbc-chip is-mode-${permissionMode}`}
            placement="up"
            trigger={(
              <>
                {permissionMode === 'bypassPermissions' ? <ShieldOff size={14} strokeWidth={2.2} aria-hidden="true" />
                  : permissionMode === 'plan' ? <MapIcon size={14} strokeWidth={2.2} aria-hidden="true" />
                    : <Shield size={14} strokeWidth={2.2} aria-hidden="true" />}
                <span>{modeCopy.label}</span>
              </>
            )}
            sections={[{
              key: 'mode',
              title: '权限（Tab 切换）',
              items: permissionModes.map((mode) => {
                const copy = permissionModeCopy(mode);
                return {
                  key: mode,
                  label: copy.label,
                  hint: copy.hint,
                  checked: mode === permissionMode,
                  tone: mode === 'bypassPermissions' ? 'danger' as const : undefined,
                  onSelect: () => onSelectPermissionMode(mode),
                };
              }),
            }]}
          />
          <WorkbenchMenu
            label={`模型 ${modelName}`}
            triggerClassName="wbc-chip"
            placement="up"
            open={modelMenuOpen}
            onOpenChange={setModelMenuOpen}
            trigger={(
              <>
                <Sparkle size={13} strokeWidth={2.2} aria-hidden="true" />
                <span>{modelName}</span>
              </>
            )}
            width={320}
            sections={modelSections}
          />
          {effortLevels.length > 0 && (
            <WorkbenchEffortControl
              effort={effort}
              levels={effortLevels}
              recommended={recommendedEffort}
              modelLabel={modelName}
              onSelectEffort={onSelectEffort}
              onOpenModels={() => setModelMenuOpen(true)}
            />
          )}
          <span className="wbc-composer-spacer" />
          {runStatus}
          <WorkbenchSendButton
            mode={sendMode}
            disabled={sendBlocked || (sendMode === 'send' ? !hasContent && !shownSuggestion : sendMode === 'stop' ? !canAbort : false)}
            onStop={onAbort}
          />
        </div>

        <AnimatePresence>
          {isDragActive && (
            <m.div className="wbc-drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <ImagePlus size={22} aria-hidden="true" />
              <span>松手即可附加</span>
            </m.div>
          )}
        </AnimatePresence>
      </form>
    </div>
  );
}
