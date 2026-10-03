import {
  expireAuthSession,
  getStoredAuthToken,
  storeAuthToken,
} from '@/shared/authToken';
import { IS_PLATFORM } from '@/shared/utils';
import { readVoiceConfig, voiceConfigHeaders } from '@/shared/voiceConfig';
import type {
  HubAgentProvider, HubAutomationInput, HubProjectInput, HubTaskInput, PromptSuggestionAssistant, PromptSuggestionTurn, StudioChatSpace, StudioGitHubMergeInput, StudioIngressId, T212CapsInput, T212Env, T212TradingMode,
} from '@/shared/types';

// Headers are a plain record rather than the full `HeadersInit` union so the
// defaults below can be merged with a caller's headers by spreading.
export type ApiRequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

// Utility function for authenticated API calls
export const authenticatedFetch = (
  url: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const token = getStoredAuthToken();

  const defaultHeaders: Record<string, string> = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      storeAuthToken(refreshedToken);
    }
    if (response.headers.get('X-Auth-Error')) {
      expireAuthSession();
    }
    return response;
  });
};

// ─── Request helpers ────────────────────────────────────────────────────────
// Every endpoint below goes through these so verb, JSON encoding and query
// serialization stay consistent across the whole frontend.

type QueryValue = string | number | boolean | null | undefined;

// Serializes a query object into `?a=1&b=2` (or an empty string). Empty and
// `false` values are dropped so optional flags can be passed unconditionally.
const query = (params: Record<string, QueryValue>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
};

/**
 * Reads a `{ success, error, details }` envelope response, throwing the server's
 * message when the request failed.
 *
 * Endpoints return a bare Response, so call sites unwrap it themselves. Most do
 * so in ways that differ deliberately (bare casts where the caller inspects the
 * payload, abort-aware reads in the git panel); this is the shared form for
 * callers that want a failed request to throw.
 */
export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, options: { code?: string; details?: unknown; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.details = options.details;
    this.status = options.status;
  }
}

/**
 * Reads a `{ success, error, details }` envelope response, throwing an
 * ApiRequestError carrying the server's machine-readable error code when one
 * is present. Accepts both legacy string envelopes (`error: 'message'`) and
 * the structured AppError envelope (`error: { code, message, details }`).
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const raw = data.error ?? data.details;
    const payload = raw && typeof raw === 'object' ? raw : {};
    const message = (typeof raw === 'string' ? raw : payload?.message) || data.details || `Request failed (${response.status})`;
    throw new ApiRequestError(message, {
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      details: payload?.details ?? data.details,
      status: response.status,
    });
  }
  return data as T;
}
const get = (url: string, options: ApiRequestOptions = {}) => authenticatedFetch(url, options);

const withBody =
  (method: string) =>
    (url: string, body?: unknown, options: ApiRequestOptions = {}) =>
      authenticatedFetch(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...options,
      });

const post = withBody('POST');
const put = withBody('PUT');
const patch = withBody('PATCH');
const del = withBody('DELETE');

// ─── URL builders ───────────────────────────────────────────────────────────
// Exported for the consumers that cannot go through `authenticatedFetch`:
// `EventSource` and `XMLHttpRequest` need a bare URL.

/**
 * Persisted messages for one session. Omitting `limit` requests the whole
 * transcript; passing one always pairs it with an explicit offset so automatic
 * refreshes can never accidentally become an unbounded transcript request.
 */
export const sessionMessagesUrl = (
  sessionId: string,
  { limit = null, offset = 0 }: { limit?: number | null; offset?: number } = {},
): string => {
  const base = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
  return limit === null || limit === undefined
    ? base
    : `${base}${query({ limit, offset: offset ?? 0 })}`;
};

const fileContentPath = (projectId: string, filePath: string) =>
  `/api/file-tree/projects/${projectId}/files/content${query({ path: filePath })}`;

const pluginAssetPath = (pluginName: string, assetFile: string) =>
  `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(assetFile)}`;

// ─── API endpoints ──────────────────────────────────────────────────────────
// Every `/api/...` path the frontend talks to is declared here; components
// import a named method instead of assembling URLs of their own.

