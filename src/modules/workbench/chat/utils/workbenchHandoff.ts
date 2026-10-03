import type { WorkbenchSessionItem, WorkbenchThread, WorkbenchThreadSegment } from '@/shared/types';

// Handoffs between providers, as the chat column and its rows see them. The server builds the `<handoff>` block
// (server/modules/studio/workbench-handoff-summary.service.ts); the first message of the next session is the owner's
// own text followed by that block.

// The block at the end of a seeded first message: `<message>\n\n<handoff>\n…\n</handoff>`.
const HANDOFF_BLOCK = /\n*<handoff>\n?([\s\S]*?)\n?<\/handoff>\s*$/;

/**
 * Splits a message into what the owner wrote and the handoff block it carried (null when there is none), so a
 * seeded first prompt shows as the owner's words with the summary folded beneath. Used by the user rows.
 */
export function splitHandoffContent(content: string): { message: string; summary: string | null } {
  const match = HANDOFF_BLOCK.exec(content);
  if (!match) return { message: content, summary: null };
  return { message: content.slice(0, match.index).trimEnd(), summary: match[1].trim() };
}

/** The first prompt of a session that takes a conversation over: the owner's message, then the handoff block. */
export function appendHandoffContext(message: string, context: string): string {
  return `${message.trimEnd()}\n\n${context}`;
}

/**
 * Where the open session sits in its conversation: the stretches before it (shown above its own transcript) and its
 * own stretch (whose model and time label the last divider). Null when the session is not part of a handoff chain.
 */
export function threadPosition(
  thread: WorkbenchThread | null | undefined,
  session: Pick<WorkbenchSessionItem, 'kind' | 'id'> | null,
): { earlier: WorkbenchThreadSegment[]; current: WorkbenchThreadSegment; later: WorkbenchThreadSegment[] } | null {
  if (!thread || !session) return null;
  const index = thread.segments.findIndex((segment) => segment.kind === session.kind && segment.sessionId === session.id);
  if (index < 0) return null;
  return { earlier: thread.segments.slice(0, index), current: thread.segments[index], later: thread.segments.slice(index + 1) };
}
