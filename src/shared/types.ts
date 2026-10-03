import type { TFunction } from 'i18next';
import type { CSSProperties, ReactNode } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

//----------------- LLM PROVIDER MODEL CATALOG ------------

/** Identifies which coding-agent CLI backs a session, project selection or model list. */
export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode';

/** One selectable model in a provider's model menu, including its optional reasoning-effort choices. */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  recordId?: number;
  isCustom?: boolean;
  /** Earlier catalog values (`opus`, `default`, ...) that now mean this option; saved choices resolve through them. */
  aliases?: string[];
  /** Model id that runs this option with the 1M-token context window, offered as a toggle; absent when unsupported. */
  longContextValue?: string;
  /** The provider's recommended pick, labelled 推荐 in the model menus. */
  recommended?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

/** The full model catalog for one provider: every option plus the value used when the user has not chosen one. */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/**
 * A stored or requested model value matched by `resolveModelChoice` (shared/utils) to the catalog row it selects:
 * the row, the concrete id to run (`value`), and whether that id is the row's 1M-context variant. Lets legacy
 * values such as `opus[1m]` or `default` show and run as today's rows. Used by the chat provider state, the
 * model defaults, Studio's model settings and the chat and workbench model menus.
 */
export type ResolvedModelChoice = {
  option: ProviderModelOption;
  value: string;
  longContext: boolean;
};

/** User-supplied fields for creating or editing a custom provider model entry. */
export type CustomProviderModelInput = {
  model: string;
  id: string;
};

/** Mutation callbacks a model menu calls to persist custom provider models. */
export type ProviderModelActions = {
  create(provider: LLMProvider, input: CustomProviderModelInput): Promise<void>;
  update(
    provider: LLMProvider,
    existing: ProviderModelOption,
    input: CustomProviderModelInput,
  ): Promise<void>;
  remove(provider: LLMProvider, existing: ProviderModelOption): Promise<void>;
};

// ---------------------------

//----------------- PROJECTS AND SESSIONS ------------

/** Identifies the workspace pane the user is looking at; plugin panes are namespaced by plugin id. */
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'browser' | `plugin:${string}`;

/** A message queued to be sent to a session at a future time. */
export type ScheduledMessage = {
  id: string;
  sessionId: string;
  content: string;
  options: Record<string, unknown>;
  /** ISO instant, so the schedule does not move when the user changes time zone. */
  scheduledFor: string;
  status: 'pending' | 'claimed' | 'sent' | 'failed' | 'cancelled';
  /** Why it did not go, when `status` is `failed`. */
  failureReason: string | null;
  createdAt: string;
};

/** A single conversation inside a project, as returned by the sessions API and rendered in the sidebar and chat. */
export type ProjectSession = {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
};

/** Pagination metadata returned alongside a project's session page. */
type ProjectSessionMeta = {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
};

/** Task Master provisioning state for a project, used to decide whether the tasks tab is available. */
type ProjectTaskmasterInfo = {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
/** A workspace project as the UI knows it: identity, path, star state and its loaded sessions. */
export type Project = {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  [key: string]: unknown;
};

/** Progress payload streamed while the backend enumerates projects, used to drive the sidebar loading bar. */
export type LoadingProgress = {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
};

// ---------------------------

//----------------- SESSION PROCESSING STATE ------------

/**
 * One background task — a spawned agent, a workflow run or a backgrounded
 * command — that a session still has running after its turn ended. Listed by
 * the running-sessions poll and derived from the transcript between polls;
 * `taskId` is what `chat.stop-task` addresses.
 */
export type BackgroundTaskSummary = {
  taskId: string;
  toolUseId: string;
  /** The SDK's kind: `local_agent`, `local_workflow` or `local_bash`. */
  taskType: string;
  description: string;
  workflowName?: string;
  /** When the task started (epoch ms). The activity indicator counts from the earliest. */
  startedAt: number;
  /**
   * The task was launched by a subagent or workflow agent, not by the
   * session's own turn: its `toolUseId` names a call in that agent's
   * transcript, so no card in this session's transcript matches it. Listed so
   * it can still be stopped; not counted as the session's own work.
   */
  nested?: boolean;
};

/** What a busy session is doing, as shown by the activity indicator: producing a response, or only running background tasks. */
export type SessionActivity = {
  /** Provider-supplied status line; null renders the default activity label. */
  statusText: string | null;
  canInterrupt: boolean;
  /**
   * When this request was first marked as processing (client clock). Drives
   * the elapsed-time display and the stale `chat_subscribed` idle-ack guard.
   * For background-only work it is the earliest task's start.
   */
  startedAt: number;
  /**
   * Set when no response is being produced and only background tasks keep
   * the session busy. The composer stays usable: the CLI accepts a new turn
   * while they run.
   */
  background?: boolean;
  /** The background tasks the session still has running, with or without a response in flight. */
  tasks?: BackgroundTaskSummary[];
};

/** Every busy session, keyed by session id. Read it to tell whether a session is busy; check `background` to tell how. */
export type SessionActivityMap = ReadonlyMap<string, SessionActivity>;

/** Marks a session as producing a response; call it as soon as a send is dispatched so the UI reacts immediately. */
export type MarkSessionProcessing = (
  sessionId?: string | null,
  activity?: { statusText?: string | null; canInterrupt?: boolean },
) => void;

/** Marks a session's response as finished; `ifStartedBefore` lets a late acknowledgement clear only a stale run. Leaves background-only work alone, which it says nothing about. */
export type MarkSessionIdle = (
  sessionId?: string | null,
  opts?: { ifStartedBefore?: number },
) => void;

/** Records the background tasks a session still has once its turn ended; an empty list marks it idle. */
export type MarkSessionBackground = (
  sessionId: string,
  tasks: BackgroundTaskSummary[],
) => void;

/** Reads one session's current activity without subscribing to the map, for logic that runs on a websocket frame. */
export type GetSessionActivity = (sessionId: string) => SessionActivity | undefined;

/** Replaces the whole processing map with the server's view, used by the periodic running-sessions poll. */
export type SyncProcessingSessions = (
  sessions: readonly SessionActivitySnapshot[],
) => void;

/** Reports whether one session is currently producing a response; false for one that only has background tasks running. */
export type IsSessionProcessing = (sessionId?: string | null) => boolean;

/** One running session as reported by the server, before it is folded into the client-side activity map. */
export type SessionActivitySnapshot = {
  sessionId: string;
  statusText?: string | null;
  canInterrupt?: boolean;
  startedAt?: number;
  /** True when the server lists the session for its background tasks alone, with no chat run. */
  background?: boolean;
  tasks?: BackgroundTaskSummary[];
};

// ---------------------------

//----------------- REALTIME TRANSPORT ------------

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

//----------------- TASK RECOVERY AND DELIVERY ------------

/** Durable interrupted execution shown only within its project and conversation. */
export type TaskRecoveryRun = {
  runId: string;
  requestId: string;
  sessionId: string | null;
  projectPath: string;
  provider: LLMProvider;
  state: string;
  content: string;
  startedAt: string;
  interruptedAt?: string | null;
};

/** Delivery feedback stays separate from execution progress until the server acknowledges the request. */
export type ChatDeliveryState = {
  requestId: string;
  state: 'sending' | 'unknown' | 'failed';
  error?: string;
  errorCode?: string;
};

/** Exact send snapshot retained across reconnect and page reload; retries reuse its request id and payload. */
export type PendingChatDelivery = {
  requestId: string;
  scope: string;
  sessionId: string;
  payload: Record<string, unknown>;
  content: string;
  attachments: ChatAttachment[];
  inputRevision: number;
  attachmentRevision: number;
  editingAnchorId: string | null;
  recoveryOfRunId?: string;
  createdSession: boolean;
  project: Project;
  provider: LLMProvider;
  summary: string | null;
  /** Original send instant keeps delayed receipts from manufacturing a second transcript turn. */
  submittedAt?: string;
};


// ---------------------------

//----------------- SHARED UI PRIMITIVES ------------

/** Progress state of a single queue row, driving the indicator the Queue primitive renders. */
export type QueueItemStatus = 'completed' | 'in_progress' | 'pending';

// ---------------------------

//----------------- AUTH ------------


// ---------------------------

//----------------- CHAT MESSAGES AND PERMISSIONS ------------

/** Permission preset a provider runs a turn under ('default', 'acceptEdits', 'auto', 'bypassPermissions' or 'plan'), chosen in the composer and sent with each message; the backend capability matrix decides which values a given provider accepts. */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

/** A non-image file attached to a chat message, described by its path in the server-managed attachment store plus display metadata so it can be listed and downloaded. */
export type ChatAttachment = {
  /** Absolute path inside the server-managed chat attachment store. */
  path?: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

/** A chat attachment that is an image, extending ChatAttachment with the inline base64 data URL that Claude history uses when no stored path is available. */
export type ChatImage = {
  /** Inline data URL (Claude history stores image attachments as base64). */
  data?: string;
} & ChatAttachment;

/** One stored memory an assistant reply drew on, naming the file and line range read plus what was taken from it, shown as a footnote under the reply so a memory-derived claim stays traceable. */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/** One entry in a subagent's recorded timeline, normalized by the backend from either provider's transcript; `kind` decides whether the tool fields or `content` carry the entry, so read only the set that matches. */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  content?: string;
};

/** Identity and lifecycle of one spawned subagent as the backend reports it; present on the tool call that spawned the agent and used to draw its container header. */
/**
 * A compaction, as the transcript records it.
 *
 * `running` is the status the CLI sends when it starts compacting, `done` the
 * boundary it sends when it has, `failed` a compaction that did not finish.
 * The token counts and duration only come with a boundary.
 */
export type CompactionInfo = {
  phase: 'running' | 'done' | 'failed';
  trigger?: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
};

/** Where a background task — a spawned agent, a workflow run or a backgrounded command — stands: `stopped` is one whose session process ended before it reported, so no outcome exists and none is coming. */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type SubagentInfo = {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  /** `stopped` is a background agent whose session process ended before it reported: no outcome exists and none is coming. */
  status: BackgroundTaskStatus;
  model?: string;
  /** Total entries the agent recorded, which exceeds the received timeline when a long run was truncated for transport. */
  activityCount?: number;
};

/** One rendered entry in a chat transcript — user turn, assistant turn, tool call and result, local command output, or subagent container — and the shape the chat message list and message components consume. */
export type ChatMessage = {
  type: string;
  content?: string;
  displayText?: string;
  timestamp: string | number | Date;
  images?: ChatImage[];
  files?: ChatAttachment[];
  reasoning?: string;
  /**
   * The provider's identifier for the transcript row behind this message, when
   * the provider has stable per-row identity. Present on user turns from
   * Claude; it is the anchor "edit this message" and "fork from here" send back.
   */
  transcriptAnchorId?: string;
  /**
   * Set on the optimistic echo of a message being sent as a replacement for an
   * already-sent one, naming the anchor it replaces. Local to this client.
   */
  replacesAnchorId?: string;
  /**
   * The model that produced this assistant turn, as the provider reported it
   * on the transcript row. Absent on user turns and on rows the provider
   * fabricated locally, so the footer shows nothing rather than guessing.
   */
  model?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set on the row that stands in for a compaction, so it is drawn as one. */
  compact?: CompactionInfo;
  /** The summary that compaction produced, folded into the row above rather than left loose. */
  compactSummary?: string;
  isSubagentContainer?: boolean;
  /** The agent this row spawned, when it spawned one. Its presence is what makes a row a subagent container. */
  subagent?: SubagentInfo;
  /** What that agent did, in order. Empty while the agent is still starting up. */
  subagentActivity?: SubagentActivity[];
  /** The workflow run this row launched, as the backend read it on the last history load. */
  workflow?: WorkflowInfo;
  /** The latest live word on the background task this row launched, while the run is in flight. */
  taskStatus?: LiveTaskStatus;
  /** Set on the row that stands for a background task's completion report, with the status it reported. */
  isTaskNotification?: boolean;
  taskNotificationStatus?: string;
  /** Stored memory this reply drew on, shown as a footnote beneath it. */
  memoryCitations?: MemoryCitation[];
  /** Lifecycle the provider reported for this tool call, when it reports one; otherwise the status is inferred from whether a result has arrived. */
  toolStatus?: string;
  [key: string]: unknown;
};

/** The user's locally persisted Claude preferences (allowed and disallowed tool lists, permission skipping and project sort order) read from and written back to browser storage. */
export type ClaudeSettings = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
};