export const api = {
  // Task recovery is read-only until a user explicitly resolves a record or sends a reviewed continuation.
  taskRecovery: {
    list: (projectPath: string, sessionId: string | null) => get(`/api/task-recovery${query({ projectPath, sessionId, unassigned: !sessionId })}`),
    requestStatus: (requestId: string) => get(`/api/task-recovery/requests/${encodeURIComponent(requestId)}`),
    resolve: (runId: string) => post(`/api/task-recovery/${encodeURIComponent(runId)}/resolve`, {}),
  },
  studio: {
    // Read-only build, checkout, GitHub and host identity; never invokes the updater.
    runtime: (signal?: AbortSignal) => get('/api/studio/runtime', { signal, cache: 'no-store' }),
    projects: {
      list: () => get('/api/studio/projects'),
      get: (id: string) => get(`/api/studio/projects/${encodeURIComponent(id)}`),
      create: (input: HubProjectInput) => post('/api/studio/projects', input),
      update: (id: string, input: HubProjectInput) => put(`/api/studio/projects/${encodeURIComponent(id)}`, input),
      remove: (id: string) => del(`/api/studio/projects/${encodeURIComponent(id)}`),
      // Without a provider the workbench opens a new chat with the agent this device used last.
      launch: (id: string, provider?: HubAgentProvider) => post(`/api/studio/projects/${encodeURIComponent(id)}/launch`, provider ? { provider } : {}),
      launchWorkbench: (provider: HubAgentProvider) => post('/api/studio/projects/workbench/launch', { provider }),
      launchRemote: (id: string, agent: HubAgentProvider | 'shell') => post(`/api/studio/projects/${encodeURIComponent(id)}/remote-launch`, { agent }),
      linkStatus: (id: string) => get(`/api/studio/projects/${encodeURIComponent(id)}/links/status`),
      sessions: (id: string) => get(`/api/studio/projects/${encodeURIComponent(id)}/sessions`),
      tasks: (id: string) => get(`/api/studio/projects/${encodeURIComponent(id)}/tasks`),
      saveTask: (id: string, input: HubTaskInput, taskId?: string) => taskId
        ? put(`/api/studio/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`, input)
        : post(`/api/studio/projects/${encodeURIComponent(id)}/tasks`, input),
      scheduleTask: (id: string, taskId: string, sessionId: string, scheduledFor: string) =>
        post(`/api/studio/projects/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/schedule`, { sessionId, scheduledFor }),
      mailStatus: (id: string) => get(`/api/studio/projects/${encodeURIComponent(id)}/mail/status`),
      connectMail: (id: string) => post(`/api/studio/projects/${encodeURIComponent(id)}/mail/connect`),
      mailMessages: (id: string, q: string) => get(`/api/studio/projects/${encodeURIComponent(id)}/mail/messages${query({ q })}`),
      mailMessage: (id: string, messageId: string) => get(`/api/studio/projects/${encodeURIComponent(id)}/mail/messages/${encodeURIComponent(messageId)}`),
    },
    // A project's automations (planned from plain words, then created, switched, run or deleted) and the owner's
    // Web Push status and test notification.
    automations: {
      push: () => get('/api/studio/automations/push'),
      testPush: () => post('/api/studio/automations/push/test'),
      list: (projectId: string) => get(`/api/studio/automations/projects/${encodeURIComponent(projectId)}`),
      plan: (projectId: string, text: string, timeZone: string) => post(`/api/studio/automations/projects/${encodeURIComponent(projectId)}/plan`, { text, timeZone }),
      create: (projectId: string, input: HubAutomationInput) => post(`/api/studio/automations/projects/${encodeURIComponent(projectId)}`, input),
      update: (id: string, input: HubAutomationInput) => put(`/api/studio/automations/${encodeURIComponent(id)}`, input),
      setEnabled: (id: string, enabled: boolean) => patch(`/api/studio/automations/${encodeURIComponent(id)}`, { enabled }),
      remove: (id: string) => del(`/api/studio/automations/${encodeURIComponent(id)}`),
      run: (id: string) => post(`/api/studio/automations/${encodeURIComponent(id)}/run`),
    },
    quota: () => get('/api/studio/quota'),
    remote: {
      hosts: () => get('/api/studio/remote/hosts'),
      status: (name: string) => get(`/api/studio/remote/hosts/${encodeURIComponent(name)}/status`),
    },
    trading212: {
      status: () => get('/api/studio/trading212/status'),
      overview: (env: T212Env) => get(`/api/studio/trading212/overview${query({ env })}`),
      history: (env: T212Env, days: number) => get(`/api/studio/trading212/history${query({ env, days: String(days) })}`),
      activity: (env: T212Env) => get(`/api/studio/trading212/activity${query({ env })}`),
    },
    // ── v4 track: network — endpoints below this line ──
    // Both front doors, the one serving this page and short guidance (docs/network.md).
    network: () => get('/api/studio/network'),
    // The network guide (docs/network.md) as Markdown, served by Studio so it opens without GitHub.
    networkGuide: () => get('/api/studio/network/guide'),
    // A one-time code that signs this user in on the other door; a Tailscale session needs the password for the public door.
    handoff: (target: StudioIngressId, password?: string) => post('/api/auth/handoff', password ? { target, password } : { target }),
    // Redeemed by the page on the target door, which has no token yet; the server checks this page's Origin.
    redeemHandoff: (code: string) => fetch('/api/auth/handoff/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
    // ── v4 track: orders — endpoints below this line ──
    // Trading 212 order placement (single-use previews confirmed by a passkey or a double confirmation) and passkeys.
    // Passkey changes are stepped up with the Studio password (or, for a removal, that passkey's assertion); order caps
    // are lowered with the session and raised only with Face ID / Touch ID.
    t212Trading: {
      config: () => get('/api/studio/trading212/trading'),
      preview: (input: {
        env: T212Env; ticker: string; side: 'buy' | 'sell'; type: 'market' | 'limit'; quantity: number;
        limitPrice?: number; timeValidity?: 'DAY' | 'GOOD_TILL_CANCEL'; acknowledgeUnknown?: boolean;
      }) => post('/api/studio/trading212/orders/preview', input),
      confirm: (id: string, proof: { assertion: unknown } | { confirmed: true }) =>
        post(`/api/studio/trading212/orders/${encodeURIComponent(id)}/confirm`, proof),
      passkeyOptions: (password: string) => post('/api/studio/trading212/passkey/options', { password }),
      registerPasskey: (response: unknown) => post('/api/studio/trading212/passkey', { response }),
      removalOptions: (id: string) => post(`/api/studio/trading212/passkey/${encodeURIComponent(id)}/remove/options`),
      removePasskey: (id: string, proof: { password: string } | { assertion: unknown }) =>
        post(`/api/studio/trading212/passkey/${encodeURIComponent(id)}/remove`, proof),
      // Raising caps: a single-use 60 s Face ID / Touch ID challenge bound to exactly these values and this origin.
      capsChallenge: (input: T212CapsInput) => post('/api/studio/trading212/caps/challenge', input),
      // Lowering needs only the session; a raise carries the challenge id and the assertion over it.
      updateCaps: (input: T212CapsInput, proof?: { challengeId: string; assertion: unknown }) =>
        put('/api/studio/trading212/caps', proof ? { ...input, ...proof } : input),
      // Adding accounts to the trading mode: a single-use 60 s Face ID / Touch ID challenge bound to exactly this mode.
      modeChallenge: (mode: T212TradingMode) => post('/api/studio/trading212/mode/challenge', { mode }),
      // Narrowing (including off) needs only the session; a widening carries the challenge id and the assertion over it.
      updateMode: (mode: T212TradingMode, proof?: { challengeId: string; assertion: unknown }) =>
        put('/api/studio/trading212/mode', proof ? { mode, ...proof } : { mode }),
    },
    // ── v4 track: mail — endpoints below this line ──
    // Per-user read-only mail accounts (Gmail IMAP, Outlook) and the unified inbox; secrets only travel in addImap's body.
    mail: {
      accounts: () => get('/api/studio/mail/accounts'),
      addImap: (email: string, password: string) => post('/api/studio/mail/accounts/imap', { email, password }),
      startOutlook: () => post('/api/studio/mail/accounts/outlook/device'),
      pollOutlook: (pollId: string) => post(`/api/studio/mail/accounts/outlook/device/${encodeURIComponent(pollId)}`),
      removeAccount: (id: string) => del(`/api/studio/mail/accounts/${encodeURIComponent(id)}`),
      messages: (params: { accountId?: string; q?: string; limit?: number } = {}) => get(`/api/studio/mail/messages${query(params)}`),
      message: (accountId: string, messageId: string) =>
        get(`/api/studio/mail/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(messageId)}`),
    },
    // ── v6 track: shell — endpoints below this line ──
    // Which IDE project each local hub project lives in: the workbench's project icons and DeepSeek space, and
    // the project app's links to existing sessions. Read-only; it never registers a directory.
    workbench: {
      hubLinks: () => get('/api/studio/workbench/hub-links'),
      // The project switcher's marks: { projects: { [ideProjectId]: { running, attention, attentionSessionIds } } }.
      activity: () => get('/api/studio/workbench/activity'),
      // Conversations handed between providers mid-way: the project's chains, the handoff summary of the session
      // being left (with the block that seeds the next one), recording the next session, renaming and forgetting.
      threads: (projectId: string) => get(`/api/studio/workbench/threads${query({ projectId })}`),
      handoff: (body: {
        projectId: string;
        from: { kind: 'agent' | 'deepseek'; id: string; modelLabel: string | null };
        toProvider: 'claude' | 'codex' | 'deepseek';
      }) => post('/api/studio/workbench/handoffs', body),
      linkThread: (body: {
        projectId: string;
        title: string;
        from: { kind: 'agent' | 'deepseek'; id: string; modelLabel: string | null };
        to: { kind: 'agent' | 'deepseek'; id: string; modelLabel: string | null };
      }) => post('/api/studio/workbench/threads', body),
      renameThread: (threadId: string, title: string) => patch(`/api/studio/workbench/threads/${encodeURIComponent(threadId)}`, { title }),
      removeThread: (threadId: string) => del(`/api/studio/workbench/threads/${encodeURIComponent(threadId)}`),
    },
    // ── v6 track: chat — endpoints below this line ──
    // The faint suggested next message of a chat composer, from the conversation tail (DeepSeek, else a local rule):
    // `{ suggestion: string | null, source }`. The signal cancels it when the conversation moves on.
    suggestions: (body: { assistant: PromptSuggestionAssistant; turns: PromptSuggestionTurn[] }, signal?: AbortSignal) =>
      post('/api/studio/suggestions', body, { signal }),
    // ── v6 track: github — endpoints below this line ──
    // The owner's GitHub through the server's gh CLI: account, PR inbox, one PR, merging (audited) and merge history.
    // `refresh` bypasses the server's 45-second cache (it still reuses a fetch from the last few seconds).
    github: {
      status: (refresh = false) => get(`/api/studio/github/status${query({ refresh })}`),
      pulls: (refresh = false) => get(`/api/studio/github/prs${query({ refresh })}`),
      pull: (owner: string, repo: string, number: number, refresh = false) =>
        get(`/api/studio/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}${query({ refresh })}`),
      merge: (owner: string, repo: string, number: number, input: StudioGitHubMergeInput) =>
        post(`/api/studio/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/merge`, input),
      merges: () => get('/api/studio/github/merges'),
      // One-tap fixes for a blocked PR (audited): merge the base into the head, mark a draft ready, approve waiting runs.
      updateBranch: (owner: string, repo: string, number: number, expectedHeadSha: string) =>
        post(`/api/studio/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/update-branch`, { expectedHeadSha }),
      markReady: (owner: string, repo: string, number: number) =>
        post(`/api/studio/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/ready`, {}),
      approveRuns: (owner: string, repo: string, number: number, runIds: number[]) =>
        post(`/api/studio/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/approve-runs`, { runIds }),
      // The open PR of a workbench project's current branch (30-second server cache), or null.
      branchPull: (projectId: string, refresh = false) => get(`/api/studio/github/branch-pr${query({ projectId, refresh })}`),
    },
    // ── v6 track: builder — endpoints below this line ──
    // App Store-style AI builds: poll the list, start one (name, icon, what to build), continue it with a follow-up, stop it;
    // `environment` says whether builds run sandboxed or restricted.
    builds: {
      list: () => get('/api/studio/builds'),
      environment: () => get('/api/studio/builds/environment'),
      create: (input: { name: string; tone: string; glyph: string; prompt: string }) => post('/api/studio/builds', input),
      resume: (id: string, message = '') => post(`/api/studio/builds/${encodeURIComponent(id)}/continue`, { message }),
      cancel: (id: string) => post(`/api/studio/builds/${encodeURIComponent(id)}/cancel`),
      // A short name for the app a description asks for (DeepSeek, or the server's local rule); aborted by newer input.
      suggestName: (prompt: string, signal?: AbortSignal) => post('/api/studio/builds/suggest-name', { prompt }, { signal }),
    },
    // The apps those builds made, run in their 主页: open starts one if needed (restart: afresh) and returns its
    // sandboxed address; status and stop read and end the run.
    apps: {
      open: (projectId: string, restart = false) => post(`/api/studio/apps/${encodeURIComponent(projectId)}/open`, { restart }),
      status: (projectId: string) => get(`/api/studio/apps/${encodeURIComponent(projectId)}`),
      stop: (projectId: string) => post(`/api/studio/apps/${encodeURIComponent(projectId)}/stop`),
    },
    // The Harness app: Claude Code and Codex sessions on this computer (WSL and Windows), polled while it is open.
    harness: {
      tasks: (signal?: AbortSignal) => get('/api/studio/harness/tasks', { signal, cache: 'no-store' }),
    },
    // ── v6 track: memory — endpoints below this line ──
    // The shared basic-memory server (Claude Code, Codex, DeepSeek) through Studio's MCP client; ids are permalinks.
    memory: {
      status: () => get('/api/studio/memory/status'),
      recent: (folder?: string, signal?: AbortSignal) => get(`/api/studio/memory/notes${query({ folder })}`, { signal }),
      search: (q: string, folder?: string, signal?: AbortSignal) => get(`/api/studio/memory/search${query({ q, folder })}`, { signal }),
      note: (id: string, signal?: AbortSignal) => get(`/api/studio/memory/note${query({ id })}`, { signal }),
      remove: (id: string) => del(`/api/studio/memory/note${query({ id })}`),
    },
    status: () => get('/api/studio/status'),
    snr: () => get('/api/studio/snr'),
    snrAccess: () => post('/api/studio/snr/access'),
    closeSnr: () => post('/api/studio/snr/close'),
    saveKey: (apiKey: string) => put('/api/studio/deepseek/key', { apiKey }),
    removeKey: () => del('/api/studio/deepseek/key'),
    testKey: () => post('/api/studio/deepseek/test'),
    conversations: (space: StudioChatSpace) => get(`/api/studio/conversations?space=${encodeURIComponent(space)}`),
    createConversation: (model: string, space: StudioChatSpace) => post('/api/studio/conversations', { model, space }),
    conversation: (id: string) => get(`/api/studio/conversations/${encodeURIComponent(id)}`),
    removeConversation: (id: string) => del(`/api/studio/conversations/${encodeURIComponent(id)}`),
    send: (id: string, text: string, includeSnr: boolean, signal: AbortSignal) =>
      post(`/api/studio/conversations/${encodeURIComponent(id)}/messages`, { text, includeSnr }, { signal }),
  },
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    // Passwordless sign-in for the owner's own Tailscale identity; the server decides from Tailscale Serve headers.
    tailscaleSession: () => fetch('/api/auth/tailscale-session', { method: 'POST' }),
    login: (username: string, password: string) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username: string, password: string) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    // "用面容 ID 登录": a fresh challenge for this door, then the passkey's assertion for a session.
    passkeyOptions: () => fetch('/api/auth/passkey/options', { method: 'POST' }),
    // The ceremony id from passkeyOptions names the challenge this assertion answers.
    passkeySignIn: (ceremonyId: string, response: unknown) => fetch('/api/auth/passkey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ceremonyId, response }),
    }),
    refresh: () => post('/api/auth/refresh'),
    user: () => get('/api/auth/user'),
    // Settings → 安全 (signed in). Adding or removing a sign-in passkey is stepped up with the password.
    security: {
      overview: () => get('/api/auth/security'),
      passkeyOptions: (password: string) => post('/api/auth/security/passkeys/options', { password }),
      registerPasskey: (response: unknown) => post('/api/auth/security/passkeys', { response }),
      removePasskey: (id: string, password: string) =>
        post(`/api/auth/security/passkeys/${encodeURIComponent(id)}/remove`, { password }),
      // "退出所有设备": every session token so far stops working, this one included.
      revokeAll: () => post('/api/auth/security/revoke-all'),
    },
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => get('/api/projects'),
  archivedProjects: () => get('/api/projects/archived'),
  projectSessions: (
    projectId: string,
    { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
    options: ApiRequestOptions = {},
  ) =>
    get(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${query({ limit, offset })}`,
      options,
    ),
  projectTaskmaster: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  renameProject: (projectId: string, displayName: string) =>
    put(`/api/projects/${projectId}/rename`, { displayName }),
  restoreProject: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/restore`),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId: string, hardDelete = false) =>
    del(`/api/projects/${projectId}${query({ force: hardDelete })}`),
  createProject: (projectData: unknown) => post('/api/projects/create-project', projectData),
  migrateLegacyProjectStars: (projectIds: string[]) =>
    post('/api/projects/migrate-legacy-stars', { projectIds }),
  toggleProjectStar: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`),
  // A clone is two requests: the details (GitHub token included) go in this
  // POST body, and the returned `cloneId` is all the progress stream's URL
  // carries — URLs land in access logs, proxy logs and browser history.
  startProjectClone: (cloneRequest: {
    path: string;
    githubUrl: string;
    githubTokenId: number | null;
    newGithubToken: string | null;
  }) => post('/api/projects/clone', cloneRequest),
  // EventSource cannot send an Authorization header, so the token rides along as
  // a query parameter on the streaming endpoints below.
  cloneProjectProgressUrl: ({ cloneId }: { cloneId: string }) =>
    `/api/projects/clone-progress${query({ cloneId, token: getStoredAuthToken() })}`,
  searchConversationsUrl: (searchQuery: string, limit = 50) =>
    `/api/providers/search/sessions${query({
      q: searchQuery,
      limit,
      token: getStoredAuthToken(),
    })}`,

  // Session endpoints. Provider/project metadata are resolved by the backend
  // from the session id.
  // Session deletion mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId: string, hardDelete = false) =>
    del(`/api/providers/sessions/${sessionId}${query({ force: hardDelete })}`),
  getArchivedSessions: () => get('/api/providers/sessions/archived'),
  // Resolves one session (by app id or provider-native id) to its metadata and
  // owning project — used when a /session/<id> URL isn't in loaded payloads.
  sessionDetails: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  runningSessions: () => get('/api/providers/sessions/running'),
  recentConversations: ({ limit = 40, offset = 0 }: { limit?: number; offset?: number } = {}) =>
    get(`/api/providers/sessions/recent${query({ limit, offset })}`),
  providerSessionId: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/provider-id`),
  restoreSession: (sessionId: string) => post(`/api/providers/sessions/${sessionId}/restore`),
  // Creates an independent session holding this one's conversation up to
  // `upToAnchorId` (all of it when omitted). The source is left untouched.
  forkSession: (sessionId: string, body: { upToAnchorId?: string; title?: string } = {}) =>
    post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/fork`, body),
  renameSession: (sessionId: string, summary: string) =>
    put(`/api/providers/sessions/${sessionId}`, { summary }),
  // What one agent of a workflow run did, read from its transcript on demand
  // when its row in the workflow card is opened.
  workflowAgentActivity: (sessionId: string, runId: string, agentId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}`),

  // Scheduled messages: send a message to a session at a future time.
  scheduledMessages: {
    list: (sessionId?: string) =>
      get(`/api/scheduled-messages${sessionId ? query({ sessionId }) : ''}`),
    create: (body: { sessionId: string; content: string; scheduledFor: string; options?: unknown }) =>
      post('/api/scheduled-messages', body),
    cancel: (id: string) => del(`/api/scheduled-messages/${encodeURIComponent(id)}`),
  },

  // Workspace file tree
  readFile: (projectId: string, filePath: string) =>
    get(`/api/file-tree/projects/${projectId}/file${query({ filePath })}`),
  // Raw bytes for a workspace file. The endpoint requires the auth header, so
  // media call sites fetch a blob through here instead of using a bare `src`.
  readFileBlob: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
    get(fileContentPath(projectId, filePath), options),
  saveFile: (projectId: string, filePath: string, content: string) =>
    put(`/api/file-tree/projects/${projectId}/file`, { filePath, content }),
  getFiles: (projectId: string, options: ApiRequestOptions = {}) =>
    get(`/api/file-tree/projects/${projectId}/files${query({ respectGitignore: true })}`, options),

  // File operations
  createFile: (
    projectId: string,
    { path, type, name }: { path: string; type: string; name: string },
  ) => post(`/api/file-tree/projects/${projectId}/files/create`, { path, type, name }),

  renameFile: (projectId: string, { oldPath, newName }: { oldPath: string; newName: string }) =>
    put(`/api/file-tree/projects/${projectId}/files/rename`, { oldPath, newName }),

  deleteFile: (projectId: string, { path, type }: { path: string; type: string }) =>
    del(`/api/file-tree/projects/${projectId}/files`, { path, type }),

  // Uploads with a progress bar go through XMLHttpRequest, which needs the URL.
  uploadFilesUrl: (projectId: string) =>
    `/api/file-tree/projects/${encodeURIComponent(projectId)}/files/upload`,

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath: string | null = null) =>
    get(`/api/file-tree/browse-filesystem${query({ path: dirPath })}`),

  createFolder: (folderPath: string) => post('/api/file-tree/create-folder', { path: folderPath }),

  // Git endpoints. The `project` param carries the DB projectId post-migration.
  git: {
    status: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/status${query({ project: projectId })}`, options),
    diff: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/diff${query({ project: projectId, file: filePath })}`, options),
    commitDiff: (projectId: string, commit: string) =>
      get(`/api/git/commit-diff${query({ project: projectId, commit })}`),
    fileWithDiff: (projectId: string, filePath: string) =>
      get(`/api/git/file-with-diff${query({ project: projectId, file: filePath })}`),
    branches: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/branches${query({ project: projectId })}`, options),
    branchDiff: (projectId: string, base: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/branch-diff${query({ project: projectId, base })}`, options),
    // `oldPath` is the pre-rename path of a renamed file so the server can diff the rename itself.
    branchDiffFile: (
      projectId: string,
      base: string,
      filePath: string,
      oldPath?: string,
      options: ApiRequestOptions = {},
    ) => get(`/api/git/branch-diff/file${query({ project: projectId, base, file: filePath, oldPath })}`, options),
    remoteStatus: (projectId: string) =>
      get(`/api/git/remote-status${query({ project: projectId })}`),
    commits: (
      projectId: string,
      { limit }: { limit?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(`/api/git/commits${query({ project: projectId, limit })}`, options),
    checkout: (projectId: string, branch: string) =>
      post('/api/git/checkout', { project: projectId, branch }),
    createBranch: (projectId: string, branch: string) =>
      post('/api/git/create-branch', { project: projectId, branch }),
    deleteBranch: (projectId: string, branch: string, force = false) =>
      post('/api/git/delete-branch', { project: projectId, branch, force }),
    fetch: (projectId: string) => post('/api/git/fetch', { project: projectId }),
    pull: (projectId: string) => post('/api/git/pull', { project: projectId }),
    push: (projectId: string) => post('/api/git/push', { project: projectId }),
    publish: (projectId: string, branch: string) =>
      post('/api/git/publish', { project: projectId, branch }),
    discard: (projectId: string, file: string) =>
      post('/api/git/discard', { project: projectId, file }),
    deleteUntracked: (projectId: string, file: string) =>
      post('/api/git/delete-untracked', { project: projectId, file }),
    stage: (projectId: string, files: string[]) =>
      post('/api/git/stage', { project: projectId, files }),
    unstage: (projectId: string, files: string[]) =>
      post('/api/git/unstage', { project: projectId, files }),
    commit: (projectId: string, message: string, files: string[]) =>
      post('/api/git/commit', { project: projectId, message, files }),
    initialCommit: (projectId: string) => post('/api/git/initial-commit', { project: projectId }),
    init: (projectId: string) => post('/api/git/init', { project: projectId }),
    revertLocalCommit: (projectId: string) =>
      post('/api/git/revert-local-commit', { project: projectId }),
    generateCommitMessage: (projectId: string, files: string[], provider: string) =>
      post('/api/git/generate-commit-message', { project: projectId, files, provider }),
  },

  worktrees: {
    list: (projectId: string) => get(`/api/worktrees${query({ project: projectId })}`),
    create: (
      projectId: string,
      { branch, baseBranch }: { branch: string; baseBranch: string | null },
    ) => post('/api/worktrees/create', { project: projectId, branch, baseBranch }),
    open: (projectId: string, worktreePath: string) =>
      post('/api/worktrees/open', { project: projectId, worktreePath }),
    merge: (
      projectId: string,
      worktreePath: string,
      options: { squash?: boolean; message?: string; removeAfterMerge?: boolean },
    ) => post('/api/worktrees/merge', { project: projectId, worktreePath, ...options }),
    remove: (
      projectId: string,
      worktreePath: string,
      options: { force?: boolean; deleteBranch?: boolean },
    ) => post('/api/worktrees/remove', { project: projectId, worktreePath, ...options }),
  },

  // Provider (coding agent) endpoints — models, capabilities, sessions, MCP, skills.
  providers: {
    capabilities: () => get('/api/providers/capabilities'),
    authStatus: (provider: string) =>
      get(`/api/providers/${encodeURIComponent(provider)}/auth/status`),

    models: (provider: string) => get(`/api/providers/${provider}/models`),
    createModel: (provider: string, input: unknown) =>
      post(`/api/providers/${provider}/models`, input),
    updateModel: (provider: string, recordId: string | number, input: unknown) =>
      patch(`/api/providers/${provider}/models/${recordId}`, input),
    deleteModel: (provider: string, recordId: string | number) =>
      del(`/api/providers/${provider}/models/${recordId}`),

    createSession: (payload: {
      provider: string;
      projectPath: string;
      initialMessage?: unknown;
    }) => post('/api/providers/sessions', payload),
    sessionMessages: (
      sessionId: string,
      pagination: { limit?: number | null; offset?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(sessionMessagesUrl(sessionId, pagination), options),
    sessionTokenUsage: (sessionId: string) =>
      get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/token-usage`),
    sessionActiveModel: (provider: string, sessionId: string) =>
      get(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`),
    setSessionActiveModel: (provider: string, sessionId: string, model: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`, {
        model,
      }),
    setSessionActiveEffort: (provider: string, sessionId: string, effort: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-effort`, {
        effort,
      }),

    mcpServers: (
      provider: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) => get(`/api/providers/${provider}/mcp/servers${query({ scope, workspacePath })}`),
    saveMcpServer: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/mcp/servers`, payload),
    deleteMcpServer: (
      provider: string,
      serverName: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) =>
      del(
        `/api/providers/${provider}/mcp/servers/${encodeURIComponent(serverName)}${query({ scope, workspacePath })}`,
      ),
    saveGlobalMcpServer: (payload: unknown) => post('/api/providers/mcp/servers/global', payload),

    skills: (provider: string, { workspacePath }: { workspacePath?: string } = {}) =>
      get(`/api/providers/${encodeURIComponent(provider)}/skills${query({ workspacePath })}`),
    saveSkills: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/skills`, payload),
  },

  // Slash commands
  commands: {
    // `projectPath` stays optional: a workspace without a resolved path omits
    // the field entirely, which is what the server expects.
    list: (projectPath: string | undefined) => post('/api/commands/list', { projectPath }),
    execute: (payload: unknown) => post('/api/commands/execute', payload),
  },

  // Chat attachments, stored globally under ~/.cloudcli/assets
  assets: {
    uploadFiles: (formData: FormData) =>
      authenticatedFetch('/api/assets/files', {
        method: 'POST',
        headers: {}, // Let browser set Content-Type for FormData
        body: formData,
      }),
    file: (storedName: string) => get(`/api/assets/files/${encodeURIComponent(storedName)}`),
    image: (filename: string, options: ApiRequestOptions = {}) =>
      get(`/api/assets/images/${encodeURIComponent(filename)}`, options),
  },

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Update a task
    updateTask: (projectId: string, taskId: string | number, updates: unknown) =>
      put(`/api/taskmaster/update-task/${projectId}/${taskId}`, updates),

    tasks: (projectId: string) => get(`/api/taskmaster/tasks/${encodeURIComponent(projectId)}`),
    mcpStatus: () => get('/api/taskmaster/mcp-status'),
    installationStatus: () => get('/api/taskmaster/installation-status'),

    prdFiles: (projectId: string) => get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`),
    prdFile: (projectId: string, fileName: string) =>
      get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}/${encodeURIComponent(fileName)}`),
    savePrd: (projectId: string, { fileName, content }: { fileName: string; content: string }) =>
      post(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`, { fileName, content }),
  },

  // User endpoints
  user: {
    gitConfig: () => get('/api/user/git-config'),
    updateGitConfig: (gitName: string, gitEmail: string) =>
      post('/api/user/git-config', { gitName, gitEmail }),
    onboardingStatus: () => get('/api/user/onboarding-status'),
    completeOnboarding: () => post('/api/user/complete-onboarding'),

    // Preferences and chat drafts live server-side so they follow the user
    // from one device to another. `savePreferences` is a merge-patch: only the
    // keys it is given are written.
    preferences: () => get('/api/user/preferences'),
    savePreferences: (updates: Record<string, unknown>) =>
      patch('/api/user/preferences', updates),
    drafts: () => get('/api/user/drafts'),
    saveDraft: (scope: string, draft: { text: string; queuedMessage?: unknown; recoveryOfRunId?: string | null }) =>
      put('/api/user/drafts', { scope, ...draft }),
    deleteDraft: (scope: string) => del('/api/user/drafts', { scope }),
  },

  // Server-side settings: API keys, stored credentials, notifications, web push
  settings: {
    apiKeys: () => get('/api/settings/api-keys'),
    // Creating a key, or turning a disabled one back on, needs the Studio login password.
    createApiKey: (keyName: string, password: string) => post('/api/settings/api-keys', { keyName, password }),
    deleteApiKey: (keyId: string) => del(`/api/settings/api-keys/${keyId}`),
    toggleApiKey: (keyId: string, isActive: boolean, password?: string) =>
      patch(`/api/settings/api-keys/${keyId}/toggle`, password === undefined ? { isActive } : { isActive, password }),

    credentials: (type: string) => get(`/api/settings/credentials${query({ type })}`),
    createCredential: (payload: {
      credentialName: string;
      credentialType: string;
      credentialValue: string;
      description?: string;
    }) => post('/api/settings/credentials', payload),
    deleteCredential: (credentialId: string) => del(`/api/settings/credentials/${credentialId}`),
    toggleCredential: (credentialId: string, isActive: boolean) =>
      patch(`/api/settings/credentials/${credentialId}/toggle`, { isActive }),

    notificationPreferences: () => get('/api/settings/notification-preferences'),
    saveNotificationPreferences: (preferences: unknown) =>
      put('/api/settings/notification-preferences', preferences),

    push: {
      vapidPublicKey: () => get('/api/settings/push/vapid-public-key'),
      // `resubscribe` re-registers a subscription this browser already has (after sign-in): the
      // server stores it again without switching Web Push on or announcing it.
      subscribe: (subscription: { endpoint?: string; keys?: unknown; resubscribe?: boolean }) =>
        post('/api/settings/push/subscribe', subscription),
      unsubscribe: (endpoint: string) => post('/api/settings/push/unsubscribe', { endpoint }),
    },
  },

  plugins: {
    list: () => get('/api/plugins'),
    install: (url: string) => post('/api/plugins/install', { url }),
    uninstall: (name: string) => del(`/api/plugins/${encodeURIComponent(name)}`),
    update: (name: string) => post(`/api/plugins/${encodeURIComponent(name)}/update`),
    toggle: (name: string, enabled: boolean) =>
      put(`/api/plugins/${encodeURIComponent(name)}/enable`, { enabled }),
    // Plugin bundles/icons are fetched with auth headers and handed to the
    // browser as blobs, so a bare asset URL is never requested unauthenticated.
    asset: (pluginName: string, assetFile: string) => get(pluginAssetPath(pluginName, assetFile)),
    // Exposed so the icon cache can key on the resolved asset path.
    assetUrl: pluginAssetPath,
    rpc: (pluginName: string, method: string, path: string, body?: unknown) =>
      authenticatedFetch(
        `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${String(path).replace(/^\//, '')}`,
        {
          method: method || 'GET',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      ),
  },

  browserUse: {
    status: () => get('/api/browser-use/status'),
    settings: () => get('/api/browser-use/settings'),
    saveSettings: (settings: unknown) => put('/api/browser-use/settings', settings),
    sessions: () => get('/api/browser-use/sessions'),
    stopSession: (sessionId: string) => post(`/api/browser-use/sessions/${sessionId}/stop`),
    deleteSession: (sessionId: string) => del(`/api/browser-use/sessions/${sessionId}`),
    installRuntime: () => post('/api/browser-use/runtime/install'),
  },

  voice: {
    health: () => get('/api/voice/health'),
    transcribe: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
      }),
    tts: (text: string, options: ApiRequestOptions = {}) => post('/api/voice/tts', { text }, options),
  },

  system: {
    update: () => post('/api/system/update'),
  },

  // The web client itself, outside /api. Public like the page, so no token is sent.
  webClient: {
    // The served index.html, bypassing every cache: useFrontendUpdateWatcher compares the entry bundles it names
    // with the ones this page booted with. `basePath` is the deployment prefix ('' at the domain root).
    indexHtml: (basePath: string, signal?: AbortSignal) =>
      fetch(`${basePath}/index.html`, { cache: 'no-store', credentials: 'same-origin', signal }),
  },
};

// ---------------------------

//----------------- VOICE TRANSCRIPTION AND SPEECH ------------

/**
 * Builds a URL against the user's own OpenAI-compatible voice endpoint. Private to the
 * voice helpers below, which bypass the CloudCLI proxy when a base URL is configured.
 */
function voiceDirectUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Serializes the active voice configuration so callers can detect a settings change and
 * drop cached synthesized audio.
 */
export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

/**
 * Transcribes recorded audio, posting directly to the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise going through the CloudCLI voice proxy.
 */
export function transcribeVoice(blob: Blob, filename: string): Promise<Response> {
  const config = readVoiceConfig();
  const body = new FormData();

  if (config.baseUrl.trim()) {
    body.append('file', blob, filename);
    body.append('model', config.sttModel || 'whisper-1');
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/transcriptions'), {
      method: 'POST',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      body,
    });
  }

  body.append('audio', blob, filename);
  return api.voice.transcribe(body, voiceConfigHeaders());
}

/**
 * Synthesizes speech for the given text, using the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise the CloudCLI voice proxy.
 */
export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return api.voice.tts(text, { headers: voiceConfigHeaders(), signal });
}
