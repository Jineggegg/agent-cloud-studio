import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

//----------------- HTTP RESPONSE SHAPES ------------
/**
 * Canonical success envelope used by backend APIs that return a structured payload.
 *
 * Use this for route handlers that need a stable `success/data` shape so frontend
 * consumers can parse responses consistently across endpoints.
 */
export type ApiSuccessShape<TData = unknown> = {
  success: true;
  data: TData;
};

/**
 * Generic plain-object record used when parsing loosely typed JSON payloads.
 *
 * Use this only after runtime shape checks, not as a replacement for validated
 * domain models.
 */
export type AnyRecord = Record<string, any>;

// ---------------------------
//----------------- WEBSOCKET TRANSPORT TYPES ------------
/**
 * Minimal websocket client contract used by backend broadcaster services.
 *
 * Any transport object added to `connectedClients` must implement these two
 * members so shared services can safely send JSON strings and check whether the
 * socket is still open before broadcasting.
 */
export type RealtimeClientConnection = {
  readyState: number;
  send(data: string): void;
};

/**
 * Authenticated user payload attached to websocket upgrade requests.
 *
 * Platform and OSS auth flows currently use either `id` or `userId`; both are
 * represented here so websocket handlers can resolve a stable writer user id.
 */
export type AuthenticatedWebSocketUser = {
  id?: string | number;
  userId?: string | number;
  username?: string;
  [key: string]: unknown;
};

/**
 * HTTP upgrade request shape after websocket authentication succeeds.
 *
 * `verifyClient` populates `request.user` with the authenticated payload, and
 * downstream websocket handlers rely on this extended request type.
 */
export type AuthenticatedWebSocketRequest = IncomingMessage & {
  user?: AuthenticatedWebSocketUser;
};

// ---------------------------
//----------------- PROVIDER MESSAGE MODEL ------------
/**
 * Providers supported by the unified server runtime.
 *
 * Use this as the source of truth whenever a function or payload needs to identify
 * a specific LLM integration.
 */
export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

/**
 * One selectable model row in a provider model catalog.
 */
export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  /** Stable SQLite row id used only by model-management actions. */
  recordId?: number;
  /** True for user-created rows; false for immutable CloudCLI defaults. */
  isCustom?: boolean;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

/**
 * Provider model catalog returned by `GET /api/providers/:provider/models`.
 */
export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

/**
 * One persisted custom-model row in the provider model library.
 *
 * Provider modules use this shape at the database boundary. Predefined models
 * never use this type because they remain source-controlled in provider
 * adapters. `modelId` is sent to the provider runtime, while `model` is the
 * user-supplied display name shown in pickers.
 */
export type CustomProviderModelRecord = {
  recordId: number;
  provider: LLMProvider;
  modelId: string;
  model: string;
  sortOrder: number;
};

/**
 * User-editable values accepted when creating or changing a custom model.
 *
 * `id` must be the exact provider-facing model identifier and cannot contain
 * whitespace. `model` is a concise display name. The provider is supplied by
 * the route path so a row can never be moved across providers accidentally.
 */
export type CustomProviderModelInput = {
  id: string;
  model: string;
};

// ---------------------------
//----------------- PROVIDER ACTIVE MODEL TYPES ------------
/**
 * Provider-neutral result for the model that is actively driving a session or
 * provider runtime at the time of lookup.
 *
 * `model` must always be populated. Provider adapters should use the
 * provider-specific lookup method requested by the caller, and only fall back
 * to the provider catalog `DEFAULT` value when the active model cannot be read.
 */
export type ProviderCurrentActiveModel = {
  model: string;
};

/**
 * Where a resolved session model came from.
 *
 * `session` means the app has recorded a model for this session (the user
 * picked one, or the session has been sent on at least once) and that value is
 * authoritative. `provider` means the session predates any app-recorded model
 * and the value was read back from the provider's own session state — the case
 * for sessions started directly in a provider CLI. `default` means neither was
 * available and the catalog default is standing in.
 *
 * Routes surface this so the frontend can tell a real selection apart from a
 * placeholder without re-deriving the precedence chain.
 */
export type ProviderSessionModelSource = 'session' | 'provider' | 'default';

/**
 * The model one session runs with, its persisted reasoning effort when one has
 * been recorded, and where the model answer came from.
 *
 * Returned by `providerModelsService.resolveSessionModel` and used by the
 * `/models`, `/cost` and `/status` commands, the active-model route, and the
 * composer's model picker so every surface agrees on one answer.
 */
export type ProviderSessionModel = {
  provider: LLMProvider;
  sessionId: string | null;
  model: string;
  /** NULL means this session has not recorded an effort choice yet. */
  effort: string | null;
  source: ProviderSessionModelSource;
};

/**
 * Message/event variants emitted by provider adapters and normalized transports.
 *
 * Keep this union in sync with event kinds produced by provider session adapters.
 */
export type MessageKind =
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

/**
 * Event kinds added by the chat gateway layer on top of provider message kinds.
 *
 * These are app-level realtime events (subscription acks, sidebar deltas,
 * project loading progress, protocol failures) that are not produced by any
 * provider adapter. Together with `MessageKind` they form the complete set of
 * `kind` values a websocket client can receive, so the frontend only ever
 * needs one kind-based switch.
 */
export type GatewayEventKind =
  | 'chat_subscribed'
  | 'session_upserted'
  | 'loading_progress'
  | 'protocol_error';

/**
 * Complete set of `kind` values emitted to websocket clients.
 *
 * Every server-to-client websocket frame carries a `kind` from this union.
 * Provider runtimes emit `MessageKind` values; gateway services emit
 * `GatewayEventKind` values.
 */
export type ServerEventKind = MessageKind | GatewayEventKind;

/** The owning project as it appears inside a `session_upserted` delta. */
export type SessionUpsertedProject = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
};

/**
 * The `session_upserted` sidebar delta, built only by
 * `modules/websocket/services/session-upsert-broadcast.service.ts`.
 *
 * Typed rather than assembled as an untyped object literal because the payload
 * used to be built in two places and silently drifted apart: one copy set
 * `providerSessionId` and the other did not, and nothing could detect it.
 *
 * `providerSessionId` is how a client recognises that a row it is currently
 * showing has been merged into its canonical app-session row, so it is always
 * present — `null` only while the provider has not reported an id yet.
 */
export type SessionUpsertedEvent = {
  kind: 'session_upserted';
  sessionId: string;
  providerSessionId: string | null;
  provider: LLMProvider;
  session: {
    id: string;
    summary: string;
    messageCount: number;
    lastActivity: string;
  };
  project: SessionUpsertedProject | null;
  timestamp: string;
};

/**
 * Provider-neutral message envelope used in REST responses and realtime channels.
 *
 * Every provider-specific message must be converted into this shape before being
 * emitted outside provider-specific modules.
 */
/**
 * A compaction, as the transcript records it.
 *
 * `running` is the status the CLI sends when it starts compacting, `done` the
 * boundary it sends when it has, `failed` a compaction that did not finish.
 * The token counts and duration only come with a boundary.
 */
export type CompactionInfo = {
  phase: 'running' | 'done' | 'failed';
  /** Whether the user asked for it or the context window did. */
  trigger?: 'manual' | 'auto';
  /** Tokens the conversation held before and after, when the boundary reports them. */
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string | null;
};

