import { useState } from 'react';
import { SquarePen } from 'lucide-react';

import type { WorkbenchNewProvider } from '@/shared/types';
import { WorkbenchPopover } from '@/modules/workbench/WorkbenchPopover';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';

// The three ways a workbench chat can start, in the order the owner reaches for them.
const OPTIONS: { provider: WorkbenchNewProvider; name: string; caption: string }[] = [
  { provider: 'claude', name: 'Claude Code', caption: 'Claude 订阅 · 在项目目录运行' },
  { provider: 'codex', name: 'Codex', caption: 'ChatGPT 订阅 · 在项目目录运行' },
  { provider: 'deepseek', name: 'DeepSeek', caption: 'API · 项目对话' },
];

/**
 * Used by the workbench sidebar for "+ 新会话": opens a menu of Claude Code, Codex and DeepSeek, marking the one
 * used last. DeepSeek needs a Studio hub project for its conversation space, so it is disabled without one.
 */
export function WorkbenchNewSession({ lastProvider, deepseekAvailable, shortcut, onStart }: {
  lastProvider: WorkbenchNewProvider; deepseekAvailable: boolean; shortcut: string | null; onStart: (provider: WorkbenchNewProvider) => void;
}) {
  // The trigger, anchoring the menu.
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  // The provider menu.
  const [open, setOpen] = useState(false);

  return <>
    <button ref={setTrigger} type="button" className="wb-new ios-press" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <SquarePen size={17} aria-hidden="true" />
      <span>新会话</span>
      {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
    </button>
    <WorkbenchPopover open={open} anchor={trigger} onClose={() => setOpen(false)} label="选择助手" width={300}>
      {OPTIONS.map(option => {
        const disabled = option.provider === 'deepseek' && !deepseekAvailable;
        return <button type="button" role="menuitem" key={option.provider} className="wb-popover-item" aria-disabled={disabled || undefined}
          onClick={() => { if (disabled) return; setOpen(false); onStart(option.provider); }}>
          <WorkbenchProviderMark provider={option.provider} size="menu" />
          <span className="wb-popover-item-text">
            <strong>{option.name}{option.provider === lastProvider && <em className="wb-badge">上次使用</em>}</strong>
            <small>{disabled ? '需先在 Studio 中建立此项目' : option.caption}</small>
          </span>
        </button>;
      })}
    </WorkbenchPopover>
  </>;
}