/** A proposed Claude tool-permission rule derived from a denied tool call, offered to the user so that tool can be added to the stored allow list in one click. */
export type ClaudePermissionSuggestion = {
  toolName: string;
  entry: string;
  isAllowed: boolean;
};

/** Outcome of writing a tool-permission rule into the stored Claude settings, reporting whether it succeeded, whether the rule was already allowed, and the resulting settings. */
export type PermissionGrantResult = {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
};

/** A tool-permission request awaiting the user's decision, identified by its requestId and carrying the tool name, input and context needed to render the prompt and reply to the backend. */
export type PendingPermissionRequest = {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
};

/** One question asked by the AskUserQuestion tool, with its answer options and whether more than one option may be selected. */
export type Question = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

/** Options for a programmatic session navigation, currently only whether the route change should replace the current history entry instead of pushing a new one. */
export type SessionNavigationOptions = {
  replace?: boolean;
};

/** Context handed to the workspace when a chat run creates a session, naming the provider that created it, the owning project and the session summary, so the session can be selected and labelled. */
export type SessionEstablishedContext = {
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

/** The result returned for a tool call, carrying its content, error flag, timestamp and any provider-specific extras that the tool renderers read. */
export type ToolResult = {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
};

/** One selectable answer for a Question, with the label shown to the user and an optional explanatory description. */
type QuestionOption = {
  label: string;
  description?: string;
};

// ---------------------------

//----------------- CHAT SESSION STORE ------------

/** A provider-agnostic transcript event as normalized by the backend adapters, with all kind-specific fields kept flat; it is the shape the session store holds and that chat converts into ChatMessage for rendering, so treat it as the wire contract rather than a view model. */
export type NormalizedMessage = {
  id: string;
  /**
   * The provider's own id for the transcript row behind this message, when the
   * provider has stable per-row identity (today: Claude). Sent back as the
   * anchor for "edit this message" and "fork from here".
   */
  transcriptAnchorId?: string;
  /**
   * Set only on the client-side optimistic echo of an edited message, naming
   * the anchor that echo replaces. Never sent by the backend.
   *
   * The truncation that follows an edit clears every live row, because they
   * belonged to the turn being replaced. This tag is what tells the store the
   * replacement itself is not one of them.
   */
  replacesAnchorId?: string;
  /**
   * How many persisted rows survived the cut this echo was sent for, stamped
   * when the truncation is applied.
   *
   * The echo is retired once the provider persists it, and that is decided by
   * matching text and attachments inside a time window. That is enough until a
   * rewind re-stamps the surviving turns — a provider that has to branch
   * writes the copy with the timestamps of the copy — because an earlier turn
   * with the same words then sits inside the window and retires the message
   * the user just sent. The replacement can only be a row that was not there
   * when the cut was made, so this is where those rows begin.
   */
  replacesAfterRowCount?: number;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * The model that answered this turn, as the backend read it off the
   * provider's own record of the row (today: Claude's `message.model`). Never
   * set on a user turn — no provider records which model a request went out
   * with — and never a placeholder the provider synthesized.
   */
  model?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set by the provider on the row that stands in for a compaction. */
  compact?: CompactionInfo;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  files?: Array<{ path?: string; name?: string; mimeType?: string; size?: number }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  /** A `tool_result` row's structured output — a launch acknowledgement's task id and metadata, a search's file list. */
  toolUseResult?: unknown;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  /** Timeline of a spawned subagent's work, attached by the backend to the tool call that spawned it. */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of that subagent. */
  subagent?: SubagentInfo;
  /** The workflow run a `Workflow` call launched, attached by the backend from the run's journal. */
  workflow?: WorkflowInfo;
  /** Stored memory this reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  /**
   * `task_status` fields: one live lifecycle event of a background task.
   * `toolUseId` names the call that launched it and is absent on `updated`,
   * which is keyed by `taskId` alone; `status` and `summary` above carry the
   * event's own.
   */
  event?: 'started' | 'progress' | 'updated' | 'notification';
  taskId?: string;
  toolUseId?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  usage?: TaskUsage;
  outputFile?: string;
  /** A workflow's `progress` only: where each agent the run spawned stands. */
  agents?: WorkflowAgentProgress[];
};

/** What a background task has spent so far — tokens, tool calls and wall time — as the CLI reports it while the task runs and when it ends. */
export type TaskUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

/** One agent a workflow run spawned, as its journal records it: the label and phase the script gave it (older scripts gave neither) and whether it has finished. */
export type WorkflowAgentInfo = {
  id: string;
  label?: string;
  phase?: string;
  /** `stopped` is an agent the journal never settled although the run itself has — abandoned by a stop or a resume that re-ran the step. */
  status: 'running' | 'completed' | 'failed' | 'stopped';
};

/** A `Workflow` call's run as the backend read it from disk; `stopped` is a run whose session process ended before it reported, and an empty agent list is a run that left no journal behind. */
export type WorkflowInfo = {
  runId: string;
  name: string;
  description?: string;
  status: BackgroundTaskStatus;
  agents: WorkflowAgentInfo[];
  agentCounts: { total: number; completed: number; failed: number; running: number; stopped: number };
  scriptPath?: string;
};

/**
 * The latest live word on a background task, folded from the session's
 * `task_status` events onto the tool call that launched it. It is what a card
 * reads while the run is in flight; on a history reload the backend's
 * `subagent` or `workflow` carries the settled outcome instead.
 */
export type LiveTaskStatus = {
  status: BackgroundTaskStatus;
  /** The id the events name the task by, which is what stopping it addresses. */
  taskId?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  summary?: string;
  usage?: TaskUsage;
  /** A workflow's only: where each agent the run spawned stands, from its latest progress event. */
  agents?: WorkflowAgentProgress[];
};

/**
 * Where one agent of a running workflow stands, as the SDK reports it on the
 * run's progress events. An entry with no `agentId` is a slot the script has
 * queued but not yet started, identified by `index` alone; `lastToolName` and
 * `lastToolSummary` are the agent's own latest tool call.
 */
export type WorkflowAgentProgress = {
  index: number;
  label?: string;
  /** The title of the script phase the agent runs under, when it has one. */
  phase?: string;
  agentId?: string;
  model?: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  startedAt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  resultPreview?: string;
};

/** Discriminator on NormalizedMessage naming which kind of transcript event it carries — plain text, tool use or result, thinking, stream delta or end, error, completion, status, permission request/resolution/cancellation, session creation, interactive prompt, or task notification. */
type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_resolved'
  | 'permission_cancelled'
  | 'session_created'
  | 'history_truncated'
  | 'task_notification'
  | 'task_status';

// ---------------------------

//----------------- CHAT COMPOSER ------------

/** Result payload of the chat `/model` slash command, describing the session's current provider and model plus the model catalog it may switch to, used to populate the command modal's model picker. */
export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: ProviderModelOption[];
  defaultModel?: string;
};

/** Result payload of the chat `/cost` slash command, carrying the session's token usage totals and input/output breakdown for the command modal's usage view. */
export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

/** Result payload of the chat `/status` slash command, carrying server version, uptime, provider/model and process telemetry for the command modal's status view. */
export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

/** Result payload of the chat `/help` slash command, carrying either pre-rendered help content or the list of available commands for the command modal's help view. */
export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

/** Wrapper pairing a CommandModalKind with its matching command result data; pass it as the single payload prop that tells the chat command modal which slash-command result to render, or null to close it. */
export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

