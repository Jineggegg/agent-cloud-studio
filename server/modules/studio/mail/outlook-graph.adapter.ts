import { AppError } from '@/shared/utils.js';
import type { StudioMailRawMessage } from '@/shared/types.js';

type Json = Record<string, unknown>;
type GraphAddress = { emailAddress?: { name?: string; address?: string } };
type GraphMessage = {
  id?: string; subject?: string; from?: GraphAddress; toRecipients?: GraphAddress[];
  receivedDateTime?: string; bodyPreview?: string; isRead?: boolean; body?: { contentType?: string; content?: string };
};
type GraphTokens = { accessToken: string; refreshToken: string; expiresAt: number };
type DevicePoll = { kind: 'pending' } | { kind: 'slow_down' } | { kind: 'expired' } | { kind: 'declined' } | { kind: 'tokens'; tokens: GraphTokens };

// Personal Microsoft accounts only (outlook.com, hotmail.com, live.com); the app is a public client.
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access Mail.Read User.Read';
const LIST_FIELDS = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead';
const READ_FIELDS = 'id,subject,from,toRecipients,receivedDateTime,body,isRead';
const REQUEST_MS = 15_000;
const RESPONSE_BYTES = 6 * 1024 * 1024;
// Graph message ids are URL-safe base64 in practice; older ids may also carry + and /.
const MESSAGE_ID = /^[A-Za-z0-9+/=_-]{1,512}$/;
const VERIFICATION_HOST = /(^|\.)(microsoft\.com|live\.com|microsoftonline\.com)$/;
const DEFAULT_VERIFICATION_URI = 'https://microsoft.com/devicelogin';
const CONFIG_HINT = 'Outlook 应用配置有误：请确认 Entra 应用支持「个人 Microsoft 帐户」，并在「身份验证」里开启「允许公共客户端流」';

function fail(message: string, statusCode = 502, code = 'MAIL_PROVIDER_ERROR'): never {
  throw new AppError(message, { statusCode, code });
}

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

// Reads at most `limit` bytes of JSON; a larger or malformed body yields an empty object.
async function boundedJson(response: Response, limit = RESPONSE_BYTES): Promise<Json> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); return {}; }
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return {};
  } finally { reader.releaseLock(); }
}

// Only Microsoft's own sign-in pages are shown to the user as the verification link.
function verificationUri(value: unknown) {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' && VERIFICATION_HOST.test(url.hostname) ? url.toString() : DEFAULT_VERIFICATION_URI;
  } catch { return DEFAULT_VERIFICATION_URI; }
}

function address(value: GraphAddress | undefined) {
  return { name: text(value?.emailAddress?.name), address: text(value?.emailAddress?.address) };
}

function toRawMessage(message: GraphMessage, body: StudioMailRawMessage['body']): StudioMailRawMessage {
  const sender = address(message.from);
  return {
    id: text(message.id),
    subject: text(message.subject),
    from: sender.name || sender.address,
    fromAddress: sender.address,
    to: (message.toRecipients ?? []).map(address).map(item => item.name && item.address ? `${item.name} <${item.address}>` : item.address || item.name)
      .filter(Boolean).join(', '),
    date: text(message.receivedDateTime),
    unread: message.isRead === false,
    body,
    truncated: false,
  };
}

