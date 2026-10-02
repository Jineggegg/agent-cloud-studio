import type { WorkbenchChatProps } from '@/shared/types';

/** Used by the workbench shell (WorkbenchRoute) as its centre column: the conversation with Claude Code, Codex or DeepSeek. Filled in by the v6 "chat" track. */
export function WorkbenchChat({ project }: WorkbenchChatProps) {
  return <div className="workbench-chat-placeholder" role="status">{project.displayName}</div>;
}