export type NormalizedMessage = {
  id: string;
  /**
   * The provider's own identifier for the transcript row this message came
   * from, when the provider has stable per-row identity (today: Claude's
   * `uuid`). It is what "edit this message" and "fork from here" address, so it
   * has to survive a reload — never a value this app synthesized.
   */
  transcriptAnchorId?: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Monotonic per-run sequence number assigned by the chat run registry when a
   * live event is forwarded to the websocket. History messages loaded over
   * REST do not carry it. Clients use it with `chat.subscribe` to replay only
   * the live events they missed across websocket reconnects.
   */
  seq?: number;
  /** Stable execution id; live sequence numbers restart for each execution. */
  runId?: string;
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * The model that produced this assistant message, as the provider reported
   * it on the transcript row (today: Claude's `message.model`, e.g.
   * `claude-opus-5`). Absent on user turns — no provider records which model a
   * request went out with — and absent when the provider named a placeholder
   * such as `<synthetic>`, so a locally-fabricated notice is never labelled
   * with a model it did not run on.
   */
  model?: string;
  /**
   * Optional display-oriented metadata used by providers that need to expose
   * richer transcript artifacts without introducing a brand-new message kind.
   *
   * Current Claude usage:
   * - local slash commands expose parsed command fields
   * - compact summaries are flagged so the UI can treat them differently later
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  /** Set on the row that stands in for a compaction, so the UI can draw it as one. */
  compact?: CompactionInfo;
  images?: unknown;
  /** Non-image files attached to a user turn after provider history normalization. */
  files?: unknown;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: {
    content?: string;
    isError?: boolean;
    toolUseResult?: unknown;
  };
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  reason?: string;
  newSessionId?: string;
  status?: string;
  summary?: string;
  tokenBudget?: unknown;
  /**
   * Timeline of everything a subagent did, attached to the `tool_use` that
   * spawned it. Present for Claude `Agent`/`Task` calls and Codex
   * `spawn_agent` calls; absent for every other tool.
   */
  subagentTools?: SubagentActivity[];
  /** Identity and lifecycle of the subagent this `tool_use` spawned. */
  subagent?: SubagentInfo;
  /** The workflow run this `tool_use` launched, read from its journal on disk. */
  workflow?: WorkflowInfo;
  /** Stored memory the reply drew on, when the provider reports it. */
  memoryCitations?: MemoryCitation[];
  toolUseResult?: unknown;
  sequence?: number;
  rowid?: number;
  /**
   * `task_status` fields: one lifecycle event of a background task the live
   * run is tracking. `taskId` is the provider's task handle; `toolUseId` names
   * the call that launched it and is absent on `updated`, which the SDK keys by
   * task id alone. `status` and `summary` above carry the event's own.
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
  [key: string]: unknown;
};

/**
 * What a background task has spent so far, as the CLI reports it on
 * `task_progress` and `task_notification`.
 */
export type TaskUsage = {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
};

/**
 * One background task a live session still has outstanding — a spawned
 * agent, a workflow run or a backgrounded command — as the runtime tracks it
 * from the stream's `task_started` until the event that settles it.
 *
 * `taskId` is the handle a stop request names; `toolUseId` is the call that
 * launched it, which is how the client pairs the task with its card.
 * `startedAt` is the server clock at `task_started`, so a session whose turn
 * has ended can still report how long its work has been going.
 */
export type BackgroundTaskSummary = {
  taskId: string;
  toolUseId: string;
  taskType: string;
  description: string;
  workflowName?: string;
  startedAt: number;
  /**
   * The task was launched by a subagent or workflow agent, not by the
   * session's own turn: its `toolUseId` names a call in that agent's
   * transcript, so no card in this session's transcript matches it. Listed so
   * it can still be stopped; not counted as the session's own work.
   */
  nested?: boolean;
};

/**
 * Where one agent of a running workflow stands, as the SDK reports it on the
 * run's `task_progress` events.
 *
 * An entry the script has queued but not yet started has no `agentId` and is
 * identified by `index` alone; once the agent runs, `agentId` names the
 * transcript it writes. `lastToolName` and `lastToolSummary` are the agent's
 * own latest tool call — unlike the event's task-level `last_tool_name`, which
 * for a workflow is the current agent's label.
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

/**
 * One workflow agent's recorded timeline, read from its transcript on demand
 * when the card is opened — the SDK never streams an agent's own rows to the
 * parent session, so this is the only way to see what it did.
 *
 * `activityCount` is the full length of the timeline; `activity` is capped
 * for transport like a subagent's `subagentTools`.
 */
export type WorkflowAgentActivity = {
  agent: {
    id: string;
    label?: string;
    model?: string;
    status: 'running' | 'completed' | 'failed' | 'stopped';
  };
  activity: SubagentActivity[];
  activityCount: number;
};

/**
 * One agent a workflow run spawned, as its journal records it.
 *
 * `label` and `phase` are whatever the script passed when it spawned the
 * agent; older scripts passed neither. An agent with a `started` record and no
 * `result` or `failed` one is still running as far as the journal knows.
 */
export type WorkflowAgentInfo = {
  id: string;
  label?: string;
  phase?: string;
  /** `stopped` is an agent the journal never settled although the run itself has — abandoned by a stop or a resume that re-ran the step. */
  status: 'running' | 'completed' | 'failed' | 'stopped';
};

/**
 * A `Workflow` tool call's run, attached to the `tool_use` that launched it.
 *
 * `status` follows the same rule as a background agent's: the task
 * notification's word when one exists, else `running` only while the process
 * that launched it is still up, else `stopped`. The agent list and counts come
 * from `<transcriptDir>/journal.jsonl`; both are empty when the run left no
 * journal behind (a fork copies only the parent's transcript).
 */
export type WorkflowInfo = {
  runId: string;
  name: string;
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  agents: WorkflowAgentInfo[];
  agentCounts: { total: number; completed: number; failed: number; running: number; stopped: number };
  scriptPath?: string;
};

/**
 * One stored memory an assistant reply drew on.
 *
 * Codex appends these to a reply that used its memory files, naming the file
 * and line range it read plus a short note on what it took from there. The
 * transcript shows them as a footnote so a memory-derived claim is traceable
 * rather than arriving as an unattributed assertion.
 */
export type MemoryCitation = {
  /** File and line range that was read, e.g. `MEMORY.md:137-142`. */
  source: string;
  /** What the reply took from that range, when the provider states it. */
  note?: string;
};

/**
 * One entry in a subagent's recorded timeline.
 *
 * Providers store a subagent's work in a separate transcript (Claude:
 * `<session>/subagents/agent-<id>.jsonl`; Codex: a sibling rollout keyed by
 * `agent_thread_id`). Both are flattened into this shape so the transcript can
 * replay a subagent's run with the same renderers the main thread uses.
 *
 * `kind` decides which fields matter: `tool` uses the tool fields, `text` and
 * `thinking` use `content`. Consumers must not assume tool fields exist on the
 * text kinds.
 */
export type SubagentActivity = {
  kind: 'tool' | 'text' | 'thinking';
  timestamp?: string;
  /** Tool-call identity; only set when `kind` is `tool`. */
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: { content?: string; isError?: boolean } | null;
  /** Message body; only set when `kind` is `text` or `thinking`. */
  content?: string;
};

/**
 * Identity and lifecycle of one spawned subagent, normalized across providers.
 *
 * `status` is `running` until the call that spawned the agent resolves. After
 * that it is whatever the provider reported — Claude's task notification
 * carries one — and `completed` when the provider reported nothing. A failed
 * tool call *inside* the agent is not a failed agent, so it is never inferred
 * from the transcript. A background agent whose session process ended before
 * it reported is `stopped`: no outcome exists and none is coming.
 */
export type SubagentInfo = {
  /** Provider-native agent id — Claude `agentId`, Codex `agent_thread_id`. */
  id: string;
  /** Human-facing label: Claude's agent type, or Codex's assigned nickname. */
  name?: string;
  /** Agent type/preset when the provider records one (Claude `agentType`). */
  type?: string;
  /** One-line task summary shown in the collapsed header. */
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** Model the subagent ran on, when the provider records it. */
  model?: string;
  /**
   * How many activities the agent actually recorded. It exceeds
   * `subagentTools.length` when a long run was truncated for transport, which
   * lets the UI say so instead of silently showing a partial timeline.
   */
  activityCount?: number;
};

/**
 * Output gateway shared by WebSocket and SSE provider runs.
 *
 * Runtime adapters only depend on this structural surface, which keeps them
 * independent from the transport that ultimately delivers normalized events.
 */
export type ProviderRuntimeWriter = {
  send(data: unknown): void;
  setSessionId?(sessionId: string): void;
  userId?: string | number | null;
  isWebSocketWriter?: boolean;
};

export type ProviderPermissionDecision = {
  allow: boolean;
  updatedInput?: unknown;
  message?: string;
  rememberEntry?: unknown;
};

export type ProviderRuntimePermissionGateway = {
  resolve(requestId: string, decision: ProviderPermissionDecision): void;
  listPending(sessionId: string): unknown[];
};

/**
 * Provider-scoped application capabilities supplied to a runtime for one run.
 *
 * Keeping these lookups outside concrete SDK/CLI adapters prevents the
 * adapters from importing services that resolve back through providerRegistry.
 */
export type ProviderRuntimeContext = {
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels(): Promise<ProviderModelsDefinition>;
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[];
  isProviderInstalled(): Promise<boolean>;
  /**
   * Builds the SDK query for a run. Production leaves this unset and the
   * runtime uses the SDK's own; tests supply a scripted stream so the hold
   * and background-work paths can be driven without a CLI process.
   */
  createQuery?: (input: { prompt: AsyncIterable<unknown>; options: AnyRecord }) => AsyncIterable<unknown> & {
    interrupt(): Promise<void>;
    stopTask?(taskId: string): Promise<void>;
  };
};

export type ProviderRunFunction = (
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
) => Promise<unknown>;

/**
 * Shared options used to fetch historical provider messages.
 *
 * Consumers should pass provider-specific lookup hints (`projectPath`) only
 * when the selected provider requires them.
 *
 * `providerSessionId` is the provider-native session id from the sessions
 * index (transcript file name / provider database key). Provider adapters
 * must use it — never the app-facing session id they were called with — when
 * matching transcript rows on disk, because app-created sessions use an
 * app-allocated id that the provider has never seen.
 */
export type FetchHistoryOptions = {
  projectPath?: string;
  limit?: number | null;
  offset?: number;
  providerSessionId?: string;
};

/**
 * Standardized response payload returned from provider history readers.
 *
 * Use this as the contract for APIs that return paginated conversation history.
 */
export type FetchHistoryResult = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number | null;
  tokenUsage?: unknown;
};