// $-prefixed OData options stay literal; values are percent-encoded.
function graphUrl(path: string, params: Record<string, string>) {
  return `${GRAPH}${path}?${Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

/** Used by the Studio mail service for Outlook.com: device-code sign-in, token refresh and read-only Graph mail calls. */
export function createOutlookGraphAdapter(deps: { clientId?: string; request?: typeof fetch; now?: () => number } = {}) {
  const request = deps.request ?? fetch;
  const now = deps.now ?? Date.now;

  async function send(url: string, init: RequestInit) {
    try {
      return await request(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS), redirect: 'error' });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') fail('Microsoft 服务响应超时，请稍后重试', 504, 'MAIL_PROVIDER_TIMEOUT');
      fail('无法连接 Microsoft 服务，请检查这台电脑的网络', 502, 'MAIL_PROVIDER_UNREACHABLE');
    }
  }
  function clientId() {
    if (!deps.clientId) fail('Outlook 尚未配置：请在服务器 .env 设置 STUDIO_OUTLOOK_CLIENT_ID（见 docs/mail.md）', 503, 'MAIL_OUTLOOK_UNCONFIGURED');
    return deps.clientId;
  }
  async function identity(path: string, params: Record<string, string>) {
    const response = await send(`${AUTHORITY}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: clientId() }),
    });
    return { ok: response.ok, status: response.status, data: await boundedJson(response, 256 * 1024) };
  }
  // Maps Microsoft identity error codes; their descriptions can quote request data and are never echoed.
  function identityFailure(error: string): never {
    if (error === 'invalid_client' || error === 'unauthorized_client' || error === 'invalid_request') fail(CONFIG_HINT, 502, 'MAIL_OUTLOOK_CONFIG');
    if (error === 'invalid_scope') fail('Outlook 应用缺少权限：请在 Entra 应用的 API 权限里添加 Microsoft Graph 的 Mail.Read 和 User.Read', 502, 'MAIL_OUTLOOK_CONFIG');
    if (error === 'invalid_grant' || error === 'interaction_required') fail('Outlook 登录已过期，请在设置里重新连接', 400, 'MAIL_AUTH_FAILED');
    fail('Microsoft 登录服务暂时不可用，请稍后重试');
  }
  function tokens(data: Json, previousRefreshToken = ''): GraphTokens {
    const accessToken = text(data.access_token);
    // Microsoft normally rotates the refresh token; keep the previous one if a response omits it.
    const refreshToken = text(data.refresh_token) || previousRefreshToken;
    if (!accessToken || !refreshToken) fail('Microsoft 没有返回有效授权，请重新连接');
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in) || 3600;
    return { accessToken, refreshToken, expiresAt: now() + expiresIn * 1000 };
  }
  async function graph(url: string, accessToken: string): Promise<Json> {
    const response = await send(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', Prefer: 'outlook.body-content-type="text"' },
    });
    if (response.ok) return boundedJson(response);
    const error = text(record((await boundedJson(response, 64 * 1024)).error).code);
    if (response.status === 401) fail('Outlook 授权已失效，请在设置里重新连接', 400, 'MAIL_AUTH_FAILED');
    if (error === 'MailboxNotEnabledForRESTAPI' || error === 'MailboxNotHostedInExchangeOnline') fail('这个 Microsoft 账户没有可读取的 Outlook 邮箱', 409, 'MAIL_NO_MAILBOX');
    if (response.status === 403) fail('Outlook 拒绝访问邮件：请重新连接并同意「读取你的邮件」权限', 403, 'MAIL_FORBIDDEN');
    if (response.status === 404) fail('邮件不存在或已被删除', 404, 'MAIL_NOT_FOUND');
    if (response.status === 429) fail('Outlook 请求过于频繁，请稍后再试', 429, 'MAIL_PROVIDER_BUSY');
    fail(`Outlook 读取失败（${response.status}），请稍后重试`);
  }

  return {
    configured: Boolean(deps.clientId),
    // Starts a device-code sign-in. The device code stays on the server; only the user code is shown.
    async startDevice() {
      const result = await identity('/devicecode', { scope: SCOPES });
      if (!result.ok) identityFailure(text(result.data.error));
      const deviceCode = text(result.data.device_code);
      const userCode = text(result.data.user_code);
      if (!deviceCode || !userCode || userCode.length > 32) fail('Microsoft 没有返回登录代码，请稍后重试');
      return {
        deviceCode, userCode,
        verificationUri: verificationUri(result.data.verification_uri),
        expiresIn: Math.min(Math.max(Number(result.data.expires_in) || 900, 60), 1800),
        interval: Math.min(Math.max(Number(result.data.interval) || 5, 1), 60),
      };
    },
    // One token-endpoint poll for a pending device code.
    async pollDevice(deviceCode: string): Promise<DevicePoll> {
      const result = await identity('/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
      if (result.ok) return { kind: 'tokens', tokens: tokens(result.data) };
      const error = text(result.data.error);
      if (error === 'authorization_pending') return { kind: 'pending' };
      if (error === 'slow_down') return { kind: 'slow_down' };
      if (error === 'expired_token' || error === 'code_expired' || error === 'bad_verification_code') return { kind: 'expired' };
      if (error === 'authorization_declined' || error === 'access_denied') return { kind: 'declined' };
      return identityFailure(error);
    },
    async refresh(refreshToken: string) {
      const result = await identity('/token', { grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES });
      if (!result.ok) identityFailure(text(result.data.error));
      return tokens(result.data, refreshToken);
    },
    // The signed-in account's address; personal accounts often expose it only as userPrincipalName.
    async profile(accessToken: string) {
      const data = await graph(graphUrl('/me', { $select: 'displayName,mail,userPrincipalName' }), accessToken);
      const email = text(data.mail) || text(data.userPrincipalName);
      if (!email.includes('@')) fail('无法确认 Outlook 账号');
      return { email, displayName: text(data.displayName) };
    },
    // Newest Inbox messages, or $search (KQL) matches across the mailbox; Graph GETs never mark mail read.
    async list(accessToken: string, query: string, limit: number): Promise<StudioMailRawMessage[]> {
      const url = query
        ? graphUrl('/me/messages', { $search: `"${query.replace(/["\\]/g, ' ').trim()}"`, $top: String(limit), $select: LIST_FIELDS })
        : graphUrl('/me/mailFolders/inbox/messages', { $top: String(limit), $orderby: 'receivedDateTime desc', $select: LIST_FIELDS });
      const data = await graph(url, accessToken);
      const items = Array.isArray(data.value) ? data.value as GraphMessage[] : [];
      return items.filter(item => typeof item?.id === 'string' && MESSAGE_ID.test(item.id))
        .map(item => toRawMessage(item, { kind: 'text', content: text(item.bodyPreview) }));
    },
    async read(accessToken: string, id: string): Promise<StudioMailRawMessage> {
      if (!MESSAGE_ID.test(id)) fail('邮件标识无效', 400, 'MAIL_INVALID_ID');
      const message = await graph(graphUrl(`/me/messages/${encodeURIComponent(id)}`, { $select: READ_FIELDS }), accessToken) as GraphMessage;
      const content = text(message.body?.content);
      return toRawMessage(message, { kind: message.body?.contentType?.toLowerCase() === 'html' ? 'html' : 'text', content });
    },
  };
}