/** A composer message queued while its session is still busy, holding the text, the in-memory and already-uploaded attachments and the send options snapshotted at queue time so it can be auto-sent unchanged once the session goes idle. */
export type QueuedDraft = {
  content: string;
  /** Browser files retained while this composer stays mounted, for editing. */
  attachments: File[];
  /** JSON-safe descriptors uploaded when the message is queued. */
  uploadedAttachments?: unknown[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

/**
 * Where a popover menu sits, computed from its trigger by `placeAnchoredMenu` (shared/utils) for a
 * `position: fixed` panel: below the trigger (`top`) or above it (`bottom`), whichever side has room, clamped
 * inside the visible viewport. `transformOrigin` points at the trigger so a grow-in animation starts from it.
 * Used by the chat composer's popovers and the workbench chat menus.
 */
export type AnchoredMenuPlacement = {
  side: 'above' | 'below';
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
  transformOrigin: string;
};

/** One selectable slash command — built-in, user-defined or skill-backed — as listed in the chat composer's command menu and executed when the user picks it. */
export type SlashCommand = {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: 'built-in' | 'custom' | 'skill' | string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Discriminator naming which slash-command result the chat command modal is showing: 'help', 'models', 'cost' or 'status'. */
type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

// ---------------------------

//----------------- CHAT VOICE ------------

/** Lifecycle state of the composer's push-to-talk microphone: 'idle', 'recording' or 'transcribing'. */
export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

/** Immutable snapshot of the app-level text-to-speech player for one utterance — its play state plus any error message — read by components so read-aloud state survives re-renders and chat switches. */
export type VoiceSnapshot = { state: VoicePlayState; error: string | null };

/** Playback state of a text-to-speech utterance: 'idle', 'loading' or 'playing'. */
export type VoicePlayState = 'idle' | 'loading' | 'playing';

// ---------------------------

//----------------- CHAT STORAGE ------------

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

// ---------------------------

//----------------- CHAT MESSAGE RENDERING ------------

/** Function that turns an old/new string pair into rendered diff lines; the chat session state supplies one memoized, caching instance so each file diff is computed only once. */
export type DiffCalculator = (oldStr: string, newStr: string) => DiffLine[];

/** A synthetic transcript entry standing for a run of consecutive calls to the same tool, produced by the message grouping pass and identified by its `_isGroup` flag so the message list can collapse the run into one expandable block. */
export type ToolGroupItem = {
  _isGroup: true;
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
  /**
   * Summary line for the collapsed group, built while grouping so the tool-input
   * JSON parsing it needs never runs during render.
   */
  preview: string;
};

/** One line of a rendered file diff, marked 'added' or 'removed', with its text and line number. */
export type DiffLine = {
  type: 'added' | 'removed';
  content: string;
  lineNum: number;
};

/** How many lines one file edit added and removed, for the `+12 -3` badge on a diff's header. */
export type DiffStats = {
  added: number;
  removed: number;
};

// ---------------------------

//----------------- CHAT TOOL RENDERING ------------

/** One entry of an agent todo list as produced by the TodoWrite/TodoRead tools, rendered as a single status row in the tool todo-list view. */
export type TodoItem = {
  id?: string;
  content: string;
  status: string;
  priority?: string;
  activeForm?: string;
};

/** Display state of a tool call — 'running', 'completed', 'error' or 'denied' — used to choose the status badge and styling shown beside it in the transcript. */
export type ToolStatus = 'running' | 'completed' | 'error' | 'denied';

/** Props contract that every interactive permission panel implements, giving the panel the pending request and the callback it calls to allow or deny that request; use it when registering a panel in the permission panel registry. */
export type PermissionPanelProps = {
  request: PendingPermissionRequest;
  onDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; updatedInput?: unknown },
  ) => void;
};

// ---------------------------

//----------------- CODE EDITOR ------------

/** The before/after strings of a pending edit attached to a file opened in the code editor, used to drive the editor's inline merge/diff view; extra keys are tolerated because it comes straight from tool payloads. */
export type CodeEditorDiffInfo = {
  old_string?: string;
  new_string?: string;
  [key: string]: unknown;
};

/** A file handed to the code editor for viewing or editing, carrying its display name, workspace-relative path, owning DB projectId for read/save requests and any diff to highlight. */
export type CodeEditorFile = {
  name: string;
  path: string;
  // DB projectId; used by the editor to build `/api/file-tree/projects/:projectId/file`
  // URLs for reading and saving content.
  projectId?: string;
  diffInfo?: CodeEditorDiffInfo | null;
  // 1-based line to reveal when the file opens (from a `path:line` reference).
  line?: number | null;
  [key: string]: unknown;
};

/** One request to reveal a line in the editor. The code editor builds a new object per opened file so the surface can tell a fresh request apart from a re-render, and jump only once per request. */
export type CodeEditorGotoTarget = {
  // 1-based, clamped to the document by the editor surface.
  line: number;
};

/** The category of browser-renderable media a file maps to, used by the code editor to decide whether to show an inline image, PDF, video or audio preview instead of a text buffer. */
export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio';

// ---------------------------

//----------------- FILE TREE ------------

/** Progress, completion or failure state of one in-flight file-tree upload, produced by the upload hook and rendered by the file tree's progress banner. */
export type FileTreeUploadProgressState = {
  status: 'uploading' | 'complete' | 'error';
  progress: number;
  fileCount: number;
  uploadedCount?: number;
  fileName?: string;
  targetPath?: string;
  error?: string;
};

/** Which density the file tree renders its rows at (simple, compact or detailed), chosen in the file tree header and persisted in local storage. */
export type FileTreeViewMode = 'simple' | 'compact' | 'detailed';

/** One request to reveal a directory in the file tree, coming from a `path/` reference in a chat message. The workspace builds a new object per click so the tree re-reveals a folder the user collapsed again in the meantime. */
export type DirectoryRevealRequest = {
  // As written in the message: relative to the project root, or absolute.
  path: string;
};

/** One file or directory entry in a project's file listing, with directories carrying their loaded `children`; used across the file tree for rendering, searching and filtering. */
export type FileTreeNode = {
  name: string;
  type: FileTreeItemType;
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileTreeNode[];
  [key: string]: unknown;
};

/** The image the file tree asked to preview, carrying the path plus the DB `projectId` the image viewer needs to build its raw content URL. */
export type FileTreeImageSelection = {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by ImageViewer to build the raw content URL.
  projectId: string;
};


/** Whether a file tree entry is a file or a directory; use it instead of repeating the string union wherever `FileTreeNode`-shaped data is handled. */
type FileTreeItemType = 'file' | 'directory';

// ---------------------------

//----------------- GIT PANEL ------------

/** The old/new text of a single edit, handed to the code editor so it can open a file focused on that change. */
type FileDiffInfo = {
  old_string: string;
  new_string: string;
};

/** Callback the git panel calls to open a file in the code editor, optionally focused on one edit. */
export type FileOpenHandler = (filePath: string, diffInfo?: FileDiffInfo) => void;


/** Which tab the git panel is showing (changes, compare, history, branches or worktrees), driving both the tab bar and which data its controller loads. */
export type GitPanelView = 'changes' | 'compare' | 'history' | 'branches' | 'worktrees';

/** Single-letter git status of a changed file (M, A, D, R or U), used to pick its label and badge styling; the Changes tab groups only M/A/D/U, while R (renamed) appears in the Compare tab. */
export type FileStatusCode = 'M' | 'A' | 'D' | 'R' | 'U';

/** The git action a confirmation dialog is guarding, selecting that dialog's title, action label and colour scheme. */
export type ConfirmActionType = 'discard' | 'delete' | 'commit' | 'pull' | 'push' | 'publish' | 'revertLocalCommit' | 'deleteBranch';

/** Payload of the git status endpoint: the current branch plus working-tree paths grouped by status, or the error and `notGitRepository` fields when the project has no usable repository. */
export type GitStatusResponse = {
  branch?: string;
  hasCommits?: boolean;
  modified?: string[];
  added?: string[];
  deleted?: string[];
  untracked?: string[];
  /** Paths with index-side changes — mirrors the real git index. */
  staged?: string[];
  error?: string;
  details?: string;
  /** True when the project directory is not a git repository — the UI offers `git init`. */
  notGitRepository?: boolean;
};

/** Upstream state of the current branch (remote name, ahead/behind counts, up-to-date flag) that the git panel header and branches view use to enable fetch, pull, push and publish. */
export type GitRemoteStatus = {
  hasRemote?: boolean;
  hasUpstream?: boolean;
  branch?: string;
  remoteBranch?: string;
  remoteName?: string | null;
  ahead?: number;
  behind?: number;
  isUpToDate?: boolean;
  message?: string;
  error?: string;
};

/** One commit in the history list, including the parent hashes and ref decorations the commit graph needs to lay out lanes. */
export type GitCommitSummary = {
  hash: string;
  author: string;
  email?: string;
  date: string;
  message: string;
  stats?: string;
  /** Parent commit hashes — drives the History view commit graph. */
  parents?: string[];
  /** Ref decorations, e.g. "HEAD -> main", "origin/main", "tag: v1.0". */
  refs?: string[];
};

/** Unified diff text keyed by file path, used both for working-tree diffs and for the per-file diffs of an expanded commit. */
export type GitDiffMap = Record<string, string>;

/** A pending confirmation dialog — its message, confirm handler and optional escalated alternative — raised by git panel actions and rendered by the shared Confirmation UI. */
export type ConfirmationRequest = {
  type: ConfirmActionType;
  message: string;
  onConfirm: () => Promise<void> | void;
  alternateConfirmation?: {
    label: string;
    description: string;
    actionLabel: string;
    onConfirm: () => Promise<void> | void;
  };
};

/** The `error` and `details` fields any git API response may carry; intersect it with a route's own payload type instead of redeclaring them. */
export type GitApiErrorResponse = {
  error?: string;
  details?: string;
};

/** Response of a git write endpoint such as commit, pull, push or revert: the shared error fields plus `success` and the raw git `output`. */
export type GitOperationResponse = GitApiErrorResponse & {
  success?: boolean;
  output?: string;
};

/** Response of the single-file diff endpoints (`/diff`, `/branch-diff/file`): the shared error fields plus the unified `diff` text with its headers stripped. */
export type GitFileDiffResponse = GitApiErrorResponse & {
  diff?: string;
};

/** One file the working copy changed relative to the compare base's merge base, as listed by the branch-diff endpoint; `oldPath` is only set for renames. */
export type GitBranchDiffFile = {
  path: string;
  oldPath?: string;
  status: FileStatusCode;
};

/** Payload of the branch-diff endpoint: the requested `base`, the merge-base sha it resolved to and the changed `files`, or the shared error fields plus a stable `code` (e.g. `GIT_NO_MERGE_BASE`) when the base cannot be compared. */
export type GitBranchDiffResponse = GitApiErrorResponse & {
  base?: string;
  mergeBase?: string;
  files?: GitBranchDiffFile[];
  code?: string;
};

/** One git worktree as reported by the worktrees API, including its branch, ahead/behind counts and the linked project used to open it. */
export type WorktreeInfo = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isMain: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  isDetached: boolean;
  changedFileCount: number;
  ahead: number;
  behind: number;
  lastCommitSubject: string | null;
  lastCommitDate: string | null;
  linkedProjectId: string | null;
  linkedProjectArchived: boolean;
};

/** Choices made in the merge-worktree dialog (squash, commit message and whether to remove the worktree afterwards), passed straight to the merge request. */
export type MergeWorktreeOptions = {
  squash: boolean;
  message: string;
  removeAfterMerge: boolean;
};

/** Choices made in the remove-worktree dialog (force removal and whether to delete the worktree's branch), passed straight to the remove request. */
export type RemoveWorktreeOptions = {
  force: boolean;
  deleteBranch: boolean;
};

/** Pre-computed lane geometry for one row of the history commit graph, telling the graph strip which rails to draw above, through and below that commit's dot. */
export type CommitGraphRow = {
  /** Lane the commit dot sits in. */
  nodeLane: number;
  /** Total lanes visible in this row — determines the strip width. */
  laneCount: number;
  /** A line arrives at the node from the row above (some child expects this commit). */
  hasTopContinuation: boolean;
  /** The node's own lane continues below toward its first parent. */
  hasParentContinuation: boolean;
  /** Extra top lanes that merge into the node (multiple children / branch tips joining). */
  inbound: number[];
  /** Bottom lanes branching out of the node toward its extra parents (merge commits). */
  outbound: number[];
  /** Lanes whose lines pass straight through this row untouched. */
  passThrough: number[];
  /** Every lane still active below this row — rails continue through expanded content. */
  bottomLanes: number[];
};

// ---------------------------

//----------------- MCP SERVERS ------------

/** The LLM provider whose MCP server configuration is being read or written; use it to key provider-specific MCP capabilities such as supported scopes and transports. */
export type McpProvider = LLMProvider;

/** Where an MCP server definition is stored - the user's global provider config, Claude's project-local config, or a project workspace config - and therefore which config file a read or write targets. */
export type McpScope = 'user' | 'local' | 'project';

/** How a client connects to an MCP server (a stdio subprocess, streamable HTTP, or SSE); use it to decide which connection fields of a server or form apply. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/** A plain string-to-string map used for the MCP environment variables and HTTP headers that are edited as `KEY=value` lines and sent as objects. */
export type KeyValueMap = Record<string, string>;

// Internal MCP shape; `projectId` replaces the legacy `name` field from the
// projectName → projectId migration.
export type McpProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** One MCP server as it is currently configured for a provider, as returned by the MCP API and rendered in the settings server list. */
export type ProviderMcpServer = {
  provider: McpProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
  workspacePath?: string;
  projectName?: string;
  projectDisplayName?: string;
};

/** The complete editable state of the MCP server form, covering the structured connection fields and the raw JSON import text; convert it with createMcpPayloadFromForm before sending it to the API. */
export type McpFormState = {
  name: string;
  scope: McpScope;
  workspacePath: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: KeyValueMap;
  cwd: string;
  url: string;
  headers: KeyValueMap;
  envVars: string[];
  bearerTokenEnvVar: string;
  envHttpHeaders: KeyValueMap;
  importMode: McpImportMode;
  jsonInput: string;
};

/** The request body sent when creating or updating a provider's MCP server, built from McpFormState so only the fields valid for the chosen transport are included. */
export type UpsertProviderMcpServerPayload = {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: KeyValueMap;
  cwd?: string;
  url?: string;
  headers?: KeyValueMap;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: KeyValueMap;
};

