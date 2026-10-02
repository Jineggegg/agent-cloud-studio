import { useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, m } from 'motion/react';
import {
  FileText,
  ImagePlus,
  ListPlus,
  Map as MapIcon,
  PencilLine,
  Shield,
  ShieldOff,
  Slash,
  Sparkle,
  Trash2,
  X,
} from 'lucide-react';

import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type { PermissionMode, ProviderModelOption } from '@/shared/types';
import type { useWorkbenchAgentEngine } from '@/modules/workbench/chat/hooks/useWorkbenchAgentEngine';
import { WorkbenchMenu } from '@/modules/workbench/chat/WorkbenchMenu';
import { WorkbenchSendButton } from '@/modules/workbench/chat/WorkbenchSendButton';
import { effortLabel, modelShortLabel, permissionModeCopy, providerLabel } from '@/modules/workbench/chat/utils/workbenchChatCopy';

type ComposerState = ReturnType<typeof useWorkbenchAgentEngine>['composer'];

type WorkbenchComposerProps = {
  composer: ComposerState;
  provider: string;
  permissionMode: PermissionMode;
  permissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  model: string;
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  effort: string;
  effortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  isProcessing: boolean;
  canAbort: boolean;
  onAbort: () => void;
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
 * image attachments by drop, paste or picker, slash commands and @ file mentions, the permission-mode and
 * model/effort chips, and the spring send/stop disc. All behaviour comes from the inherited composer hook.
 */
export function WorkbenchComposer({
  composer,
  provider,
  permissionMode,
  permissionModes,
  onSelectPermissionMode,
  model,
  modelOptions,
  onSelectModel,
  effort,
  effortOptions,
  onSelectEffort,
  isProcessing,
  canAbort,
  onAbort,
}: WorkbenchComposerProps) {
  const {
    input,
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
    handleToggleCommandMenu,
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
  } = composer;
  const commandListRef = useRef<HTMLDivElement>(null);
  const hasContent = Boolean(input.trim()) || attachedFiles.length > 0;
  const sendMode = isProcessing ? (hasContent ? 'queue' : 'stop') : 'send';
  const modeCopy = permissionModeCopy(permissionMode);
  const modelName = modelShortLabel(model, modelOptions);
  const showEffort = effortOptions.length > 0;

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
          void handleSubmit(event);
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

        <textarea
          ref={textareaRef}
          className="wbc-input"
          rows={1}
          dir="auto"
          aria-label="消息"
          enterKeyHint="send"
          placeholder={`给 ${providerLabel(provider)} 发消息`}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onClick={handleTextareaClick}
          onInput={handleTextareaInput}
          onFocus={() => handleInputFocusChange(true)}
          onBlur={() => handleInputFocusChange(false)}
        />

        <div className="wbc-composer-bar">
          <button type="button" className="wbc-tool-button" aria-label="添加图片或文件" title="添加图片或文件" onClick={openAttachmentPicker}>
            <ImagePlus size={18} strokeWidth={2} />
          </button>
          <button
            type="button"
            className={`wbc-tool-button${showCommandMenu ? ' is-active' : ''}`}
            aria-label="命令"
            title="命令"
            aria-expanded={showCommandMenu}
            onClick={handleToggleCommandMenu}
          >
            <Slash size={17} strokeWidth={2.2} />
          </button>
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
            label={`模型 ${modelName}${showEffort ? `，思考 ${effortLabel(effort)}` : ''}`}
            triggerClassName="wbc-chip"
            placement="up"
            trigger={(
              <>
                <Sparkle size={13} strokeWidth={2.2} aria-hidden="true" />
                <span>{modelName}{showEffort && effort !== DEFAULT_EFFORT_VALUE ? ` · ${effortLabel(effort)}` : ''}</span>
              </>
            )}
            sections={[
              {
                key: 'model',
                title: '模型',
                items: modelOptions.map((option) => ({
                  key: option.value,
                  label: option.label,
                  hint: option.description,
                  checked: option.value === model,
                  onSelect: () => onSelectModel(option.value),
                })),
                note: modelOptions.length ? undefined : '正在读取模型…',
              },
              {
                key: 'effort',
                title: '思考强度',
                items: showEffort
                  ? [{ value: DEFAULT_EFFORT_VALUE, description: '由模型决定' }, ...effortOptions.filter((option) => option.value !== DEFAULT_EFFORT_VALUE)].map((option) => ({
                    key: option.value,
                    label: effortLabel(option.value),
                    hint: option.description,
                    checked: option.value === effort,
                    onSelect: () => onSelectEffort(option.value),
                  }))
                  : [],
              },
            ]}
          />
          <span className="wbc-composer-spacer" />
          <WorkbenchSendButton
            mode={sendMode}
            disabled={sendMode === 'send' ? !hasContent : sendMode === 'stop' ? !canAbort : false}
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
