// The handoff summary: what the next provider is told about a workbench conversation it takes over. It is built
// deterministically from the stored transcript (no model is asked), so it is cheap, repeatable and never invents
// anything: the owner's messages nearly verbatim, the assistant's final answers condensed, files and commands listed.

/** One row of the outgoing conversation, provider-neutral. `summary` is an earlier summary (a compaction, a handoff). */
export type HandoffTranscriptEntry =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'summary'; text: string };

/** The longest summary handed over (the `<handoff>` block adds a short introduction); tests of the builder check it. */
export const MAX_HANDOFF_SUMMARY_CHARS = 7000;

const GOAL_LIMIT = 600;
const LAST_REQUEST_LIMIT = 1200;
const STATE_LIMIT = 1500;
const DECISION_LIMIT = 280;
const MAX_DECISIONS = 8;
const OWNER_MESSAGE_LIMIT = 300;
const EARLIER_SUMMARY_LIMIT = 1500;
const EARLIER_SUMMARY_FLOOR = 300;
const MAX_FILES = 30;
const MAX_COMMANDS = 10;
const COMMAND_LIMIT = 160;
const MAX_QUESTIONS = 5;
const QUESTION_LIMIT = 200;

// The block a handoff appends to the owner's message: `<message>\n\n<handoff>\n…\n</handoff>`.
const HANDOFF_BLOCK = /\n*<handoff>\n?([\s\S]*?)\n?<\/handoff>\s*$/;
// Tools that change files (Claude Code and Codex names), and the ones that run commands.
const FILE_TOOLS = /^(edit|multiedit|write|notebookedit|apply_patch|applypatch|create_file|str_replace_based_edit_tool)$/i;
const COMMAND_TOOLS = /^(bash|shell|exec_command|local_shell|run_command)$/i;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

// The owner's words, whitespace folded so a long message does not eat the budget with blank lines.
function oneLine(text: string, limit: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), limit);
}

// An answer reduced to its prose: code blocks become [代码], Markdown marks are dropped, and lines (headings, list
// items) run on separated by ；unless they already end in punctuation.
function condense(text: string, limit: number): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .trim()
    .replace(/([^。！？；：，.!?;:,\s])[ \t]*\n\s*/g, '$1；')
    .replace(/\s+/g, ' ');
  return clip(plain, limit);
}

/**
 * Splits a first prompt the workbench seeded with a handoff into the owner's own message and the summary it carried.
 * Used by the summary builder below: a conversation handed over twice keeps the earlier summary.
 */
function splitHandoffMessage(text: string): { message: string; handoff: string | null } {
  const match = HANDOFF_BLOCK.exec(text);
  if (!match) return { message: text, handoff: null };
  return { message: text.slice(0, match.index).trim(), handoff: match[1].trim() };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// The files a tool call changed: its path fields, or the files an apply_patch body names.
function filesOf(input: unknown): string[] {
  const fields = record(input);
  const direct = [fields.file_path, fields.notebook_path, fields.path, fields.filePath].filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  const patch = typeof input === 'string' ? input : typeof fields.patch === 'string' ? fields.patch : typeof fields.input === 'string' ? fields.input : '';
  const patched = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1].trim());
  return [...direct, ...patched];
}

function commandOf(input: unknown): string | null {
  const fields = record(input);
  const command = Array.isArray(fields.command) ? fields.command.filter(part => typeof part === 'string').join(' ') : fields.command ?? fields.cmd;
  return typeof command === 'string' && command.trim() ? oneLine(command, COMMAND_LIMIT) : null;
}

// Sentences of the last answer that ask the owner something.
function questionsOf(text: string): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, ' ');
  return plain
    .split(/(?<=[。！？?!；])|\n+/)
    .map(sentence => sentence.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim())
    .filter(sentence => /[？?]$/.test(sentence) && sentence.length > 3)
    .slice(-MAX_QUESTIONS)
    .map(sentence => oneLine(sentence, QUESTION_LIMIT));
}

type Turn = { user: string; finalAnswer: string | null };

/**
 * Builds the handoff summary of one conversation (at most MAX_HANDOFF_SUMMARY_CHARS): the goal (the first message),
 * the last request, the current state (the last answer), earlier conclusions, the files changed and commands run,
 * open questions, everything the owner said (oldest dropped first when over budget) and any earlier summary.
 * Used by the workbench threads service when the owner hands a conversation to another provider.
 */