/** Whether the MCP server form is being filled in field by field or pasted in as raw JSON, which selects the form's input mode. */
type McpImportMode = 'form' | 'json';

// ---------------------------

//----------------- PLUGINS ------------

/** An installed CloudCLI plugin's manifest and runtime status (entry point, slot, permissions, enabled and server-running flags); always import this type explicitly from `@/shared/types`, because `Plugin` is also a DOM global and an unimported reference silently resolves to that instead. */
export type Plugin = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  type: 'react' | 'module';
  slot: 'tab';
  entry: string;
  server: string | null;
  permissions: string[];
  enabled: boolean;
  serverRunning: boolean;
  dirName: string;
  repoUrl: string | null;
};

// ---------------------------

//----------------- PRD EDITOR ------------

/** The PRD document the PRD editor should open, describing either an existing file to load (by path or inline content) or a blank draft to start from. */
export type PrdEditorFile = {
  name?: string;
  path?: string;
  // DB projectId used to resolve the project path when fetching file content.
  projectId?: string;
  content?: string;
  isExisting?: boolean;
};

/** A PRD already stored in a project's TaskMaster docs folder, used to detect filename collisions before saving and to load a previously written PRD. */
export type ExistingPrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

// ---------------------------

//----------------- PROJECT CREATION WIZARD ------------

/** The one-based index of the step currently shown by the project-creation wizard: 1 configures the workspace, 2 reviews it before creation. */
export type WizardStep = 1 | 2;

/** How the project-creation wizard authenticates a GitHub clone: reuse a 'stored' credential, enter a 'new' token, or use 'none' and rely on public access or an SSH key. */
export type TokenMode = 'stored' | 'new' | 'none';

/** One filesystem directory returned by the browse-filesystem endpoint, used to populate workspace-path autocomplete and the folder browser. */
export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

/** A stored GitHub token credential as returned by the credentials endpoint, listed so the user can pick which token authenticates a clone. */
export type GithubTokenCredential = {
  id: number;
  credential_name: string;
  is_active: boolean;
};

/** The full set of user-entered values carried across the project-creation wizard's steps, owned by ProjectCreationWizard and passed down to each step. */
export type WizardFormState = {
  workspacePath: string;
  githubUrl: string;
  tokenMode: TokenMode;
  selectedGithubToken: string;
  newGithubToken: string;
};

// ---------------------------

//----------------- PROJECT WORKSPACE ------------

/** The shared WebSocket connection and its send function, threaded through the workspace tree so descendants can exchange live session messages. */
export type RealtimeProps = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
};

/** Everything the project workspace shell and its regions need from the route: the realtime connection plus the current viewport mode and the router's navigate function. */
export type ProjectWorkspaceShellProps = RealtimeProps & {
  isMobile: boolean;
  navigate: NavigateFunction;
};

// ---------------------------

//----------------- PROVIDER AUTHENTICATION ------------

/** Reported by the server when an ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is taking precedence over a still-valid `claude /login` subscription, so every request is billed pay-as-you-go to the key; says which variable won, where it was found (the fix differs: restart after unsetting a process env var, or edit the `env` block of ~/.claude/settings.json) and the bypassed account's email when the credentials file records one. Rendered as a warning by the settings account view. */
export type ProviderAuthSubscriptionOverride = {
  variable: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';
  source: 'process_env' | 'settings_file';
  subscriptionEmail: string | null;
};

/** Sign-in state of one LLM provider CLI - whether it is authenticated, the account email and method, plus in-flight loading and error state - polled by the provider-auth module and rendered by the settings and onboarding account views. `subscriptionOverride` is only present when an API key is bypassing a valid subscription login. */
export type ProviderAuthStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error: string | null;
  loading: boolean;
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

/** The authentication state of every CLI provider at once, keyed by LLMProvider, so onboarding and settings can render each provider's connected, loading and error state from one object returned by useProviderAuthStatus. */
export type ProviderAuthStatusMap = Record<LLMProvider, ProviderAuthStatus>;

// ---------------------------

//----------------- QUICK SETTINGS PANEL ------------

/** Identifier of a boolean user preference exposed in the quick settings panel; use it as the key when reading or writing one preference. */
export type PreferenceToggleKey =
  | 'showRawParameters'
  | 'showThinking'
  | 'sendByCtrlEnter'
  | 'voiceEnabled';

/** The full set of quick settings booleans keyed by PreferenceToggleKey, held together so the panel can read every toggle from one object. */
export type QuickSettingsPreferences = Record<PreferenceToggleKey, boolean>;

/** Which content area the quick settings panel is showing: 'settings' (preference toggles) or 'commands' (slash-command list); persisted with the pin state and used by the tab bar and the panel view. */
export type QuickSettingsTab = 'settings' | 'commands';

/** Inline style for the quick settings drag handle, produced by the drag hook from the stored handle position and applied by the handle component. */
export type QuickSettingsHandleStyle = CSSProperties;

// ---------------------------

//----------------- SETTINGS ------------

/** The per-provider agent context the agents settings tab builds once and hands to each of its sections. */
export type AgentContextByProvider = Record<AgentProvider, AgentContext>;

/** The per-provider data the agents settings tab hands to its sections: that provider's auth status and the callback that starts its login flow. */
export type AgentContext = {
  authStatus: ProviderAuthStatus;
  onLogin: () => void;
};

/** Identifier of a top-level section in the settings dialog; use it whenever a tab is stored, compared or requested so deep links, the sidebar and the command palette all agree on the same set of names. */
export type SettingsMainTab = 'agents' | 'appearance' | 'git' | 'api' | 'voice' | 'tasks' | 'browser' | 'notifications' | 'plugins' | 'about';

/** The coding-agent CLI a settings screen is configuring, aliasing LLMProvider so agent-scoped settings read as being about an agent rather than a chat model. */
export type AgentProvider = LLMProvider;

/** One category of per-agent configuration in the agents settings tab (account, permissions, MCP servers or skills); use it to key which panel the tab renders. */
export type AgentCategory = 'account' | 'permissions' | 'mcp' | 'skills';

/** How much Codex may do without asking, from prompting on every edit to bypassing permission checks entirely; persisted as the Codex agent's permission setting. */
export type CodexPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

/** A project as the settings dialog needs it - a required identifier in `name` plus optional display name and paths - passed down to the MCP and skills panels so they can scope configuration to a project. */
export type AgentSettingsProject = {
  name: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** Claude's persisted permission settings: the allowed and disallowed tool patterns and whether permission prompts are skipped; read and written as one unit by the settings controller. */
export type ClaudePermissionsState = {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
};

/** The user's notification settings, grouped into delivery channels (in-app, web push, desktop, sound) and the events that trigger them; mirrors the payload of the notification preferences API. */
export type NotificationPreferencesState = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
};

/** Cursor's persisted permission settings: the allowed and disallowed command patterns and whether permission prompts are skipped; read and written as one unit by the settings controller. */
export type CursorPermissionsState = {
  allowedCommands: string[];
  disallowedCommands: string[];
  skipPermissions: boolean;
};

/** The code editor display preferences shown in the appearance tab (word wrap, minimap, line numbers and font size), stored together as one server-backed `codeEditorSettings` preference. */
export type CodeEditorSettingsState = {
  wordWrap: boolean;
  showMinimap: boolean;
  lineNumbers: boolean;
  fontSize: string;
};

// ---------------------------

//----------------- SETTINGS CREDENTIALS ------------

/** One stored CloudCLI API key as the server returns it, in snake_case, including its masked key, creation and last-used timestamps and active flag; render it, do not rebuild it. */
export type ApiKeyItem = {
  id: string;
  key_name: string;
  api_key: string;
  created_at: string;
  last_used?: string | null;
  is_active: boolean;
};

/** A freshly issued API key in camelCase, the only time the full secret is available; show it once and then fall back to the stored ApiKeyItem. */
export type CreatedApiKey = {
  id: string;
  keyName: string;
  apiKey: string;
  createdAt?: string;
};

/** One stored GitHub credential as the server returns it, in snake_case, carrying its name, optional description, creation timestamp and active flag - never the token itself. */
export type GithubCredentialItem = {
  id: string;
  credential_name: string;
  description?: string | null;
  created_at: string;
  is_active: boolean;
};

// ---------------------------

//----------------- SHELL ------------

/** Handle returned when touch text-selection is installed on an xterm terminal; call updateHandles after the terminal reflows and dispose when tearing the terminal down. */
export type MobileTerminalSelectionManager = {
  dispose: () => void;
  updateHandles: () => void;
};

// ---------------------------

//----------------- SIDEBAR ------------

/** The complete project-list state and callback bundle the sidebar assembles once and threads down through its project list, project rows and session rows. */
/**
 * What a session row needs to draw its state and act on the session, named once
 * so the two lists that render a row — Projects and Conversations — cannot fall
 * out of step, and so a call site passes one prop instead of nine.
 *
 * SidebarProjectListProps composes it rather than restating it; it was already
 * carrying every member.
 */
export type SessionRowActions = {
  /** The rename currently open anywhere in the sidebar, or null. */
  activeRename: ActiveSidebarRename | null;
  /** Sessions with a run in flight or background work: they count as running; the former also show a spinner and hide destructive actions. */
  activeSessions: ReadonlySet<string>;
  /** The subset of `activeSessions` that only has background tasks running, which show the purple dot instead of the spinner. */
  backgroundSessionIds: ReadonlySet<string>;
  /** Sessions waiting on the user, which show the amber dot. */
  attentionSessionIds: ReadonlySet<string>;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches a session into an independent one. Rows hide it for providers that cannot. */
  onForkSession?: (session: SessionWithProvider) => void;
};

