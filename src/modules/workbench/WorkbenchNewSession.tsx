import { useState } from 'react';
import { SquarePen } from 'lucide-react';

import type { WorkbenchNewChatChoice, WorkbenchNewProvider } from '@/shared/types';
import { WorkbenchPopover } from '@/modules/workbench/WorkbenchPopover';
import { WorkbenchProviderMark } from '@/modules/workbench/WorkbenchProviderMark';
import { providerMeta } from '@/modules/workbench/utils/workbenchRoutes';

// What each agent runs on, under its name in the menu.
const CAPTIONS: Record<WorkbenchNewProvider, string> = {
  claude: 'Claude 订阅 · 在项目目录运行',
  codex: 'ChatGPT 订阅 · 在项目目录运行',
  cursor: 'Cursor Agent · 在项目目录运行',
  opencode: 'OpenCode · 在项目目录运行',
  deepseek: 'API · 项目对话',
};

/**
 * Used by the workbench sidebar for "+ 新会话": opens a menu of the agents a new chat can start with (Claude Code,
 * Codex and DeepSeek, plus Cursor / OpenCode where the Studio project enables them), marking the one used last.
 * The choices come from the shared new-chat rule, so an agent unavailable here (DeepSeek without a Studio project)
 * is disabled with the same reason the chat header gives.
 */
export function WorkbenchNewSession({ choices, lastProvider, shortcut, onStart }: {
  choices: WorkbenchNewChatChoice[]; lastProvider: WorkbenchNewProvider; shortcut: string | null; onStart: (provider: WorkbenchNewProvider) => void;
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
      {choices.map(({ provider, unavailableReason }) => {
        const disabled = Boolean(unavailableReason);
        return <button type="button" role="menuitem" key={provider} className="wb-popover-item" aria-disabled={disabled || undefined}
          onClick={() => { if (disabled) return; setOpen(false); onStart(provider); }}>
          <WorkbenchProviderMark provider={provider} size={34} />
          <span className="wb-popover-item-text">
            <strong>{providerMeta(provider).name}{provider === lastProvider && <em className="wb-badge">上次使用</em>}</strong>
            <small>{unavailableReason ?? CAPTIONS[provider]}</small>
          </span>
        </button>;
      })}
    </WorkbenchPopover>
  </>;
}