export function buildHandoffSummary({ sourceLabel, entries }: { sourceLabel: string; entries: HandoffTranscriptEntry[] }): string {
  const turns: Turn[] = [];
  const earlier: string[] = [];
  const files = new Map<string, number>();
  const commands: string[] = [];
  for (const entry of entries) {
    if (entry.type === 'user') {
      const { message, handoff } = splitHandoffMessage(entry.text);
      if (handoff) earlier.push(handoff);
      if (message.trim()) turns.push({ user: message, finalAnswer: null });
    } else if (entry.type === 'assistant') {
      if (!entry.text.trim()) continue;
      if (!turns.length) turns.push({ user: '', finalAnswer: null });
      turns[turns.length - 1].finalAnswer = entry.text;
    } else if (entry.type === 'summary') {
      if (entry.text.trim()) earlier.push(entry.text);
    } else if (FILE_TOOLS.test(entry.name)) {
      for (const file of filesOf(entry.input)) files.set(file, (files.get(file) ?? 0) + 1);
    } else if (COMMAND_TOOLS.test(entry.name)) {
      const command = commandOf(entry.input);
      if (command) commands.push(command);
    }
  }

  const ownerMessages = turns.map(turn => turn.user).filter(text => text.trim());
  const goal = ownerMessages[0] ?? '';
  const lastRequest = ownerMessages[ownerMessages.length - 1] ?? '';
  const answered = turns.filter(turn => turn.finalAnswer);
  const lastAnswer = answered[answered.length - 1]?.finalAnswer ?? null;
  // Conclusions are the turns' final answers before the last one, which is the current state.
  const conclusions = answered.slice(0, -1).map(turn => condense(turn.finalAnswer ?? '', DECISION_LIMIT));
  const questions = lastAnswer ? questionsOf(lastAnswer) : [];
  const fileList = [...files.entries()];
  const earlierText = earlier.join('\n\n');

  const render = (ownerKeep: number, conclusionKeep: number, earlierLimit: number) => {
    const sections = [`（${sourceLabel} 这段对话的交接摘要，共 ${ownerMessages.length} 条主人消息）`];
    sections.push(`## 目标\n${goal ? oneLine(goal, GOAL_LIMIT) : '（主人还没有说明）'}`);
    if (ownerMessages.length > 1) sections.push(`## 主人最后的请求\n${oneLine(lastRequest, LAST_REQUEST_LIMIT)}`);
    sections.push(`## 当前状态（${sourceLabel} 最后的回答）\n${lastAnswer ? condense(lastAnswer, STATE_LIMIT) : '（还没有回答）'}`);
    const shownConclusions = conclusionKeep > 0 ? conclusions.slice(-conclusionKeep) : [];
    if (shownConclusions.length) {
      const skipped = conclusions.length - shownConclusions.length;
      sections.push(`## 之前的结论与决定\n${skipped ? `（更早的 ${skipped} 条已省略）\n` : ''}${shownConclusions.map(text => `- ${text}`).join('\n')}`);
    }
    if (fileList.length) {
      const shown = fileList.slice(-MAX_FILES).map(([file, times]) => `- ${file}${times > 1 ? `（${times} 次）` : ''}`);
      sections.push(`## 改动过的文件\n${fileList.length > MAX_FILES ? `（另有 ${fileList.length - MAX_FILES} 个更早的）\n` : ''}${shown.join('\n')}`);
    }
    if (commands.length) {
      sections.push(`## 运行过的命令（最近 ${Math.min(commands.length, MAX_COMMANDS)} 条）\n${commands.slice(-MAX_COMMANDS).map(command => `- ${command}`).join('\n')}`);
    }
    if (questions.length) sections.push(`## 待确认的问题\n${questions.map(question => `- ${question}`).join('\n')}`);
    if (ownerMessages.length && ownerKeep > 0) {
      const shown = ownerMessages.slice(-ownerKeep);
      const offset = ownerMessages.length - shown.length;
      sections.push(`## 主人说过的话（按时间）\n${offset ? `（更早的 ${offset} 条已省略）\n` : ''}${shown.map((text, index) => `${offset + index + 1}. ${oneLine(text, OWNER_MESSAGE_LIMIT)}`).join('\n')}`);
    }
    if (earlierText) sections.push(`## 更早的摘要\n${clip(earlierText.trim(), earlierLimit)}`);
    return sections.join('\n\n');
  };

  // Over budget, the oldest owner messages go first, then the oldest conclusions, then most of the earlier summary.
  let ownerKeep = ownerMessages.length;
  let conclusionKeep = Math.min(MAX_DECISIONS, conclusions.length);
  let earlierLimit = EARLIER_SUMMARY_LIMIT;
  for (;;) {
    const text = render(ownerKeep, conclusionKeep, earlierLimit);
    if (text.length <= MAX_HANDOFF_SUMMARY_CHARS) return text;
    if (ownerKeep > 0) ownerKeep -= 1;
    else if (conclusionKeep > 0) conclusionKeep -= 1;
    else if (earlierLimit > EARLIER_SUMMARY_FLOOR) earlierLimit = EARLIER_SUMMARY_FLOOR;
    else return clip(text, MAX_HANDOFF_SUMMARY_CHARS);
  }
}

/**
 * The `<handoff>` block appended to the owner's next message as the new session's first prompt: who ran the
 * conversation, who continues it, how to treat the summary, then the summary itself. Used by the workbench threads
 * service; splitHandoffMessage reads it back.
 */
export function formatHandoffContext({ fromLabel, fromModelLabel, toLabel, toDeepSeek, summary }: {
  fromLabel: string; fromModelLabel: string | null; toLabel: string; toDeepSeek: boolean; summary: string;
}): string {
  // A latin name is set off by a space; a closing full-width bracket needs none.
  const from = fromModelLabel ? `${fromLabel}（${fromModelLabel}）` : `${fromLabel} `;
  const advice = toDeepSeek
    ? '你看不到项目文件，只能根据摘要和主人的话回答。'
    : '摘要只是背景，动手前请自己查看项目文件和 git 状态确认现状。';
  return `<handoff>\n这段对话之前由 ${from}进行，现在交给你（${toLabel}）接着做。下面是之前对话的整理摘要；以上面主人的新消息为准，${advice}\n\n${summary}\n</handoff>`;
}