export type SidebarProjectListProps = SessionRowActions & {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  isProjectExpanded: (projectId: string) => boolean;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  isProjectStarred: (projectId: string) => boolean;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onNewSession: (project: Project) => void;
  /** The project whose session list is in bulk-selection mode and the rows ticked in it, or null while no list is selecting. */
  sessionSelection: SidebarSessionSelection | null;
  /** Enters bulk-selection mode for one project, or replaces its ticked rows (used by "Select all" and "Clear"). */
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  /** Ticks or unticks one row; takes the owning projectId so a memoized row can bind itself without a per-row closure. */
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  /** Leaves bulk-selection mode, discarding the ticked rows. */
  onCancelSessionSelection: () => void;
  /** Opens the bulk delete confirmation for the ids the list resolved as still deletable. */
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

/**
 * The colour theme the user selected, persisted as the `theme` preference.
 *
 * `light` and `dark` pin the appearance; `system` follows the operating
 * system's light/dark setting and keeps following it while the app is open.
 * `system` is the default, and is also what an unrecognised stored value
 * resolves to.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** The ordering applied to the project list, either alphabetically by name or by most recent activity, persisted alongside the user's appearance settings. */
export type ProjectSortOrder = 'name' | 'date';

/** Which list the sidebar is currently showing: projects, conversation search results, running sessions or archived items. */
export type SidebarSearchMode = 'projects' | 'conversations' | 'running' | 'archived';

/** A Project narrowed to the archived state so archived entries can be listed and restored without being mistaken for active projects. */
export type ArchivedProjectListItem = Project & { isArchived: true };

/** A ProjectSession whose LLM provider has been resolved into the required __provider field, so list rendering never has to re-derive it. */
export type SessionWithProvider = ProjectSession & {
  __provider: LLMProvider;
};

/** One archived session as returned by the archive API, carrying its own project identity because the owning project may itself be archived. */
export type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

/** The subset of archived-session fields needed to render a recent-conversations row and reopen the session it points at. */
export type RecentConversationListItem = Pick<
  ArchivedSessionListItem,
  'sessionId' | 'provider' | 'projectId' | 'projectDisplayName' | 'sessionTitle' | 'lastActivity'
>;

/**
 * The rename the sidebar currently has open, if any.
 *
 * One value rather than two id/draft pairs, so a project and a session cannot
 * both be mid-rename, and rows can be handed a resolved `isEditing` instead of
 * the raw id — a keystroke then only invalidates the row being renamed.
 *
 * A session rename carries the project that owns it so SidebarProjectList can
 * decide in O(1) which project row the draft belongs to. Without it every row
 * has to be handed the whole value and a keystroke invalidates all of them.
 */
export type ActiveSidebarRename =
  | { target: 'project'; id: string; draft: string }
  | { target: 'session'; id: string; projectId: string; draft: string };

/**
 * The sidebar's pending delete confirmation. One value rather than a pair of
 * nullable states, so a project dialog and a session dialog cannot both be
 * open — they are portalled at the same z-index and would stack. The project
 * variant carries the session count the dialog warns with, and the `sessions`
 * variant the ids of a bulk delete, resolved when the dialog was opened.
 */
export type PendingSidebarDeletion =
  | { kind: 'project'; project: Project; sessionCount: number }
  | { kind: 'session'; sessionId: string; sessionTitle: string; isArchived: boolean }
  | { kind: 'sessions'; sessionIds: string[] };

/**
 * The sessions ticked for a bulk action, scoped to the one project whose list
 * is in selection mode. Scoping it keeps a delete from mixing rows of two
 * projects, and lets every other project row be handed a constant `null`.
 */
export type SidebarSessionSelection = {
  projectId: string;
  sessionIds: ReadonlySet<string>;
};

/** Whether a TaskMaster MCP server is present and configured for a project, or null while that status is still unknown. */
export type MCPServerStatus = {
  hasMCPServer?: boolean;
  isConfigured?: boolean;
} | null;

// Retained as `name` for backwards compatibility with existing settings
// consumers; the value is populated from `projectId` by normalizeProjectForSettings.
export type SettingsProject = {
  name: string;
  displayName: string;
  fullPath: string;
  path?: string;
};

// ---------------------------

//----------------- SIDEBAR SEARCH ------------

/** Full result set of a conversation search, combining per-project message matches, session-title matches, the total match count and the query that produced them. */
export type ConversationSearchResults = {
  results: ConversationProjectResult[];
  titleResults: SessionTitleSearchResult[];
  totalMatches: number;
  query: string;
};

/** Progress of an in-flight conversation search, reported as the number of projects scanned out of the total so the UI can show how far the scan has got. */
export type SearchProgress = {
  scannedProjects: number;
  totalProjects: number;
};

/** One session whose title matched a conversation search, carrying enough project and session identity to open that session directly. */
export type SessionTitleSearchResult = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
};

/** All conversation matches found inside a single project during a search, grouped so the results can be rendered under one project heading. */
export type ConversationProjectResult = {
  // Emitted by the provider search service so the sidebar can map a
  // match back to the Project in its current state by projectId.
  projectId: string | null;
  projectName: string;
  projectDisplayName: string;
  sessions: ConversationSession[];
};

/** One session within a ConversationProjectResult, pairing the session's summary with the individual message matches found in it. */
type ConversationSession = {
  sessionId: string;
  sessionSummary: string;
  provider?: string;
  matches: ConversationMatch[];
};

/** A single matching message from a conversation search, holding the author role, the surrounding snippet and the ranges to highlight inside that snippet. */
type ConversationMatch = {
  role: string;
  snippet: string;
  highlights: SnippetHighlight[];
  timestamp: string | null;
  provider?: string;
  messageUuid?: string | null;
};

/** A start/end character range within a search-result snippet that should be visually marked as the matched text. */
type SnippetHighlight = {
  start: number;
  end: number;
};

// ---------------------------

//----------------- PROVIDER SKILLS ------------

/** The LLM provider whose skills are being listed, uploaded or deleted; use it to target the provider-specific skills endpoints. */
export type SkillsProvider = LLMProvider;

/** Where a skill was discovered - the user's home directory, a project, a plugin, the repository, an admin location, or the built-in system set - used to group, order and label skills and to decide whether one can be deleted. */
export type SkillsScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/** A project workspace whose skills can be listed or added to, identified by `projectId` with optional display name and path; passed into the skills settings UI as the list of selectable project scopes. */
export type SkillsProject = {
  projectId: string;
  displayName?: string;
  fullPath?: string;
  path?: string;
};

/** One skill available to a provider, carrying its slash command, description, originating scope and source path plus the owning plugin or project when it came from one. */
export type ProviderSkill = {
  provider: SkillsProvider;
  name: string;
  description: string;
  command: string;
  scope: SkillsScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
  projectDisplayName?: string;
  projectPath?: string;
};

/** One skill to upload, holding its SKILL.md content, the directory and file names to write it under, and any accompanying base64-encoded support files. */
export type ProviderSkillCreateEntryPayload = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: Array<{
    relativePath: string;
    content: string;
    encoding: 'base64';
  }>;
};

// ---------------------------

//----------------- TASK MASTER ------------

/** Identifier of a TaskMaster task or subtask, which TaskMaster may emit as either a number or a string. */
export type TaskId = string | number;