// ---------------------------
//----------------- PROVIDER SKILL TYPES ------------
/**
 * Scope where a provider skill definition was discovered.
 *
 * Provider skill adapters should use this to describe the origin of each
 * skill markdown file without leaking provider-specific folder names into route
 * contracts. `repo` is used for Codex repository lookup locations, while
 * `project` is used for providers that treat workspace-local skills as project
 * scoped.
 */
export type ProviderSkillScope = 'user' | 'project' | 'plugin' | 'repo' | 'admin' | 'system';

/**
 * Shared input accepted by provider skill listing operations.
 *
 * Routes pass `workspacePath` when a caller wants project/repository skills for
 * a specific folder. Providers should fall back to the backend process cwd when
 * this option is omitted.
 */
export type ProviderSkillListOptions = {
  workspacePath?: string;
};

/**
 * One supporting file bundled with an uploaded provider skill.
 *
 * `relativePath` is resolved below the installed skill directory and must never
 * be absolute or contain traversal segments. Text files may use `utf8`; binary
 * scripts and assets should use `base64` so JSON transport does not corrupt
 * their bytes.
 */
export type ProviderSkillCreateFile = {
  relativePath: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/**
 * One skill markdown payload submitted for provider-managed installation.
 *
 * `content` is the raw markdown body that will be written to `SKILL.md`.
 * `directoryName` lets callers control the target folder name explicitly when
 * they want stable filesystem paths that differ from the markdown front matter
 * `name` field. `fileName` is optional upload metadata used only as a final
 * fallback when no directory name or front matter name is present. `files`
 * carries scripts, references, and other files from a complete skill folder.
 */
export type ProviderSkillCreateEntry = {
  content: string;
  directoryName?: string;
  fileName?: string;
  files?: ProviderSkillCreateFile[];
};

/**
 * Shared input accepted by provider skill creation operations.
 *
 * The service layer batches multiple skill definitions in one request. Each
 * entry can contain only markdown or a complete skill folder.
 */
export type ProviderSkillCreateInput = {
  entries: ProviderSkillCreateEntry[];
};

export type ProviderSkillRemoveInput = {
  directoryName: string;
};

/**
 * Normalized skill record returned by provider skill adapters.
 *
 * The `command` value is the exact invocation text the selected provider expects
 * for this skill. Claude plugin skills use a namespaced command such as
 * `/plugin-name:skill-name`, while Codex skills use the `$skill-name` form.
 * `sourcePath` points to the skill markdown file that produced the record so
 * callers can distinguish duplicate skill names across scopes.
 */
export type ProviderSkill = {
  provider: LLMProvider;
  name: string;
  description: string;
  command: string;
  scope: ProviderSkillScope;
  sourcePath: string;
  pluginName?: string;
  pluginId?: string;
};

/**
 * Internal source descriptor consumed by shared provider skill discovery logic.
 *
 * Concrete provider adapters build these records from their native lookup rules.
 * The shared skills provider then scans `rootDir` for child skill markdown files
 * and uses `commandForSkill` or `commandPrefix` to produce the provider-specific
 * invocation command. Set `recursive` only when a provider stores skills under
 * arbitrary nested folders below the source root.
 */
export type ProviderSkillSource = {
  scope: ProviderSkillScope;
  rootDir: string;
  recursive?: boolean;
  commandPrefix?: '/' | '$';
  commandForSkill?: (skillName: string) => string;
  pluginName?: string;
  pluginId?: string;
};

// ---------------------------
//----------------- SHARED ERROR TYPES ------------
/**
 * Optional metadata used when constructing application-level errors.
 *
 * `statusCode` should reflect the HTTP response status, while `code` identifies
 * the stable machine-readable error category.
 */
export type AppErrorOptions = {
  code?: string;
  statusCode?: number;
  details?: unknown;
};

// ---------------------------
//----------------- MCP TYPES ------------
/**
 * Scope where an MCP server definition is stored and resolved.
 *
 * `user` is global for a user account, `local` is provider-local, and `project`
 * is tied to a specific project path.
 */
export type McpScope = 'user' | 'local' | 'project';

/**
 * Transport protocol used by an MCP server definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * Normalized MCP server model exposed to frontend and route handlers.
 *
 * Provider adapters should map provider-native config to this structure before
 * returning results.
 */
export type ProviderMcpServer = {
  provider: LLMProvider;
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

/**
 * Payload for create/update MCP server operations.
 *
 * Routes and services should accept this type, validate it, and then persist it
 * through provider-specific MCP repositories.
 */
export type UpsertProviderMcpServerInput = {
  name: string;
  scope?: McpScope;
  transport: McpTransport;
  workspacePath?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  envVars?: string[];
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
};

// ---------------------------
//----------------- PROVIDER AUTH TYPES ------------
/**
 * Records that an API-key style credential is taking precedence over a
 * still-valid subscription login in `~/.claude/.credentials.json`.
 *
 * Claude Code always prefers `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` over
 * the OAuth login written by `claude /login`, so when both exist every request
 * is billed to the key (pay-as-you-go) rather than the subscription — usually
 * without the user realising it. The Claude auth provider fills this in so the
 * settings UI can say which variable won and where it was found; the fix
 * differs per source (unset the variable and restart the server for
 * `process_env`, edit the `env` block of `~/.claude/settings.json` for
 * `settings_file`). It is never set when the login in the credentials file is
 * missing or expired, because then nothing is being bypassed.
 */
export type ProviderAuthSubscriptionOverride = {
  /** The environment variable Claude Code is using instead of the login. */
  variable: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';
  /** Where that variable was found: the server process env or the settings.json env block. */
  source: 'process_env' | 'settings_file';
  /** Email recorded in the credentials file for the bypassed login, when known. */
  subscriptionEmail: string | null;
};

/**
 * Authentication status result returned by provider health checks.
 *
 * This shape is consumed by settings/status endpoints to report installation and
 * credential state for each provider.
 */
export type ProviderAuthStatus = {
  installed: boolean;
  provider: LLMProvider;
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  /**
   * Present only when `method` is `api_key` and a valid subscription login is
   * being bypassed; see ProviderAuthSubscriptionOverride. Omitted otherwise so
   * existing consumers that never look for it are unaffected.
   */
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

// ---------------------------
//----------------- SHARED DATABASE CREDENTIAL TYPES ------------
/**
 * Safe credential view returned by credential listing APIs.
 *
 * This intentionally excludes the raw credential secret while still exposing
 * metadata needed for UI rendering and management operations.
 */
export type CredentialPublicRow = {
  id: number;
  credential_name: string;
  credential_type: string;
  description: string | null;
  created_at: string;
  is_active: number;
};

/**
 * Result returned after creating a credential record.
 *
 * Use this return shape when callers need the created id and display metadata,
 * but must never receive the stored secret value.
 */
export type CreateCredentialResult = {
  id: number | bigint;
  credentialName: string;
  credentialType: string;
};

// ---------------------------
//----------------- PROJECT PERSISTENCE TYPES ------------
/**
 * Canonical project row shape returned by the projects repository.
 *
 * Use this type whenever backend services need to pass around one database
 * project record without leaking raw SQL row typing across modules.
 */
export type ProjectRepositoryRow = {
  project_id: string;
  project_path: string;
  custom_project_name: string | null;
  isStarred: number;
  isArchived: number;
};

/**
 * Result category returned by `projectsDb.createProjectPath`.
 *
 * `created` means a fresh row was inserted, `reactivated_archived` means an
 * existing archived path was accepted and updated, and `active_conflict` means
 * an already-active path blocked project creation.
 */
export type CreateProjectPathOutcome =
  | 'created'
  | 'reactivated_archived'
  | 'active_conflict';

/**
 * Structured result returned by project-path upsert operations.
 *
 * Services should use this result to decide whether a request succeeded,
 * should return a conflict, or needs follow-up retrieval of row metadata.
 */
export type CreateProjectPathResult = {
  outcome: CreateProjectPathOutcome;
  project: ProjectRepositoryRow | null;
};

/**
 * Validation result for user-supplied workspace/project paths.
 *
 * `resolvedPath` is present only when validation succeeds. `error` is present
 * only when validation fails and is suitable for user-facing diagnostics.
 */
export type WorkspacePathValidationResult = {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
};

// ---------------------------
//----------------- GIT COMMAND EXECUTION AND WORKTREE MANAGEMENT ------------
/**
 * Captured output of one completed `git` invocation.
 *
 * Returned by `GitCommandRunner` and `GitProcessRunner` implementations so the
 * git and worktree services can read both streams without caring about
 * process plumbing.
 */
export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Executes `git <args>` inside `cwd` and resolves with the captured output.
 *
 * All worktree services receive their git access through this contract so
 * tests can inject a fake runner instead of spawning real processes. The
 * promise must reject (with `stderr` attached when available) on a non-zero
 * exit code.
 */
export type GitCommandRunner = (args: string[], cwd: string) => Promise<GitCommandResult>;

/**
 * Executes `command args...` inside `options.cwd` and resolves with the captured output.
 *
 * This is the `spawnAsync` shape the Git routes module injects into its typed
 * services (branch deletion, branch compare) so their tests can substitute a
 * fake runner. Like `GitCommandRunner`, the promise must reject on a non-zero
 * exit code, with `stderr` attached to the error when available.
 */
export type GitProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<GitCommandResult>;

/**
 * One entry parsed from `git worktree list --porcelain`.
 *
 * This is the raw repository-level view (path/HEAD/branch/flags) before any
 * enrichment with project links or ahead/behind counts. `branch` is null for
 * detached-HEAD worktrees.
 */
export type WorktreePorcelainEntry = {
  path: string;
  headSha: string | null;
  branch: string | null;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
};

/**
 * Fully enriched worktree row served to the UI.
 *
 * Extends the porcelain entry with everything the Worktrees panel renders:
 * dirty-file count, ahead/behind relative to the base branch (the branch
 * checked out in the main worktree), last-commit metadata, and the CloudCLI
 * project row linked to the worktree directory (if one was registered).
 */
export type WorktreeDescriptor = {
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

/**
 * Response payload of `GET /api/worktrees`.
 *
 * `baseBranch` is the branch checked out in the main worktree — the merge
 * target offered by the UI. `worktrees` always lists the main worktree first.
 */
export type WorktreeListResult = {
  repositoryRoot: string;
  baseBranch: string | null;
  worktrees: WorktreeDescriptor[];
};

// ---------------------------
//----------------- WORKTREE SERVICE INPUTS AND RESULTS ------------
/**
 * Input accepted by the worktree-listing workflow.
 *
 * `projectPath` may point at the main checkout or any linked worktree. The
 * service uses Git to resolve the complete repository-level worktree list.
 */
export type ListWorktreesInput = {
  projectPath: string;
};

/**
 * Input accepted when creating a linked Git worktree.
 *
 * `branch` is checked out when it already exists, otherwise it is created from
 * `baseBranch`. When `baseBranch` is omitted, the main worktree branch is used.
 */
export type CreateWorktreeInput = {
  projectPath: string;
  branch: string;
  baseBranch?: string | null;
};

/**
 * Result of successfully creating a linked Git worktree.
 *
 * `createdBranch` distinguishes a new branch from an existing branch checkout,
 * allowing API clients to accurately describe what Git changed.
 */
export type CreateWorktreeResult = {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
};

/**
 * Result of atomically creating and registering a worktree for project use.
 *
 * The Worktrees application service compensates the Git creation if project
 * registration fails, so routes only receive this shape after both steps pass.
 */
export type CreateAndOpenWorktreeResult = CreateWorktreeResult & {
  project: WorktreeProjectView;
};

/**
 * Input accepted when registering an existing worktree as a CloudCLI project.
 *
 * The service verifies that `worktreePath` belongs to the repository containing
 * `projectPath` before it creates or restores any project record.
 */
export type OpenWorktreeInput = {
  projectPath: string;
  worktreePath: string;
};

/**
 * Project view returned after a worktree is opened in CloudCLI.
 *
 * This deliberately mirrors the project-selection payload used by the Projects
 * module so the frontend can switch to the worktree without another lookup.
 */
export type WorktreeProjectView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  isStarred: boolean;
  sessions: [];
  sessionMeta: { hasMore: false; total: 0 };
};

/**
 * Input accepted when removing a linked Git worktree.
 *
 * `force` permits removal with local changes. `deleteBranch` requests
 * best-effort branch cleanup after the worktree directory is removed.
 */
export type RemoveWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  force?: boolean;
  deleteBranch?: boolean;
};

/**
 * Result of removing a linked Git worktree.
 *
 * `archivalError` reports best-effort project archival failure after Git has
 * already removed the worktree, allowing callers to represent partial success.
 */
export type RemoveWorktreeResult = {
  removedPath: string;
  branch: string | null;
  branchDeleted: boolean;
  archivedProjectId: string | null;
  archivalError: string | null;
};

/**
 * Input accepted when merging a linked worktree into the main worktree branch.
 *
 * The service verifies both worktrees are clean, supports squash and regular
 * merges, and may remove the source worktree after a successful merge.
 */
export type MergeWorktreeInput = {
  projectPath: string;
  worktreePath: string;
  squash?: boolean;
  message?: string | null;
  removeAfterMerge?: boolean;
};

/**
 * Result of a completed worktree merge.
 *
 * `removedWorktree` is populated only when post-merge removal succeeds.
 * `cleanupError` reports failed optional removal without misrepresenting the
 * already-completed merge as a failure.
 */
export type MergeWorktreeResult = {
  mergedBranch: string;
  targetBranch: string;
  squash: boolean;
  removedWorktree: RemoveWorktreeResult | null;
  cleanupError: string | null;
};

// ---------------------------
//----------------- WORKTREE MODULE DEPENDENCY CONTRACTS ------------
/**
 * Filesystem capability required by the Worktrees module.
 *
 * Production wiring checks the real filesystem; unit tests provide a small
 * deterministic fake so worktree creation never touches developer directories.
 */
export type WorktreeFileSystem = {
  pathExists(candidatePath: string): Promise<boolean>;
};

/**
 * Project-management boundary consumed by Worktrees workflows.
 *
 * The Worktrees module uses this contract instead of importing Database or
 * Projects internals. Production adapters delegate through those modules'
 * `index.ts` barrels, while unit tests supply in-memory functions.
 */
export type WorktreeProjectGateway = {
  getProjectPathById(projectId: string): string | null;
  getProjectByPath(projectPath: string): ProjectRepositoryRow | null;
  createProject(input: {
    projectPath: string;
    customName: string;
  }): Promise<{
    outcome: 'created' | 'reactivated_archived';
    project: { projectId: string };
  }>;
  restoreProject(projectId: string): void | Promise<void>;
  archiveProject(projectId: string): void | Promise<void>;
};

/**
 * Complete application-service surface used by the Worktrees HTTP router.
 *
 * Routes parse transport values and call these functions; they do not import
 * repositories, filesystem adapters, Git runners, or individual service files.
 */
export type WorktreeServices = {
  resolveProjectPath(projectId: string): string;
  list(input: ListWorktreesInput): Promise<WorktreeListResult>;
  create(input: CreateWorktreeInput): Promise<CreateWorktreeResult>;
  createAndOpen(input: CreateWorktreeInput): Promise<CreateAndOpenWorktreeResult>;
  open(input: OpenWorktreeInput): Promise<WorktreeProjectView>;
  merge(input: MergeWorktreeInput): Promise<MergeWorktreeResult>;
  remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeResult>;
};

// ---------------------------
//----------------- FILE TREE MODULE CONTRACTS ------------
/**
 * One filesystem item returned by the File Tree API.
 *
 * The service populates metadata without following symlinks and recursively
 * attaches `children` only while the requested depth permits traversal. The
 * frontend uses the absolute `path` as the stable identifier for editor and
 * file-operation requests.
 */
export type FileTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string | null;
  permissions: string;
  permissionsRwx: string;
  isSymlink?: boolean;
  children?: FileTreeNode[];
};

/**
 * Minimal directory-entry shape required during File Tree traversal.
 *
 * Production adapts Node `Dirent` objects to this structural contract. Tests
 * provide small handwritten entries and therefore never read real directories.
 */
export type FileTreeDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

/**
 * Minimal file-stat shape used for tree metadata and delete decisions.
 *
 * The numeric mode is converted to octal and rwx strings for the UI. `lstat`
 * supplies symlink state while `stat` is used when deciding file versus folder
 * deletion behavior.
 */
export type FileTreeStats = {
  size: number;
  mtime: Date;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Complete filesystem capability injected into File Tree services.
 *
 * The production composition root delegates these operations to Node's fs
 * APIs. Unit tests provide deterministic path-keyed fakes so service tests
 * cannot inspect, write, rename, or delete developer files.
 */
export type FileTreeFileSystem = {
  access(candidatePath: string): Promise<void>;
  stat(candidatePath: string): Promise<FileTreeStats>;
  lstat(candidatePath: string): Promise<FileTreeStats>;
  // Streamed rather than returned as an array so a directory with millions of
  // children is abandoned at the entry limit instead of being materialized.
  openDirectory(directoryPath: string): AsyncIterable<FileTreeDirectoryEntry>;
  realpath(candidatePath: string): Promise<string>;
  readTextFile(filePath: string): Promise<string>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  makeDirectory(directoryPath: string, recursive: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  removeDirectory(directoryPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string): Promise<void>;
  createReadStream(filePath: string): Readable;
};

/**
 * Project lookup boundary consumed by File Tree workflows.
 *
 * File Tree services resolve DB-assigned project ids through this contract and
 * never import the Database module or its repositories directly.
 */
export type FileTreeProjectGateway = {
  getProjectPathById(projectId: string): string | null | Promise<string | null>;
};

/**
 * Workspace validation boundary used by filesystem browsing and folder creation.
 *
 * The injected validator enforces the configured workspace root and resolves
 * symlinks before the File Tree service exposes or mutates paths.
 */
export type FileTreeWorkspaceGateway = {
  rootPath: string;
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
  /**
   * Resolves a path readable outside the workspace root — the system temp
   * directory and the Claude projects directory — or `null` when it is not
   * one. Read-only: the write policy is `validatePath` and it does not consult
   * this.
   */
  resolveReadOnlyRootPath(candidatePath: string): Promise<string | null>;
};

/**
 * Uploaded-file record passed from the Multer transport adapter into the File
 * Tree service.
 *
 * Transport-specific field names are normalized so upload workflows do not
 * depend on Express or Multer types.
 */
export type FileTreeUploadedFile = {
  originalName: string;
  temporaryPath: string;
  size: number;
  mimeType: string;
};

/**
 * Logger boundary for expected File Tree diagnostics.
 *
 * Production delegates to the server console. Unit tests use no-op or captured
 * loggers and never patch the global console singleton.
 */
export type FileTreeLogger = {
  error(message: string, error?: unknown): void;
};

/**
 * Required production dependencies for the File Tree application service.
 *
 * Filesystem, project lookup, workspace policy, MIME detection, concurrency,
 * and logging are all explicit so service construction has no hidden process,
 * repository, or machine-wide defaults.
 */
export type FileTreeServiceDependencies = {
  fileSystem: FileTreeFileSystem;
  projects: FileTreeProjectGateway;
  workspace: FileTreeWorkspaceGateway;
  resolveMimeType(filePath: string): string;
  fileSystemConcurrency: number;
  logger: FileTreeLogger;
};

/**
 * Complete File Tree application-service surface consumed by HTTP routes.
 *
 * Routes parse transport inputs and call these methods; they never resolve
 * project repositories, validate filesystem ownership, or perform filesystem
 * mutations themselves.
 */
export type FileTreeServices = {
  browseWorkspace(inputPath: string | null): Promise<{
    path: string;
    suggestions: Array<{ path: string; name: string; type: 'directory' }>;
  }>;
  createWorkspaceFolder(folderPath: string): Promise<{ success: true; path: string }>;
  readTextFile(projectId: string, filePath: string): Promise<{ content: string; path: string }>;
  openFile(projectId: string, filePath: string): Promise<{ contentType: string; stream: Readable }>;
  saveTextFile(projectId: string, filePath: string, content: string): Promise<{
    success: true;
    path: string;
    message: string;
  }>;
  listProjectFiles(
    projectId: string,
    options?: { respectGitignore: boolean },
  ): Promise<FileTreeNode[]>;
  createEntry(input: {
    projectId: string;
    parentPath: string;
    type: 'file' | 'directory';
    name: string;
  }): Promise<{ success: true; path: string; name: string; type: 'file' | 'directory'; message: string }>;
  renameEntry(input: { projectId: string; oldPath: string; newName: string }): Promise<{
    success: true;
    oldPath: string;
    newPath: string;
    newName: string;
    message: string;
  }>;
  deleteEntry(input: { projectId: string; targetPath: string }): Promise<{
    success: true;
    path: string;
    type: 'file' | 'directory';
    message: string;
  }>;
  storeUploadedFiles(input: {
    projectId: string;
    targetPath: string;
    relativePaths: string[];
    requestedFileCount: number;
    files: FileTreeUploadedFile[];
  }): Promise<{
    success: true;
    files: Array<{ name: string; path: string; size: number; mimeType: string }>;
    uploadedCount: number;
    requestedFileCount: number;
    targetPath: string;
    message: string;
  }>;
};

// ---------------------------
//----------------- VOICE MODULE CONTRACTS ------------
/**
 * Per-request voice settings parsed from authenticated HTTP headers.
 *
 * The Voice routes create this value from the optional `x-voice-*` headers and
 * pass it to the Voice service. Empty values mean "use the server-configured
 * default"; the backend base URL is intentionally absent because clients must
 * never control the server's outbound destination.
 */
export type VoiceRequestOverrides = {
  apiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
};

/**
 * Uploaded audio accepted by the Voice transcription service.
 *
 * Routes translate Multer's transport-specific file object into this minimal
 * shape so the service does not depend on Express or Multer types.
 */
export type VoiceAudioUpload = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

/**
 * Successful speech payload returned by the Voice service.
 *
 * The route copies `contentType` to the client response and pipes `body`
 * without buffering the complete synthesized audio in application memory.
 */
export type VoiceSpeechPayload = {
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
};

/**
 * Explicit service result used by Voice routes instead of transport-aware
 * exceptions.
 *
 * Services return `ok: false` with the exact client status/message for expected
 * backend, validation, and timeout failures. Routes only translate the result
 * into HTTP output, while unexpected programming errors still reject normally.
 */
export type VoiceServiceResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; status: number; error: string };

/**
 * Complete application-service surface consumed by the Voice HTTP router.
 *
 * The composition root supplies a concrete implementation with environment
 * configuration and an injected outbound HTTP adapter. Unit tests use the same
 * contract with handwritten fetch fakes and never patch global state.
 */
export type VoiceService = {
  getHealth(): { configured: boolean };
  transcribe(input: {
    audio: VoiceAudioUpload;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<{ text: string }>>;
  synthesizeSpeech(input: {
    text: string;
    overrides: VoiceRequestOverrides;
  }): Promise<VoiceServiceResult<VoiceSpeechPayload>>;
};

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};

// ---------------------------
//----------------- STUDIO PROJECT CONTRACTS ------------
/** A coding agent that runs inside the inherited IDE, in the project's own directory. */
export type StudioAgentProvider = 'claude' | 'codex' | 'cursor' | 'opencode';

/** Any model a project can enable: the IDE agents plus Studio's own DeepSeek API chat. */
export type StudioProjectProvider = StudioAgentProvider | 'deepseek';

/** Optional tools a project shows as tabs; integrations only appear when enabled. */
export type StudioProjectModule = 'agents' | 'mail' | 'automations' | 'snr-lab' | 'trading212';

/** A quick-browse button on a project, opened in a new tab (or embedded when the site allows it). */
export type StudioProjectLink = { label: string; url: string };

/** Editable project metadata consumed by the Studio project router and service; one project is one home-screen icon. */
export type StudioProjectInput = {
  name: string;
  description: string;
  workspacePath: string;
  modules: StudioProjectModule[];
  providers: StudioProjectProvider[];
  // Home-screen icon colour family and glyph, chosen from fixed lists.
  tone: string;
  glyph: string;
  // Website quick-browse buttons (http/https only).
  links: StudioProjectLink[];
  // Name of a configured SSH host (STUDIO_SSH_HOSTS) when agents run remotely; empty runs them on this machine.
  remoteHost: string;
  // Working directory on the remote host, e.g. ~/projects/super-professor.
  remoteDir: string;
};

/** An SSH host Studio may open agent sessions on; configured by the server owner, never by the browser. */
export type StudioRemoteHost = { name: string; label: string; target: string };

/** Reachability and installed tools of a remote host, checked read-only over SSH. */
export type StudioRemoteStatus = {
  name: string; online: boolean; latencyMs: number | null; checkedAt: string;
  tools: { claude: boolean; codex: boolean; tmux: boolean };
  error?: string;
};

/** A remote agent session: the exact command the terminal runs, built by the server from validated config. */
export type StudioRemoteLaunch = { command: string; title: string };

/** Live check of a project link: whether it answers and whether it can be shown in an iframe. */
export type StudioLinkStatus = { url: string; ok: boolean; status: number | null; latencyMs: number | null; frameable: boolean };

/**
 * One usage window of a model plan, e.g. the 5-hour or weekly limit. `id` is stable across reads (the
 * client keys the owner's show/hide choice on it). `model` is present only on a window that applies to
 * one model or limit (Claude's weekly Opus or Fable window, Codex's gpt-reserve bucket); plan-wide
 * windows leave it out.
 */
export type StudioQuotaWindow = { id: string; label: string; usedPercent: number; windowMinutes: number | null; resetsAt: string | null; model?: string };

/**
 * A credit allowance on a Claude account, read from Claude's usage API: the one-time Claude Code and
 * Cowork (cloud session) credit, or the monthly extra-usage spend limit. Amounts are in major units of
 * `currency` (dollars, not cents) and null when the API gave none; `limit` null on extra usage means
 * no monthly cap. `endsAt` is when a one-time credit expires (`endKind: 'expires'`) or the allowance
 * starts over (`'resets'`).
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
 * `usage-api` is Claude's account usage read live with the machine's Claude login (what `/usage` shows);
 * `statusline` and `sdk-event` are Claude snapshots written while Claude was in use. `credits` is only
 * filled for Claude from the usage API, and left out when there are none.
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

/** Persisted, user-owned project returned to the Studio UI, with no credentials or provider tokens. */
export type StudioProjectRecord = StudioProjectInput & { id: string; updatedAt: string };

/** An automation draft passed from the Studio router to its service. Saving does not execute or schedule a task. */
export type StudioTaskInput = { title: string; prompt: string; provider: StudioAgentProvider };

// ── v4 track: network — server types below this line ──
//----------------- STUDIO INGRESS TYPES ------------
/**
 * One of the two front doors to the single Studio backend on the owner's laptop.
 * `public` is the owner's domain (STUDIO_PUBLIC_ORIGIN, e.g. https://studio.ajarche.com) reached
 * through a Cloudflare Tunnel; `tailnet` is Tailscale Serve on the laptop (STUDIO_TAILNET_ORIGIN)
 * reached over AJ's tailnet, optionally through an exit node. Both proxy to the same process and
 * database, so the id only says how a request arrived, never which data it sees.
 */
export type StudioIngressId = 'public' | 'tailnet';

/**
 * The configured origins of both front doors, as read by readStudioIngressOrigins.
 * Each origin is normalised to `URL.origin` (no trailing slash, default port dropped) so it can be
 * compared with a browser's Origin header by string equality; `null` means unset or invalid.
 * `invalid` lists doors whose variable is set but is not a bare http(s) origin, so callers can
 * fail closed and explain the misconfiguration instead of silently treating it as unset.
 */
export type StudioIngressOrigins = {
  public: string | null;
  tailnet: string | null;
  invalid: StudioIngressId[];
};

/**
 * Who sent a request, as the auth module's throttles, lockout and log and the request-guard rate
 * limiter count it. Built by the auth module's readRequestClient from the socket and headers;
 * consumed by the auth service, the handoff code store, the passkey ceremonies, the security event
 * log and the request-guard module (token buckets, in-flight and WebSocket caps).
 * - `door: 'cloudflare'`: the public tunnel door. With STUDIO_CLOUDFLARED_PORT set, exactly the
 *   connections that arrived on that loopback port; without it, a loopback request carrying
 *   Cloudflare's edge headers and no sign of Tailscale Serve. `address` is CF-Connecting-IP.
 * - `door: 'tailnet'`: Tailscale Serve on this machine (loopback socket, *.ts.net Host, exactly one
 *   tailnet address in X-Forwarded-For); `address` is that tailnet peer.
 * - `door: 'direct'`: everything else (local programs, LAN, a request whose proxy headers do not
 *   add up); `address` is the raw socket peer, so nobody picks another client's bucket by
 *   forging CF-Connecting-IP.
 * Public and direct IPv6 addresses are keyed by their /64 (written "2001:db8:1:2::/64"), so a
 * client rotating through its own prefix stays one client. Every limit also keeps a separate total
 * per door, so public traffic can never use up the budget of the tailnet door. `address` is
 * 'unknown' when the value is missing; it is only a bucket key, never trusted for authentication.
 */
export type StudioRequestClient = {
  door: 'cloudflare' | 'tailnet' | 'direct';
  address: string;
};

/**
 * What "退出所有设备" took away besides the token version, so Settings can say so. Each
 * listener of the auth module's onSessionsRevoked returns the parts it handled (the server
 * entrypoint: open WebSockets, API keys, SNR gateway cookies, Web Push subscriptions); the auth
 * module adds the pending
 * handoff codes and merges them into the response of POST /api/auth/security/revoke-all.
 */
export type StudioSessionRevocation = {
  webSockets?: number;
  apiKeys?: number;
  snrAccess?: number;
  pushSubscriptions?: number;
  handoffCodes?: number;
};

/**
 * Optional server-side check of Cloudflare Access (docs/network.md), as read by
 * readCloudflareAccessConfig from STUDIO_CF_ACCESS_TEAM_DOMAIN and STUDIO_CF_ACCESS_AUD.
 * - `off`: both unset; requests through Cloudflare are not checked by Studio.
 * - `invalid`: only one is set or a value is malformed; `problem` explains it in Chinese for the
 *   Settings screen. Callers fail closed: every request through Cloudflare is refused.
 * - `on`: every request through Cloudflare must carry a Cf-Access-Jwt-Assertion signed (RS256) by a
 *   key from `certsUrl`, issued by `issuer`, for one of the `audience` tags, and not expired.
 * Used by the auth module (the Access gate) and the Studio network endpoint (guidance).
 */
export type StudioCloudflareAccessConfig =
  | { status: 'off' }
  | { status: 'invalid'; problem: string }
  | { status: 'on'; teamDomain: string; issuer: string; certsUrl: string; audience: string[] };
// ---------------------------
// ── v4 track: orders — server types below this line ──
//----------------- STUDIO TRADING 212 ORDERS ------------
/**
 * Trading 212 account an order targets. Live and demo use separate key files, and
 * STUDIO_T212_TRADING decides which of them may trade at all.
 */
export type StudioT212Environment = 'live' | 'demo';

/**
 * An order request after the Studio router validated its transport shape (types, enums,
 * decimal places). `quantity` is always positive; `side` decides the sign sent to Trading 212.
 * `limitPrice` is present exactly when `type` is 'limit'. Business checks (holdings, the
 * per-order cap, allowed environments) are the orders service's job, not the router's.
 */
export type StudioT212OrderInput = {
  env: StudioT212Environment;
  ticker: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  limitPrice?: number;
  timeValidity: 'DAY' | 'GOOD_TILL_CANCEL';
};

/**
 * The browser origin a trading or passkey request came from, after the orders service matched
 * it against the configured origins. `rpId` is its hostname and doubles as the WebAuthn RP ID,
 * so passkeys registered on one domain never authorize orders on another.
 */
export type StudioT212TrustedOrigin = { origin: string; rpId: string };

/**
 * New order caps for one Trading 212 account, in that account's currency, after the Studio router checked
 * the transport shape (finite, positive, at most two decimals). `dailyLimit` is a rolling 24-hour cap on
 * placed and unknown-outcome orders. The ceiling (STUDIO_T212_CAP_CEILING), per-order ≤ daily and whether
 * the change is a raise (which needs a passkey) are checked by the caps service, not the router.
 * Used by trading212-orders.routes, trading212-orders.service and trading212-caps.service.
 */
export type StudioT212CapsInput = { env: StudioT212Environment; maxOrderValue: number; dailyLimit: number };

/**
 * A PUT /caps request as the Studio router read it. `challengeId` is the string the body named for a raise (cut to
 * 64 characters; '' when it was not a string or an assertion came without one) and is absent for a plain lowering.
 * It is read before anything else so the caps service can spend that challenge and audit the attempt even when the
 * rest of the body is malformed: then the request carries `invalid` (why) instead of the parsed caps. A raise carries
 * the browser's WebAuthn assertion, verified cryptographically by the service against the stored passkey.
 * Used by trading212-orders.routes, trading212-orders.service and trading212-caps.service.
 */
export type StudioT212CapsRequest = { challengeId?: string } & (
  | { input: StudioT212CapsInput; assertion?: AuthenticationResponseJSON }
  | { invalid: string }
);
// ── v4 track: mail — server types below this line ──
//----------------- STUDIO MAIL CONTRACTS ------------
/**
 * A message body exactly as a mail adapter (Gmail IMAP, Outlook Graph, legacy Gmail OAuth) delivered it.
 *
 * `html` bodies must never reach the browser as markup: the Studio mail service reduces both kinds to
 * capped plain text. The content is untrusted third-party data and is never sent to a model automatically.
 */
export type StudioMailRawBody = { kind: 'text' | 'html'; content: string };

/**
 * One message as an adapter read it, before the mail service cleans and caps it.
 *
 * Used by the Gmail IMAP and Outlook adapters and by the mail service. `id` is adapter-specific and must be
 * accepted back by the same adapter's `read`; `date` is ISO-8601 or empty; `body` is the preview part for
 * listings and the whole (size-capped) body for a single message; `truncated` reports a size cap was hit.
 */
export type StudioMailRawMessage = {
  id: string;
  subject: string;
  from: string;
  fromAddress: string;
  to: string;
  date: string;
  unread: boolean;
  body: StudioMailRawBody;
  truncated: boolean;
};

/**
 * The Microsoft identity platform tokens for one Outlook mail account.
 *
 * Produced by the Outlook Graph adapter (device-code sign-in and refresh) and stored by the mail service
 * only inside its AES-256-GCM encrypted account secret; never logged or sent to the browser.
 * `expiresAt` is the access token's expiry in epoch milliseconds. Microsoft rotates `refreshToken`, so the
 * newest one must always replace the stored one.
 */
export type StudioOutlookTokens = { accessToken: string; refreshToken: string; expiresAt: number };

// ── v6 track: shell — server types below this line ──
/**
 * Links one Studio hub project to the IDE project registered for its directory, so the workbench
 * (/work/:projectId) can show the hub project's icon and DeepSeek space and the project app can link
 * existing sessions straight to /work/:projectId/s/:sessionId. `projectId` is null while the directory has
 * no IDE project yet (one is registered on the first launch) or no longer exists: the lookup never creates
 * a project. Remote projects (agents on an SSH host) have no local directory and are never listed.
 */
export type StudioWorkbenchHubLink = { hubId: string; projectId: string | null };
// ── v6 track: chat — server types below this line ──
// ── v6 track: github — server types below this line ──
//----------------- STUDIO GITHUB (gh CLI) ------------
/**
 * The subset of `node:child_process` execFile that the Studio GitHub module uses to run `gh`.
 *
 * Used by the gh runner (studio/github/github-cli.adapter) and injected through its dependencies, so tests pass
 * a fake that records the exact argv and never spawns a process. `file` is the gh binary and `args` the
 * complete argv: nothing is ever handed to a shell, so no argument is parsed for shell syntax. The error is
 * the structural part of Node's ExecFileException the runner reads (ENOENT, exit code, timeout kill).
 */
export type StudioGhExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean; encoding: 'utf8' },
  callback: (
    error: (Error & { code?: string | number | null; killed?: boolean; signal?: NodeJS.Signals | null }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

/**
 * The outcome of one `gh` invocation, as the gh runner reports it (it never rejects).
 *
 * `missing`: the binary was not found (ENOENT). `timeout`: killed after its time limit, so a write such as a
 * merge may or may not have happened. `busy`: the runner's queue was full and the command never started.
 * `failed`: gh ran and exited non-zero; `stderr` (and `stdout`, which `gh api` fills with the JSON error body)
 * are raw and may contain anything gh printed, so callers must redact and shorten them before showing them.
 */
export type StudioGhResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'missing' | 'timeout' | 'busy' | 'failed'; stdout: string; stderr: string; exitCode: number | null };

/**
 * Runs gh with an exact argv under the runner's concurrency limit; created by createGhRunner and consumed by the
 * GitHub service. `timeoutMs` kills the process when exceeded; `maxBuffer` caps stdout/stderr (default 8 MiB).
 * Arguments must already be validated: the runner does not inspect them.
 */
export type StudioGhRun = (args: string[], options: { timeoutMs: number; maxBuffer?: number }) => Promise<StudioGhResult>;
// ---------------------------
// ── v6 track: builder — server types below this line ──
//----------------- STUDIO AI BUILD TYPES ------------
/**
 * Lifecycle of one App Store-style AI build.
 *
 * `queued` waits for a free build slot (STUDIO_BUILDS_MAX_PARALLEL), `building` has a Claude Code turn running,
 * `done` ended with a successful turn, and `failed` covers errors, interruptions and explicit cancellation (the
 * record's `error` says which). A failed or done build can be continued, which returns it to `queued`.
 */
export type StudioBuildState = 'queued' | 'building' | 'done' | 'failed';

/**
 * A new AI build as POST /api/studio/builds receives it: the home-screen name and icon (validated by the project
 * hub against its tone and glyph lists) and the owner's description of what to build (1–8000 characters).
 */
export type StudioBuildInput = { name: string; tone: string; glyph: string; prompt: string };

/**
 * One step of a build's plan as the agent's latest checklist states it.
 *
 * Read from Claude's `TodoWrite` input, or from its incremental `TaskCreate`/`TaskUpdate` calls once
 * `prepareTranscriptMessages` has folded them into the same snapshot shape. Any status other than
 * `in_progress` or `completed` is reported as `pending`.
 */
export type StudioBuildTodo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string };

/**
 * A build as the builds service stores it and the `/api/studio/builds` routes return it.
 *
 * `hubProjectId` is the home-screen project, `ideProjectId` + `sessionId` address the workbench session that does
 * the work (`/work/:ideProjectId/s/:sessionId`). `total`/`completed`/`currentTask` mirror the latest checklist;
 * timestamps are ISO-8601. The owning user id is never part of the record.
 */
export type StudioBuildRecord = {
  id: string;
  hubProjectId: string;
  ideProjectId: string;
  sessionId: string;
  workspacePath: string;
  state: StudioBuildState;
  total: number;
  completed: number;
  currentTask: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

/**
 * How one build turn ended, as the build runner reports it to the builds service.
 *
 * `started` is false when the turn never reached the provider (deleted session, busy session, missing runtime);
 * `success` is true only for a turn that completed normally and was not aborted. `error` is a short,
 * already-sanitised reason suitable for the owner, or null.
 */
export type StudioBuildOutcome = { started: boolean; success: boolean; error: string | null };

/**
 * A run of a build's session as the chat run registry currently sees it, including runs started elsewhere (the
 * owner continuing in the workbench). `startedAt` is epoch milliseconds; `success` is null while running;
 * `todos` is the run's latest checklist, or null when the run has not planned yet.
 */
export type StudioBuildRunSnapshot = { running: boolean; startedAt: number; success: boolean | null; todos: StudioBuildTodo[] | null };

/**
 * How unattended builds run on this server right now (GET /api/studio/builds/environment, and the brief each
 * build turn is given).
 *
 * `sandbox`: Bash runs inside Claude Code's OS sandbox (bubblewrap + socat on Linux, Seatbelt on macOS), which
 * lets the agent write only its build folder and reach only package registries, so it may install, run and test.
 * Opt-in: only STUDIO_BUILD_SANDBOX=on turns it on, after the owner has checked it on the machine.
 * `restricted` (the default): the agent gets the file tools inside its folder and a fixed set of plain commands,
 * and can neither install nor run code.
 * `available` says whether the OS sandbox could run here (whatever the mode), and `missing` names the packages to
 * install for it (empty on macOS, on platforms without a sandbox, and once installed).
 */
export type StudioBuildEnvironment = { mode: 'sandbox' | 'restricted'; missing: string[]; available: boolean };

/**
 * The seam between the builds service and the agent runtime.
 *
 * Implemented in production by the Studio build runner (Claude Code through `runDetachedChatTurn`, with the
 * unattended permission policy) and by fakes in tests. `start` resolves once the turn ends — at its terminal
 * `complete` event, or when the run settles without one — and reports checklist changes through `onChecklist`
 * while it runs. `inspect`, `readChecklist` and `environment` never start anything.
 */
export type StudioBuildRunner = {
  start(input: {
    sessionId: string;
    userId: number;
    content: string;
    workspacePath: string;
    onChecklist: (todos: StudioBuildTodo[]) => void;
  }): Promise<StudioBuildOutcome>;
  abort(sessionId: string): Promise<boolean>;
  inspect(sessionId: string): StudioBuildRunSnapshot | null;
  readChecklist(sessionId: string): Promise<StudioBuildTodo[] | null>;
  // The isolation the next turn would get; read on every call so installing bubblewrap and socat takes effect.
  environment(): StudioBuildEnvironment;
};
// ---------------------------
// ── v6 track: memory — server types below this line ──
//----------------- STUDIO SHARED MEMORY (basic-memory MCP) ------------
/**
 * The calls the Studio memory service makes on its MCP session with the shared basic-memory server.
 *
 * Implemented by the streamable-HTTP adapter (studio/memory/memory-client.adapter.ts) and by fakes in tests.
 * `call` resolves to the tool's decoded result (its `structuredContent.result`, else the JSON text, else the
 * raw text). Both methods reject with an AppError: `MEMORY_UNAVAILABLE` (503) when the server cannot be
 * reached, `MEMORY_TOOL_ERROR` (502) when a tool reports an error, `MEMORY_TIMEOUT` (504) when a connected
 * server answers too slowly (the server is not marked down for that; after two initialize timeouts in a row the
 * adapter fails fast with MEMORY_TIMEOUT for a few seconds instead of waiting again). An aborted `signal` rejects with the
 * abort reason instead and never marks the server as down.
 */
export type StudioMemoryToolCaller = {
  call(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  ping(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
};

/**
 * Which agent wrote a shared-memory note, taken from the note's frontmatter tags (or `source`).
 * The conventions ask Claude Code and Codex to tag their notes; Studio tags DeepSeek's notes itself.
 */
export type StudioMemorySource = 'claude' | 'codex' | 'deepseek';

/**
 * One note in a memory listing or search result, as the memory routes send it to the browser.
 * `id` is the basic-memory permalink (e.g. `studio/agent-cloud-studio/部署`) and the only identifier the
 * routes accept back. `folder` is the first path segment: a project folder or `global`. `updatedAt` is
 * ISO-8601 or null; `snippet` is plain text (empty for recent-notes listings).
 */
export type StudioMemoryNoteSummary = {
  id: string;
  title: string;
  folder: string;
  source: StudioMemorySource | null;
  updatedAt: string | null;
  snippet: string;
};

/**
 * An opened note: its Markdown body without frontmatter, capped in size (`truncated` reports the cap).
 * The body was written by a model or a person and is untrusted: render it as escaped Markdown only.
 */
export type StudioMemoryNoteDetail = StudioMemoryNoteSummary & { content: string; tags: string[]; truncated: boolean };

/**
 * A top-level folder of the memory project, with the Studio hub project whose workspace it belongs to
 * (matched by folder name) so the 记忆 app can show that project's icon; null for `global` and others.
 */
export type StudioMemoryFolder = {
  name: string;
  project: { id: string; name: string; tone: string; glyph: string } | null;
};

/**
 * One agent installation the memory status reports: Claude Code or Codex inside WSL (the Linux home Studio runs
 * in) or on Windows (the desktop apps' configs under C:\Users\<name>, read from WSL through /mnt/c).
 */
export type StudioMemoryAgentId = 'claude-wsl' | 'codex-wsl' | 'claude-windows' | 'codex-windows';

/**
 * The one step that wires an agent to the shared memory: where to run it (a short Chinese phrase such as
 * 「在 WSL 的仓库目录运行」) and the exact command. Shown verbatim on the status card.
 */
export type StudioMemoryAgentFix = { where: string; command: string };

/**
 * A setting that keeps an agent from using the shared server even when its config names it, as the memory status
 * reports it (the 记忆 app shows it instead of 「已接入」):
 * - 'invalid-config': the config does not parse (JSON for Claude Code; TOML for Codex, e.g. a duplicated table), so
 *   the agent loads none of it.
 * - 'disabled': Codex has `enabled = false` on the entry, or a Claude Code project lists it in `disabledMcpServers`.
 * - 'project-override': a Claude Code project declares its own `studio-memory` that is not the shared server.
 * - 'ipv6-loopback': the URL uses `[::1]`, which the server (listening on 127.0.0.1 only) never answers.
 */
export type StudioMemoryAgentIssue = 'invalid-config' | 'disabled' | 'project-override' | 'ipv6-loopback';

/**
 * How one agent installation is wired, read from its own config files (only presence and the URL; nothing is
 * printed). Claude Code: the user-scope `mcpServers` of `.claude.json` and the delimited block in
 * `.claude/CLAUDE.md`; Codex: `[mcp_servers.studio-memory]` in `.codex/config.toml` and the block in
 * `.codex/AGENTS.md`.
 * - `installed`: the agent's config or config directory exists; an absent agent is not a fault.
 * - `registered`/`transport`: a `studio-memory` entry exists, over 'http', 'stdio' (its own process) or another type.
 * - `shared`: registered over HTTP at the URL Studio uses, i.e. the one shared server (localhost = 127.0.0.1).
 * - `conventions`: the current usage rules (the whole block, untrusted-data rule included) are between the markers
 *   in that agent's global instructions.
 * - `issue`: a setting that keeps the agent from using the server anyway (see StudioMemoryAgentIssue), or null.
 * - `config`: where the registration lives, as the owner finds it (`~/.claude.json`, `C:\Users\…\.codex\config.toml`).
 * - `fix`: the step that completes the wiring, or null when the agent is wired, not installed, or only fixable by
 *   hand (an `issue` other than 'ipv6-loopback').
 */
export type StudioMemoryAgentStatus = {
  id: StudioMemoryAgentId;
  installed: boolean;
  registered: boolean;
  transport: string | null;
  shared: boolean;
  conventions: boolean;
  issue: StudioMemoryAgentIssue | null;
  config: string;
  fix: StudioMemoryAgentFix | null;
};

/**
 * GET /api/studio/memory/status: whether the shared server answers (`slow`: it accepted the connection but did
 * not answer the ping in time, so `reachable` is false without the server being stopped), where its notes live,
 * and how each agent is wired: the WSL Claude Code and Codex always, the Windows ones when Studio runs under WSL
 * and finds the Windows home. `deepseek` is Studio's own bridge (STUDIO_MEMORY_DEEPSEEK); it only works while the
 * server is reachable.
 */
export type StudioMemoryStatus = {
  reachable: boolean;
  slow: boolean;
  url: string;
  project: string | null;
  notesPath: string | null;
  agents: StudioMemoryAgentStatus[];
  deepseek: { enabled: boolean };
};

//----------------- STUDIO DEEPSEEK CHAT WIRE SHAPES ------------
/**
 * A function call DeepSeek asked for (OpenAI-compatible chat completions). `arguments` is a JSON string the
 * model wrote; it is untrusted and must be parsed and validated before use.
 */
export type StudioDeepseekToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/**
 * One chat-completions message as Studio sends it to and reads it from DeepSeek. `tool_calls` only appears on
 * assistant messages, `tool_call_id` only on tool results; `reasoning_content` is echoed back on assistant
 * messages inside a tool loop because thinking models require it there.
 */
export type StudioDeepseekMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: StudioDeepseekToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
};

/** A function tool offered to DeepSeek; `parameters` is a JSON Schema object. */
export type StudioDeepseekTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/**
 * One DeepSeek completion request made by the Studio service (model, limits, key and timeouts are its
 * business). Resolves to the first choice's message, or null when DeepSeek returned none; rejects with an
 * AppError for HTTP failures.
 */
export type StudioDeepseekCompletion = (body: {
  messages: StudioDeepseekMessage[];
  tools?: StudioDeepseekTool[];
  tool_choice?: 'auto' | 'none';
}) => Promise<StudioDeepseekMessage | null>;

/**
 * The shared-memory bridge the Studio service hands each DeepSeek reply to (studio/memory/memory-chat.service.ts).
 * It adds relevant notes to the system prompt as framed, untrusted background data, offers note tools in a
 * bounded loop through `complete`, and resolves to the final assistant text (null when there is none). When the
 * memory server is down it degrades to one plain completion; it only rejects with errors from `complete` or
 * an aborted `signal`.
 */
export type StudioDeepseekMemoryBridge = {
  reply(input: {
    userId: number;
    // The conversation space ('deepseek' or 'project:<id>'), which decides the memory folder.
    space: string;
    // The user's new message, used as the memory search.
    query: string;
    // Studio's own system prompt; the bridge appends the memory context to it.
    system: string;
    // Prior turns plus the new user message, without a system message.
    messages: StudioDeepseekMessage[];
    complete: StudioDeepseekCompletion;
    signal: AbortSignal;
  }): Promise<string | null>;
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

//----------------- DURABLE TASK EXECUTION ------------
/**
 * A persisted execution receipt shared by WebSocket, Database, and Task Recovery.
 * Accepted/running receipts become interrupted on startup; they never replay automatically.
 * Failed and interrupted receipts remain available for explicit recovery until acknowledged or claimed.
 * User ids are normalized to strings; null is reserved for internal system work. Options
 * include composer preferences and attachment descriptors only, never runtime credentials.
 */
export type TaskRunRecord = {
  runId: string;
  requestId: string;
  userId: string | null;
  sessionId: string;
  provider: string;
  projectPath: string | null;
  content: string;
  options: Record<string, unknown>;
  source: 'interactive' | 'queued' | 'scheduled';
  recoveryOfRunId: string | null;
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  interruptedAt: string | null;
  resolvedAt: string | null;
  claimedByRunId: string | null;
  error: string | null;
};

/**
 * Filters shared by the Task Recovery service and Database. An unassigned request
 * selects records without a session; combining it with a session matches no records.
 * Limits are clamped to 1–100 so a recovery response remains bounded.
 */
export type TaskRecoveryFilters = {
  projectPath?: string;
  sessionId?: string;
  unassigned?: boolean;
  limit?: number;
};
// ---------------------------

//----------------- PERSISTED COMPOSER DRAFTS ------------
/**
 * One user's unsent composer state, shared by Database and User services.
 * recoveryOfRunId links an explicitly prepared continuation to its original
 * interrupted/failed task. Saving the draft does not claim or execute that task.
 */
export type SessionDraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  recoveryOfRunId: string | null;
  updatedAt: string;
};

/**
 * Draft update accepted by Database and User. Omitted recoveryOfRunId preserves
 * the existing association; null explicitly clears it. Empty text with no queued
 * message deletes the whole draft, including any recovery association.
 */
export type SessionDraftInput = {
  text: string;
  queuedMessage: unknown | null;
  recoveryOfRunId?: string | null;
};
// ---------------------------
