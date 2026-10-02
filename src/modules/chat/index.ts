export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';

// The chat engine without ChatInterface's presentation, plus the renderers worth reusing as-is. Consumed by
// the workbench chat column (src/modules/workbench/chat), which draws its own transcript and composer on top.
export { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
export { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
export { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
export { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
export { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
export { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
export { default as LazyMessageRow } from '@/modules/chat/transcript/LazyMessageRow';
export { default as PermissionContext } from '@/modules/chat/context/PermissionContext';
export { MarkdownWorkspaceContext } from '@/modules/chat/context/MarkdownWorkspaceContext';
export { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
export { Markdown } from '@/modules/chat/transcript/Markdown';
export { default as StreamingMarkdown } from '@/modules/chat/transcript/StreamingMarkdown';
export { default as ChatMessageImages } from '@/modules/chat/transcript/ChatMessageImages';
export { ToolRenderer, SubagentPanel, WorkflowPanel } from '@/modules/chat/tools';
export { default as CommandResultModal } from '@/modules/chat/modals/CommandResultModal';
export { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '@/modules/chat/utils/chatPermissions';
export { stripProposedPlanEnvelope } from '@/modules/chat/utils/chatFormatting';