/** One task as returned by TaskMaster, including its status, priority, dependencies, implementation details and nested subtasks. */
export type TaskMasterTask = {
  id: TaskId;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  details?: string;
  testStrategy?: string;
  parentId?: TaskId;
  dependencies?: TaskId[];
  subtasks?: TaskMasterTask[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

/** A minimal pointer to a task, used by callbacks that only need its id and title rather than the full task record. */
export type TaskReference = {
  id: TaskId;
  title?: string;
  [key: string]: unknown;
};

/** A task handed to a click handler, which may be either a complete TaskMasterTask or a lightweight TaskReference. */
export type TaskSelection = TaskMasterTask | TaskReference;

/** A product-requirements document in a project's TaskMaster directory, used both for listing PRDs and for editing their content. */
export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  modified?: string;
  created?: string;
  path?: string;
  size?: number;
  [key: string]: unknown;
};

/** The TaskMaster section of a project record, describing whether the project has been initialised and the status metadata TaskMaster reports for it. */
export type TaskMasterProjectInfo = {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** A Project augmented with the flattened TaskMaster fields (configured flag, status and task counts) that the task board and its callers read directly. */
export type TaskMasterProject = Project & {
  taskMasterConfigured?: boolean;
  taskMasterStatus?: string;
  taskCount?: number;
  completedCount?: number;
  taskmaster?: TaskMasterProjectInfo;
};




/** The layout the task board is currently rendering: kanban columns, a flat list, or a grid. */
export type TaskBoardView = 'kanban' | 'list' | 'grid';

/** The task field the board is currently sorted by. */
export type TaskBoardSortField = 'id' | 'title' | 'status' | 'priority' | 'updated';

/** The direction of the task board's current sort, ascending or descending. */
export type TaskBoardSortOrder = 'asc' | 'desc';

/** One column of the kanban board, pairing its status and display colours with the tasks that belong to it. */
export type TaskKanbanColumn = {
  id: string;
  title: string;
  status: string;
  color: string;
  headerColor: string;
  tasks: TaskMasterTask[];
};

/** A TaskMaster task's lifecycle state; the known values are enumerated and the string fallback tolerates statuses added by newer TaskMaster releases. */
type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'review'
  | 'blocked'
  | 'deferred'
  | 'cancelled'
  | string;

/** A TaskMaster task's priority; high, medium and low are the known values and the string fallback tolerates anything else TaskMaster emits. */
type TaskPriority = 'high' | 'medium' | 'low' | string;

//----------------- STUDIO CONTRACTS ------------
/** Studio's server-confirmed connector state; never includes an API secret. */
export type StudioStatus = {
  // `source`: saved in Studio's vault, read from the owner key file (STUDIO_DEEPSEEK_ENV_FILE), or none.
  deepseek: { configured: boolean; source: 'vault' | 'file' | null; models: string[]; baseUrl: string };
  agentWorkbenchUrl: string | null;
  snrRemoteUrl: string | null;
};
/** Built-in home-screen apps that are not projects; `workspace` is the 工作台 tile and routes to the workbench (/work). */
export type StudioSystemApp = 'deepseek' | 'workspace' | 'connections' | 'github' | 'memory';
/** Icon glyphs a home-screen tile can show; the server accepts exactly this list. */
export type StudioGlyph = 'activity' | 'graduation' | 'candles' | 'mail' | 'folder' | 'terminal' | 'sparkles' | 'book' | 'chart' | 'globe';
/** One icon on the Studio home screen: a project (`project:<id>`) or a system app. */
export type StudioHomeTile = {
  id: string; name: string; tone: string; glyph: StudioGlyph | 'settings' | 'plug' | 'pull-request';
  // Short live state under the label, such as 在线 or 待配置.
  status?: string;
  // Tiles with an href navigate away (the workbench) instead of zooming open inside Studio.
  href?: string;
  // App Store-style progress while an AI builds this project: the icon dims and a ring fills.
  progress?: StudioTileProgress;
};
/** Build progress drawn on a home tile; `value` runs from 0 to 1 and follows the AI's task list. */
export type StudioTileProgress = { value: number; state: 'queued' | 'building' | 'done' | 'failed'; label?: string };
/** A DeepSeek conversation space: the general app or one project; histories never cross spaces. */
export type StudioChatSpace = 'deepseek' | `project:${string}`;
/** A persisted Studio conversation summary shared by its history and chat views. */
export type StudioConversation = {
  id: string; title: string; model: string; updated_at: string; space?: StudioChatSpace;
  messages?: { id: number; role: 'user' | 'assistant'; content: string; status: string }[];
};
/** A bounded read-only SNR health snapshot, not a strategy approval or training result. */
export type StudioSnr = {
  connected: boolean; reason?: string; phase?: number;
  tradingEnabled?: boolean; rulesApproved?: boolean; datasetCount?: number;
  // Read-only integration manifest the lab publishes (name, version, capabilities).
  manifest?: { name?: string; version?: string; capabilities?: string[] };
};
/** A quick-browse button on a project. */
export type StudioProjectLink = { label: string; url: string };
/** An SSH host Studio may open agent sessions on (server-configured). */
export type StudioRemoteHost = { name: string; label: string; target: string };
/** Reachability and installed tools of a remote host. */
export type StudioRemoteStatus = {
  name: string; online: boolean; latencyMs: number | null; checkedAt: string;
  tools: { claude: boolean; codex: boolean; tmux: boolean };
  error?: string;
};
/** A remote agent session command built by the server from validated config. */
export type StudioRemoteLaunch = { command: string; title: string };
/** Live check of a project link. */
export type StudioLinkStatus = { url: string; ok: boolean; status: number | null; latencyMs: number | null; frameable: boolean };
/**
 * One usage window of a model plan, e.g. the 5-hour or weekly limit. `id` is stable across reads; `model`
 * is set only on a window for one model or limit (Claude's weekly Opus or Fable, Codex's gpt-reserve).
 */
export type StudioQuotaWindow = { id: string; label: string; usedPercent: number; windowMinutes: number | null; resetsAt: string | null; model?: string };
/**
 * A credit allowance on the Claude account (the one-time cloud session credit or the extra-usage spend limit).
 * Amounts are in major units of `currency` and null when unknown; `endsAt` is its expiry or monthly reset.
 */
export type StudioQuotaCredit = {
  id: string;
  label: string;
  usedPercent: number | null;
  currency: string | null;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  endsAt: string | null;
  endKind: 'expires' | 'resets';
};
/**
 * What the home-screen widgets know about one provider's quota; `source` says how trustworthy it is.
 * `usage-api` is Claude's account usage read live by the server with its Claude login (what `/usage` shows).
 * `credits` is only sent for Claude, and only when the account has any.
 */
export type StudioQuotaSnapshot = {
  provider: 'claude' | 'codex' | 'deepseek';
  available: boolean;
  windows: StudioQuotaWindow[];
  balances: { currency: string; total: number; granted: number; toppedUp: number }[];
  credits?: StudioQuotaCredit[];
  source: 'official' | 'usage-api' | 'statusline' | 'sdk-event' | 'local-log' | 'unavailable';
  observedAt: string | null;
  stale: boolean;
  note?: string;
};
/** Whether quota figures show what is left (剩余, the default) or what has been used (已用); one choice per device. */
export type QuotaDisplayMode = 'remaining' | 'used';
/**
 * The owner's quota display choices, kept per device like the home-screen layout (useQuotaPreferences).
 * `items` holds only explicit show/hide choices keyed by QuotaDisplayItem.key; an item without one uses its default.
 */
export type QuotaPreferences = { mode: QuotaDisplayMode; items: Record<string, boolean> };
/**
 * One figure the home quota widgets, the workbench usage panel and Settings can show or hide: a usage window,
 * a Claude credit or the DeepSeek balance, built from the snapshots by listQuotaItems.
 */
export type QuotaDisplayItem = {
  // Stable key for the show/hide choice, e.g. `claude:window:five_hour`, `codex:window:codex:secondary`, `deepseek:balance`.
  key: string;
  provider: StudioQuotaSnapshot['provider'];
  // 'Claude', 'Codex' or 'DeepSeek'.
  providerName: string;
  kind: 'window' | 'credit' | 'balance';
  // Short label within the provider ('5 小时', '每周 · Opus', '云端额度', '余额').
  label: string;
  // Full name for the Settings switch ('Claude 每周（全部模型）').
  title: string;
  // 0..100, null for a balance or a credit known only by its amounts.
  usedPercent: number | null;
  // When the window resets or the credit expires; null when unknown.
  endsAt: string | null;
  endKind: 'resets' | 'expires';
  // Money figures for credits and balances, in major units; null for plain windows.
  amount: { currency: string; remaining: number | null; used: number | null; limit: number | null } | null;
  stale: boolean;
  // Shown when the owner has made no choice: Claude 5 小时 and 每周, Codex 每周, DeepSeek 余额.
  shownByDefault: boolean;
  // False for a Settings placeholder of an item the account has not reported yet.
  present: boolean;
};
//----------------- STUDIO PROJECT CONTRACTS ------------
/** A coding agent that runs in the inherited IDE inside the project's directory. */
export type HubAgentProvider = LLMProvider;
/** Any model a project can enable: the IDE agents plus Studio's DeepSeek API chat. */
export type HubProvider = HubAgentProvider | 'deepseek';
/** Optional project tools, each shown as a tab in the project app. */
export type HubModule = 'agents' | 'mail' | 'automations' | 'snr-lab' | 'trading212';
/** User-owned project (one home-screen icon); its credentials never travel in this record. */
export type HubProjectInput = {
  name: string;
  description: string;
  workspacePath: string;
  modules: HubModule[];
  providers: HubProvider[];
  tone: string;
  glyph: StudioGlyph;
  links: StudioProjectLink[];
  // Configured SSH host name when agents run remotely (e.g. AJ); empty runs them on this machine.
  remoteHost: string;
  remoteDir: string;
};
/** Project identity and editable configuration displayed by Studio. */
export type HubProject = HubProjectInput & { id: string; updatedAt: string };
/** Saved automation instructions; saving alone never activates a task. */
export type HubTaskInput = { title: string; prompt: string; provider: HubAgentProvider };
/** An automation draft returned by the server, not a running job. */
export type HubTask = HubTaskInput & { id: string; updatedAt: string };
/** Existing native agent session associated with one project directory. */
export type HubSession = { id: string; title: string; provider: HubAgentProvider };
/** Gmail OAuth connection metadata, without access tokens. */
export type HubMailStatus = { configured: boolean; connected: boolean; email: string | null; access: 'readonly' };
/** Read-only Gmail search result. Full text is fetched only when opened. */
export type HubMailMessage = { id: string; subject: string; from: string; date: string; snippet: string };
/** Trading 212 account environment; live and demo use separate keys. */
export type T212Env = 'live' | 'demo';
/** Whether the server found a key file for an environment; never contains the key. */
export type T212Status = { env: T212Env; configured: boolean; source: string | null };
/** A profit/loss change between two stored balance snapshots, net of deposits when known. */
export type T212Change = { amount: number; percent: number; since: string; flowAdjusted: boolean };
/** One open position, valued in the account currency. */
export type T212Position = {
  ticker: string; name: string; currency: string; quantity: number; averagePrice: number; currentPrice: number;
  value: number; cost: number; pnl: number; fx: number | null; openedAt: string;
};
/** Read-only account overview returned by the Trading 212 module. */
export type T212Overview = {
  env: T212Env; currency: string; totalValue: number; fetchedAt: string;
  cash: { available: number; reserved: number; inPies: number };
  investments: { value: number; cost: number; unrealized: number; realized: number };
  changes: { today: T212Change | null; yesterday: T212Change | null };
  recordedSince: string | null;
  positions: T212Position[];
};
/** One stored balance snapshot for the equity curve. */
export type T212Point = { at: string; value: number; unrealized: number };
/** A recent fill or dividend. */
export type T212Activity = {
  id: string; kind: 'buy' | 'sell' | 'dividend'; ticker: string; name: string; quantity: number;
  price: number | null; value: number | null; realized: number | null; currency: string; at: string; status: string;
};
// ── v4 track: network — types below this line ──
/**
 * One of Studio's two front doors to the single backend on the laptop: `public` is the owner's
 * domain through a Cloudflare Tunnel (the default), `tailnet` is Tailscale Serve reached over AJ's
 * tailnet. Used for handoff targets and for the per-device door preference.
 */
export type StudioIngressId = 'public' | 'tailnet';
/** A front door as GET /api/studio/network lists it; `origin` is null when it is not configured. */
export type StudioIngress = { id: StudioIngressId; label: string; origin: string | null; configured: boolean; isDefault: boolean };
/**
 * GET /api/studio/network: both doors, the one that served this page ('local' for localhost or
 * dev hosts), whether the session came from passwordless Tailscale sign-in, and short guidance.
 */
export type StudioNetworkInfo = {
  ingresses: StudioIngress[];
  current: StudioIngressId | 'local';
  session: 'password' | 'tailscale';
  guidance: string[];
};
// ── v4 track: orders — types below this line ──
//----------------- STUDIO TRADING 212 ORDERS ------------
/** Buy or sell in the Trading 212 order sheet; the server turns a sell into a negative quantity. */
export type T212OrderSide = 'buy' | 'sell';
/** A Face ID / Touch ID passkey registered for one Studio domain (its RP ID); a passkey never authorizes another domain. */
export type T212Passkey = { id: string; rpId: string; label: string | null; createdAt: string; lastUsedAt: string | null };
/** A pair of order caps in the account currency: per order, and for all orders in any rolling 24 hours. */
export type T212CapLimits = { maxOrderValue: number; dailyLimit: number };
/**
 * New caps for one account, as sent to POST /caps/challenge and PUT /caps (Settings → 交易安全). Values are positive
 * with at most two decimals; the server also enforces the ceiling and that the per-order cap fits in the daily one.
 */
export type T212CapsInput = T212CapLimits & { env: T212Env };
/**
 * The caps in force for one account and how much of the daily cap is used: placed and unknown-outcome orders in
 * the last 24 hours plus confirmations in flight. `custom` is false while the server defaults apply. Read by the
 * order sheet (remaining allowance) and the cap editor in Settings.
 */
export type T212AccountCaps = T212CapLimits & {
  custom: boolean; updatedAt: string | null; dailyUsed: number; dailyRemaining: number; currency?: string;
};
/**
 * One audited cap entry in Settings → 交易安全, newest first. `applied`: a saved change (lowering with the session,
 * raising with Face ID / Touch ID). `refused`: a raise attempt that was turned down, with its reason; `method` is
 * 'passkey' when it named a challenge. Account and values are null only for a malformed attempt naming no challenge.
 */
export type T212CapChange = T212StepUpWho & {
  id: number; env: T212Env | null; direction: 'raise' | 'lower'; method: 'passkey' | 'session'; status: 'applied' | 'refused';
  from: T212CapLimits | null; to: T212CapLimits | null; reason: string | null; origin: string | null; createdAt: string;
};
/**
 * Who caused an audited Trading 212 safety entry: a short fragment of the session id, whether it is the session
 * viewing Settings, and the masked client ("Tailscale 100.64.*.*"). Null on entries recorded before this existed.
 */
export type T212StepUpWho = { session: string | null; currentSession: boolean; client: string | null };
/**
 * A Face ID / Touch ID challenge handed out for raising caps or adding accounts to the trading mode, newest first in
 * Settings, so the owner can see which session is asking: open, used, left to expire, or replaced by a newer one of
 * the same session, or unknown for a challenge recorded before outcomes were. `to` is the requested caps or mode
 * (null for an unreadable row).
 */
export type T212StepUpRequest = T212StepUpWho & {
  id: string; outcome: 'pending' | 'used' | 'expired' | 'replaced' | 'unknown'; origin: string | null; createdAt: string;
} & ({ kind: 'caps'; env: T212Env | null; to: T212CapLimits | null } | { kind: 'mode'; to: T212TradingMode | null });
/**
 * Which Trading 212 accounts may place orders: none, demo only, live only, or both. STUDIO_T212_TRADING on the server
 * is the ceiling; the user's own choice in Settings → 交易安全 can only narrow it (adding an account needs Face ID).
 */
export type T212TradingMode = 'off' | 'demo' | 'live' | 'both';
/**
 * The trading mode as GET /trading and PUT /mode report it: `mode` is in force (the ceiling ∩ the user's choice),
 * `ceiling` is STUDIO_T212_TRADING, `custom` is false until the user chose (then the ceiling applies).
 */
export type T212TradingModeState = { mode: T212TradingMode; ceiling: T212TradingMode; custom: boolean; updatedAt: string | null };
/**
 * One audited trading-mode entry in Settings → 交易安全, newest first. `applied`: a saved change (narrowing with the
 * session, widening with Face ID / Touch ID, or a pin: the mode in force stored as the user's choice, `from` null when
 * it happened on the first read). `refused`: a widening attempt that was turned down, with its reason; `method` is
 * 'passkey' when it named a challenge. Modes are null only for a malformed attempt naming no challenge.
 */
export type T212ModeChange = T212StepUpWho & {
  id: number; direction: 'widen' | 'narrow' | 'pin'; method: 'passkey' | 'session'; status: 'applied' | 'refused';
  from: T212TradingMode | null; to: T212TradingMode | null; reason: string | null; origin: string | null; createdAt: string;
};
/**
 * A single-use, 60-second Face ID / Touch ID challenge from POST /caps/challenge or POST /mode/challenge, bound to the
 * exact values being approved; `authentication` goes to startAuthentication and the assertion back with `challengeId`.
 */
export type T212StepUpChallenge = { challengeId: string; expiresAt: string; authentication: PublicKeyCredentialRequestOptionsJSON };
/** Server order-safety settings shared by the order sheet and Settings: tradable accounts, per-user caps and passkeys. */
export type T212TradingConfig = {
  // Accounts this user may trade now: STUDIO_T212_TRADING ∩ their trading mode; empty means trading is off.
  allowedEnvs: T212Env[];
  // The trading mode in force, the server ceiling, and whether the user has chosen one.
  tradingMode: T212TradingModeState;
  // This user's latest applied trading-mode changes, newest first; refused widenings are listed apart.
  modeChanges: T212ModeChange[];
  // This user's latest refused widening attempts, newest first.
  modeRefusals: T212ModeChange[];
  // Face ID challenges handed out for caps or the trading mode, newest first, with the session and client that asked.
  stepUpRequests: T212StepUpRequest[];
  // Per-account caps; `defaults` come from STUDIO_T212_MAX_ORDER_VALUE / _MAX_DAILY_VALUE, nothing exceeds `ceiling`.
  caps: { ceiling: number; defaults: T212CapLimits; envs: Record<T212Env, T212AccountCaps> };
  // This user's latest applied cap changes, newest first; refused raises are listed apart so they cannot crowd them out.
  capChanges: T212CapChange[];
  // This user's latest refused raise attempts, newest first.
  capRefusals: T212CapChange[];
  // Account currency from the last stored balance snapshot; absent before the account was first read.
  currency?: string;
  // This user's passkeys on every domain; once there is one, a domain without its own passkey cannot trade.
  passkeys: T212Passkey[];
  // Origins allowed to trade and register passkeys.
  trustedOrigins: string[];
  // STUDIO_T212_ALLOW_LOCALHOST=1: http://localhost, 127.0.0.1 and [::1] are trusted as well.
  allowLocalhost: boolean;
  // STUDIO_T212_REQUIRE_PASSKEY=1: the double confirmation is off, so every domain needs its own passkey.
  requirePasskey: boolean;
};
// ── v4 track: mail — types below this line ──
//----------------- STUDIO MAIL CONTRACTS ------------
/** How a Studio mail account is read: Gmail over IMAP (App Password), Outlook over Graph, or a legacy project Gmail OAuth link. */
export type StudioMailProvider = 'gmail-imap' | 'outlook' | 'gmail-oauth';
/** A mail account owned by the Studio user; the server never sends its password or tokens. */
export type StudioMailAccount = {
  id: string;
  provider: StudioMailProvider;
  email: string;
  displayName: string;
  // `reauth`: the provider rejected the saved credential; the user must add the account again.
  status: 'ok' | 'error' | 'reauth';
  lastError: string | null;
  createdAt: string;
};
/** GET /api/studio/mail/accounts: the accounts plus whether the server can offer Outlook sign-in. */
export type StudioMailAccounts = { accounts: StudioMailAccount[]; outlookConfigured: boolean };
/** One row of the unified inbox. Untrusted plain text (no markup); render it as text, never as HTML. */
export type StudioMailMessage = {
  id: string;
  accountId: string;
  subject: string;
  from: string;
  fromAddress: string;
  // ISO-8601, or empty when the provider gave no usable date.
  date: string;
  snippet: string;
  unread: boolean;
};
/** An opened message: the row plus recipients and the capped plain-text body. */
export type StudioMailMessageDetail = StudioMailMessage & { to: string; text: string; truncated: boolean };
/**
 * One account that could not be listed: a provider failure, an account paused until its credentials are replaced
 * or cooling down after repeated failures, or (`skipped`) a search its provider cannot run, which is a notice
 * rather than a fault of the account. `message` is short user-facing Chinese text.
 */
export type StudioMailAccountFailure = { accountId: string; email: string; message: string; skipped?: true };
/** GET /api/studio/mail/messages: merged messages, plus per-account failures that did not stop the others. */
export type StudioMailInbox = { messages: StudioMailMessage[]; errors: StudioMailAccountFailure[] };
/** An Outlook device-code sign-in in progress: the code the user types at Microsoft, never the device secret. */
export type StudioMailDeviceStart = { pollId: string; userCode: string; verificationUri: string; expiresAt: string; interval: number };
/** One poll of an Outlook device-code sign-in. */
export type StudioMailDevicePoll = { status: 'pending' | 'connected' | 'expired' | 'error'; account?: StudioMailAccount; message?: string };
// ---------------------------

//----------------- STUDIO V6: WORKBENCH, GITHUB, AI BUILDS, MEMORY ------------
/** One row of the workbench sidebar: a Claude Code / Codex session or a DeepSeek conversation of the current project. */
export type WorkbenchSessionItem = {
  id: string; kind: 'agent' | 'deepseek'; provider: 'claude' | 'codex' | 'cursor' | 'opencode' | 'deepseek';
  title: string; updatedAt: string | null; running?: boolean;
};
/** What the workbench shell hands its chat column (src/modules/workbench/chat/WorkbenchChat). */
export type WorkbenchChatProps = {
  // The IDE project (projectId + filesystem path) the chat runs in.
  project: Project;
  // The open session, or null for a new chat.
  session: WorkbenchSessionItem | null;
  // Provider preselected for a new chat. Cursor and OpenCode come from the Studio project app's launch cards.
  provider: 'claude' | 'codex' | 'cursor' | 'opencode' | 'deepseek';
  // The Studio hub project with this path, if any (DeepSeek project space, memory scope, icon).
  hubProjectId: string | null;
  // Called once a new chat has a real session id, so the shell can list and route to it.
  onSessionCreated: (item: WorkbenchSessionItem) => void;
  // Opens a file in the shell's file panel.
  onOpenFile: (path: string) => void;
};
// ── v6 track: shell — types below this line ──
/** A provider a new workbench chat can start with; also the `?new=` value of a workbench URL. */
export type WorkbenchNewProvider = WorkbenchChatProps['provider'];
/** A panel of the workbench inspector (the right slide-out): files, terminal, Git or preview. */
export type WorkbenchInspectorTab = 'files' | 'terminal' | 'git' | 'preview';
/** The workbench layout one device remembers: sidebar, inspector visibility, its tab and its width in px. */
export type WorkbenchLayout = { sidebarCollapsed: boolean; inspectorOpen: boolean; inspectorTab: WorkbenchInspectorTab; inspectorWidth: number };
/** One day bucket of the workbench history (今天 / 昨天 / 本周 / 更早), rows newest first; empty buckets are omitted. */
export type WorkbenchSessionGroup = { id: 'today' | 'yesterday' | 'week' | 'earlier'; label: string; items: WorkbenchSessionItem[] };
/** An IDE project in the workbench switcher with the Studio hub project whose directory matches it, if any. */
export type WorkbenchProjectEntry = { project: Project; hub: HubProject | null };
/** Width class of the workbench viewport: phones get sheets, tablets an overlay inspector, desktops dock both columns. */
export type WorkbenchViewport = 'phone' | 'tablet' | 'desktop';
/** A local hub project and the IDE project registered for its directory (null until the first launch registers one). */
export type WorkbenchHubLink = { hubId: string; projectId: string | null };
/**
 * One agent a new workbench chat can start with, as the sidebar's new-session menu and the chat header's provider
 * menu list it. `unavailableReason` (short Chinese) is set when the agent cannot run here, e.g. DeepSeek in a
 * directory without a Studio project; both menus show it disabled with that reason.
 */
export type WorkbenchNewChatChoice = { provider: WorkbenchNewProvider; unavailableReason: string | null };
/**
 * What the workbench shell lends its chat column so the column's glass header is the workbench's only title bar:
 * the shell's controls on either side (sidebar and Studio buttons, the inspector toolbar), the project's display
 * name under the title, and a callback when a new chat switches provider in the header so the shell remembers it.
 */
export type WorkbenchChatChrome = {
  leading?: ReactNode;
  trailing?: ReactNode;
  projectName?: string;
  onProviderChange?: (provider: WorkbenchNewProvider) => void;
};
// ── v6 track: chat — types below this line ──
/**
 * One row of a workbench chat menu (WorkbenchMenu). `kind: 'toggle'` draws a switch instead of a check, is announced
 * as a checkbox, and keeps the menu open when tapped, like the 1M-context switch under the model list. `badge` is a
 * short tag after the label, e.g. 推荐. Built by the header pill, the composer chips and the model-menu helper.
 */
export type WorkbenchMenuItem = {
  key: string;
  label: string;
  hint?: string;
  // Drawn between the check and the label, e.g. a provider's mark.
  icon?: ReactNode;
  badge?: string;
  checked?: boolean;
  disabled?: boolean;
  tone?: 'danger';
  kind?: 'radio' | 'toggle';
  onSelect: () => void;
};
/** A titled group of WorkbenchMenu rows; `note` is shown under it, e.g. why its rows are locked. */
export type WorkbenchMenuSection = {
  key: string;
  title?: string;
  note?: string;
  items: WorkbenchMenuItem[];
};
/**
 * Answers one or more pending tool-permission prompts of the workbench chat: allow or deny, optionally
 * remembering an allow rule for the run or replacing the tool input (AskUserQuestion answers). Called by its
 * permission sheet, question sheet and plan card; the engine forwards it as `chat.permission-response`.
 */
export type WorkbenchPermissionDecision = (
  requestIds: string | string[],
  decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
) => void;
/** One step of an agent's running checklist (Claude TodoWrite, Codex update_plan) as the workbench chat's run island and tool cards draw it. */
export type WorkbenchTodoItem = { content: string; activeForm?: string; status: 'pending' | 'in_progress' | 'completed' };
/**
 * A tool call reduced to the workbench chat's compact card: `kind` picks the icon, `verb` and `target` are the
 * one-line description, `status` drives the spinner, tick or cross. `idle` is a call with no result in a session
 * that is no longer running (interrupted), so it neither spins nor claims success.
 */
export type WorkbenchToolSummary = {
  kind: 'command' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'todo' | 'agent' | 'plan' | 'question' | 'think' | 'other';
  verb: string;
  target: string;
  // The file the call touched, when it touched one; tapping it opens the shell's file panel.
  filePath?: string;
  status: 'running' | 'done' | 'error' | 'denied' | 'idle';
};
// ── v6 track: github — types below this line ──
/** How a pull request is merged: squashed into one commit, with a merge commit, or as rebased commits. */
export type StudioGitHubMergeMethod = 'squash' | 'merge' | 'rebase';
/**
 * GET /api/studio/github/status: the gh account signed in on the server (never its token). `canMerge` is false when
 * the OAuth token lacks the `repo` scope; `message` is short Chinese guidance when something needs the owner.
 */
export type StudioGitHubStatus = {
  installed: boolean; authenticated: boolean; login: string | null; scopes: string[]; canMerge: boolean;
  message: string | null; checkedAt: string;
};
/** CI checks of a head commit counted by outcome; `state` is the worst outcome present ('none' without checks). */
export type StudioGitHubChecks = { state: 'passing' | 'failing' | 'pending' | 'none'; passing: number; failing: number; pending: number; total: number };
/**
 * One open pull request in the GitHub inbox. `id` is "owner/repo#number"; `headSha` is the full head commit a merge
 * must match; `reasons` says why it is listed (opened by the account, awaiting its review, in a repository it owns).
 */
export type StudioGitHubPull = {
  id: string; owner: string; repo: string; number: number; title: string; author: string; url: string; isDraft: boolean;
  headRef: string; baseRef: string; headSha: string; additions: number; deletions: number; changedFiles: number;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  // GitHub's mergeStateStatus in lower case: clean, unstable, blocked, behind, dirty, draft, has_hooks or unknown.
  mergeState: string;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: StudioGitHubChecks; updatedAt: string; reasons: ('authored' | 'review' | 'owned')[];
};
/** GET /api/studio/github/prs: the inbox, newest activity first; `truncated` when a search had more than 50 results. */
export type StudioGitHubInbox = { login: string; pulls: StudioGitHubPull[]; fetchedAt: string; truncated: boolean };
/** One CI check of a pull request's head commit; `url` is https or null, and failing checks come first. */
export type StudioGitHubCheck = { name: string; workflow: string | null; state: 'passing' | 'failing' | 'pending' | 'skipped'; required: boolean; url: string | null };
/** One changed file; `change` is added, modified, deleted, renamed, copied or changed. */
export type StudioGitHubFile = { path: string; additions: number; deletions: number; change: string };
/**
 * GET /api/studio/github/prs/:owner/:repo/:number: a pull request with its checks, up to 100 files, a plain-text
 * description excerpt (render as text, never as HTML), the merge methods the repository allows and the server's
 * blockers, which the merge endpoint enforces whatever the sheet shows. `mergeQueue` means the base branch requires a
 * merge queue: the merge queues the PR and cannot delete its branch. A `mergeState` of 'unstable' needs the same
 * acknowledgement as a failing check, since GitHub sees checks that do not pass.
 */
export type StudioGitHubPullDetail = StudioGitHubPull & {
  state: 'open' | 'closed' | 'merged'; body: string; bodyTruncated: boolean; createdAt: string;
  checkItems: StudioGitHubCheck[]; checksTruncated: boolean; files: StudioGitHubFile[]; filesTotal: number;
  mergeMethods: StudioGitHubMergeMethod[]; deleteBranchOnMerge: boolean; isCrossRepository: boolean; viewerCanMerge: boolean;
  mergeQueue: boolean; blockers: { code: string; message: string }[]; mergeCommitSha: string | null;
};
/**
 * POST …/merge body. `expectedHeadSha` is the head the user reviewed (GitHub refuses a moved head);
 * `acknowledgeFailing` confirms merging despite failing checks that branch protection does not require.
 */
export type StudioGitHubMergeInput = { method: StudioGitHubMergeMethod; expectedHeadSha: string; deleteBranch: boolean; acknowledgeFailing: boolean };
/** POST …/merge result: merged, or accepted into a merge queue. */
export type StudioGitHubMergeResult = { outcome: 'merged' | 'queued'; mergeCommitSha: string | null; message: string };
/**
 * GET /api/studio/github/merges: one audited merge attempt of the signed-in Studio user, newest first. An 'invalid'
 * attempt is a request the server rejected before reading the PR; its `method` is null and `headSha` may be ''.
 */
export type StudioGitHubMergeRecord = {
  id: number; owner: string; repo: string; number: number; method: StudioGitHubMergeMethod | null; headSha: string; deleteBranch: boolean;
  outcome: 'pending' | 'merged' | 'queued' | 'refused' | 'failed' | 'unknown' | 'invalid'; code: string | null; message: string | null;
  createdAt: string; finishedAt: string | null;
};
// ── v6 track: builder — types below this line ──
/** Lifecycle of an App Store-style AI build (server `studio_builds.state`); drives the home tile's veil and ring. */
export type StudioBuildState = 'queued' | 'building' | 'done' | 'failed';
/**
 * One AI build as `/api/studio/builds` returns it. `hubProjectId` is its home-screen icon; `ideProjectId` + `sessionId`
 * open the workbench session doing the work. `total`/`completed`/`currentTask` follow the agent's checklist;
 * `error` explains a failed build ('已取消' when the owner stopped it).
 */
export type StudioBuild = {
  id: string; hubProjectId: string; ideProjectId: string; sessionId: string; workspacePath: string;
  state: StudioBuildState; total: number; completed: number; currentTask: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; error: string | null;
};
/** What starting an AI build returns: the build and the hub project that became its icon (added to the home screen at once). */
export type StudioBuildCreated = { build: StudioBuild; project: HubProject };
/**
 * How the server runs AI builds right now (GET /api/studio/builds/environment): `sandbox` lets the agent install, run
 * and test inside Claude Code's OS sandbox (opt-in with STUDIO_BUILD_SANDBOX=on); `restricted`, the default, only
 * writes code and commits. `available` says whether the sandbox could run on the server at all, and `missing` names
 * the packages to install for it. Shown by the build composer.
 */
export type StudioBuildEnvironment = { mode: 'sandbox' | 'restricted'; missing: string[]; available: boolean };
// ── v6 track: memory — types below this line ──
/** Which agent wrote a shared-memory note (from its tags); null when the note is untagged. */
export type StudioMemorySource = 'claude' | 'codex' | 'deepseek';
/**
 * One note in the 记忆 app's lists. `id` is the basic-memory permalink and the only identifier the memory API
 * accepts back; `folder` is a project folder or `global`; `snippet` is plain text (empty in recent lists).
 */
export type StudioMemoryNote = {
  id: string; title: string; folder: string; source: StudioMemorySource | null; updatedAt: string | null; snippet: string;
};
/** An opened note: Markdown without frontmatter, written by a model or a person; render it escaped, never as HTML. */
export type StudioMemoryNoteDetail = StudioMemoryNote & { content: string; tags: string[]; truncated: boolean };
/** A top-level memory folder, with the hub project it belongs to (for its icon) when one matches. */
export type StudioMemoryFolder = { name: string; project: { id: string; name: string; tone: string; glyph: string } | null };
/**
 * GET /api/studio/memory/notes: the newest notes (optionally of one folder), every folder, and `total`, the number
 * of notes in the listed scope (the selected folder, or the whole memory).
 */
export type StudioMemoryRecent = { notes: StudioMemoryNote[]; folders: StudioMemoryFolder[]; total: number };
/** Which agent installation a status row describes: Claude Code or Codex, inside WSL or on Windows. */
export type StudioMemoryAgentId = 'claude-wsl' | 'codex-wsl' | 'claude-windows' | 'codex-windows';
/**
 * A setting that keeps an agent from using the shared server although its config names it: an unparsable config,
 * a disabled entry (Codex `enabled = false`, a Claude Code project's `disabledMcpServers`), a Claude Code project
 * entry of the same name that is not the shared server, or a `[::1]` URL the server (127.0.0.1 only) never answers.
 */
export type StudioMemoryAgentIssue = 'invalid-config' | 'disabled' | 'project-override' | 'ipv6-loopback';
/**
 * How one agent installation is wired, read from its own config: `shared` means registered over HTTP at the
 * shared server's URL; `conventions` means the current usage rules are in its global instructions; `issue` is a
 * setting that blocks it anyway; `config` is where the registration lives; `fix` is the exact step (where to run
 * it and the command) that completes it, or null (also when the issue must be fixed by hand).
 */
export type StudioMemoryAgentStatus = {
  id: StudioMemoryAgentId; installed: boolean; registered: boolean; transport: string | null; shared: boolean;
  conventions: boolean; issue: StudioMemoryAgentIssue | null; config: string; fix: { where: string; command: string } | null;
};
/**
 * GET /api/studio/memory/status: whether the shared server answers (`slow`: connected but no answer in time),
 * where the notes live, each agent's wiring (Windows rows only when Studio runs under WSL) and whether Studio's
 * own DeepSeek bridge is on.
 */
export type StudioMemoryStatus = {
  reachable: boolean; slow: boolean; url: string; project: string | null; notesPath: string | null;
  agents: StudioMemoryAgentStatus[];
  deepseek: { enabled: boolean };
};
// ---------------------------

//----------------- STUDIO RUNTIME IDENTITY ------------
/** Build-time identity recorded by the build pipeline; null commit/dirty mean Git could not be verified. */
export type StudioBuildInfo = {
  schemaVersion: 1;
  version: string;
  commit: string | null;
  builtAt: string;
  dirty: boolean | null;
};
/**
 * Authenticated, read-only runtime snapshot for Settings. The backend build is captured at module load;
 * frontend is the currently served disk build; checkout is source state only, never a running version.
 * GitHub identifies origin's default branch; unknown/failure states must not imply that Studio is current.
 */
export type StudioRuntimeInfo = {
  checkedAt: string;
  frontend: { state: 'recorded' | 'unknown'; build: StudioBuildInfo | null; reason: string | null };
  backend: { state: 'recorded' | 'unknown'; build: StudioBuildInfo | null; reason: string | null };
  checkout: {
    state: 'available' | 'unavailable';
    commit: string | null;
    branch: string | null;
    dirty: boolean | null;
    reason: string | null;
  };
  github: {
    state: 'available' | 'unavailable' | 'unconfigured';
    repository: string | null;
    defaultBranch: string | null;
    commit: string | null;
    checkedAt: string | null;
    reason: string | null;
  };
  host: {
    hostname: string;
    platform: string;
    bootedAt: string;
    processStartedAt: string;
    /** Elapsed process lifetime in seconds; not the host uptime. */
    uptimeSeconds: number;
  };
};
// ---------------------------

//----------------- STUDIO ACCOUNT SECURITY ------------
/** A Face ID / Touch ID passkey that signs in to the Studio account on one domain (its RP ID). */
export type StudioSignInPasskey = { id: string; rpId: string; label: string | null; createdAt: string; lastUsedAt: string | null };
/**
 * One entry of the server's bounded security log: failed and successful sign-ins, password locks,
 * passkey changes and "退出所有设备". `client` is already masked ("198.51.*.*"); `detail` is plain text.
 */
export type StudioSecurityEvent = {
  id: number; at: string; type: string; door: string; client: string; detail: string | null;
  // How many events this row stands for: repeated sign-ins of one session are folded together.
  repeats?: number;
};
/** One password lock: whether it holds now and until when (ISO-8601). */
export type StudioPasswordLock = { locked: boolean; lockedUntil: string | null };
/** GET /api/auth/security: what Settings → 安全 shows for the signed-in account. */
export type StudioSecurityOverview = {
  // Origins whose pages may add and use sign-in passkeys (the configured front doors).
  passkeyOrigins: string[];
  passkeys: StudioSignInPasskey[];
  // Newest first, every kind of event.
  events: StudioSecurityEvent[];
  // Newest first: locks, lock lifts, passkey changes and revocations, which a flood of failed
  // sign-ins can never push out of the log.
  importantEvents: StudioSecurityEvent[];
  // Newest first: successful sign-ins (password, passkey, Tailscale, handoff), kept apart too.
  signIns: StudioSecurityEvent[];
  // Each door locks on its own: the public domain's password sign-in, the Tailscale address's, and
  // the password a signed-in session re-enters in Settings. Passkeys and Tailscale sign-in still work.
  passwordLocks: { public: StudioPasswordLock; tailnet: StudioPasswordLock; session: StudioPasswordLock };
};
/** POST /api/auth/security/revoke-all: what "退出所有设备" took away, for the confirmation toast. */
export type StudioRevokeAllResult = {
  success: boolean;
  revoked: { sessions: boolean; webSockets: number; apiKeys: number; snrAccess: number; pushSubscriptions: number; handoffCodes: number };
};
// ---------------------------
