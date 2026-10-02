import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { AppError } from '@/shared/utils.js';
import type { StudioIngressOrigins, StudioProjectRecord } from '@/shared/types.js';

type Dependencies = {
  database: Database.Database;
  vaultDirectory: string;
  project: (userId: number, id: string) => StudioProjectRecord;
  clientId?: string;
  clientSecret?: string;
  /**
   * Studio's front doors (docs/network.md), already validated: studio.module passes
   * readStudioIngressOrigins(process.env), which never throws, so a malformed origin only disables
   * Gmail instead of stopping the server. Without any door Gmail OAuth is unconfigured.
   */
  doors?: () => StudioIngressOrigins;
  request?: typeof fetch;
};
/** Where the Connect request came from: its Origin header and, as a fallback, its Host header. */
type RequestDoor = { origin?: string; host?: string };
type Tokens = { access_token: string; refresh_token?: string; expires_at: number; email: string };
type GmailMessage = {
  id: string; snippet?: string; internalDate?: string;
  payload?: { headers?: { name: string; value: string }[]; mimeType?: string; body?: { data?: string }; parts?: GmailMessage['payload'][] };
};
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function fail(message: string, statusCode = 400): never {
  throw new AppError(message, { statusCode, code: 'PROJECT_MAIL_ERROR' });
}

/** Used by studio.module and tests for user/project-bound Gmail read-only OAuth. SMTP passwords are neither read nor accepted. */
export function createProjectMailService(deps: Dependencies) {
  const db = deps.database;
  const request = deps.request ?? fetch;
  // `door` is the configured origin the flow started from; Google calls back there and the user returns there.
  const pending = new Map<string, { userId: number; projectId: string; verifier: string; expires: number; door: string }>();
  db.exec('CREATE TABLE IF NOT EXISTS studio_project_mail (project_id TEXT PRIMARY KEY, encrypted_tokens TEXT NOT NULL)');

  // Configured doors, public (the default) first.
  function doors(): string[] {
    const origins = deps.doors?.();
    return origins ? [origins.public, origins.tailnet].filter((door): door is string => door !== null) : [];
  }
  // The door the user is on, when it is one of the configured doors (the Origin header first, then
  // the Host header); otherwise the default door. A request can only pick among configured doors.
  function chooseDoor(from: RequestDoor): string | null {
    const configured = doors();
    const parse = (value: string) => { try { return new URL(value); } catch { return null; } };
    const origin = from.origin ? parse(from.origin)?.origin : undefined;
    const byOrigin = configured.find(door => door === origin);
    const byHost = from.host ? configured.find(door => parse(door)?.host === from.host?.trim().toLowerCase()) : undefined;
    return byOrigin ?? byHost ?? configured[0] ?? null;
  }
  const callbackUrl = (door: string) => `${door}/api/studio/gmail/callback`;
  function check(userId: number, id: string) {
    const project = deps.project(userId, id);
    if (!project.modules.includes('mail')) fail('邮箱模块未启用');
    return project;
  }
  function key() {
    mkdirSync(deps.vaultDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(deps.vaultDirectory, 'gmail.key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    const value = readFileSync(file);
    if (value.length !== 32) fail('邮箱密钥库不可用', 500);
    return value;
  }
  function load(id: string): Tokens | null {
    const row = db.prepare('SELECT encrypted_tokens FROM studio_project_mail WHERE project_id = ?').get(id) as { encrypted_tokens: string } | undefined;
    if (!row) return null;
    const [iv, tag, body] = row.encrypted_tokens.split('.').map(value => Buffer.from(value, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as Tokens;
  }
  function save(id: string, tokens: Tokens) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    db.prepare('INSERT INTO studio_project_mail VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET encrypted_tokens = excluded.encrypted_tokens')
      .run(id, [iv, cipher.getAuthTag(), body].map(value => value.toString('base64')).join('.'));
  }
  async function tokenRequest(params: Record<string, string>) {
    if (!deps.clientId || !deps.clientSecret) fail('Gmail OAuth 尚未配置', 503);
    let response: Response;
    try {
      response = await request('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, client_id: deps.clientId, client_secret: deps.clientSecret }),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { fail('Google 授权服务暂不可用', 502); }
    if (!response.ok) fail('Gmail 授权失败，请重新连接', 502);
    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!data.access_token) fail('Google 没有返回有效授权', 502);
    return { ...data, access_token: data.access_token };
  }
  async function access(id: string) {
    const tokens = load(id);
    if (!tokens) fail('请先连接 Gmail', 409);
    if (tokens.expires_at > Date.now() + 60000) return tokens;
    if (!tokens.refresh_token) fail('Gmail 授权已到期，请重新连接', 409);
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    const next = { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 };
    save(id, next);
    return next;
  }
  async function gmail(url: string, token: string) {
    let response: Response;
    try {
      response = await request(url, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { fail('Gmail 暂时无法连接', 502); }
    if (!response.ok) fail(response.status === 401 ? 'Gmail 授权已失效，请重新连接' : `Gmail 查询失败（${response.status}）`, 502);
    return response.json();
  }
  return {
    // Called when a project is deleted; drops its encrypted Gmail tokens.
    forget(projectId: string) { db.prepare('DELETE FROM studio_project_mail WHERE project_id = ?').run(projectId); },
    status(userId: number, id: string) {
      check(userId, id);
      const tokens = load(id);
      return { configured: Boolean(deps.clientId && deps.clientSecret && doors().length > 0), connected: Boolean(tokens), email: tokens?.email ?? null, access: 'readonly' };
    },
    /**
     * Starts the OAuth flow from the door the user is on (docs/network.md), so Google calls back to
     * that door's /api/studio/gmail/callback and the user lands back on a page that is signed in.
     * Both callbacks must be registered with the Google OAuth client.
     */
    begin(userId: number, projectId: string, from: RequestDoor = {}) {
      check(userId, projectId);
      const door = chooseDoor(from);
      if (!deps.clientId || !deps.clientSecret || !door) fail('Gmail OAuth 尚未配置', 503);
      for (const [state, value] of pending) if (value.expires < Date.now()) pending.delete(state);
      if (pending.size > 100) fail('授权请求过多，请稍后重试', 429);
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      pending.set(state, { userId, projectId, verifier, expires: Date.now() + 600000, door });
      const params = new URLSearchParams({
        client_id: deps.clientId, redirect_uri: callbackUrl(door), response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      });
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
    },
    async complete(state: string, code: string) {
      const attempt = pending.get(state);
      pending.delete(state);
      if (!attempt || attempt.expires < Date.now() || !code) fail('邮箱授权请求已失效，请重新连接');
      check(attempt.userId, attempt.projectId);
      // Google requires the same redirect_uri as in the authorization request.
      const data = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: callbackUrl(attempt.door), code_verifier: attempt.verifier });
      if (!data.scope?.split(' ').includes(SCOPE)) fail('未授予邮箱只读权限');
      const profile = await gmail(`${GMAIL}/profile`, data.access_token) as { emailAddress?: string };
      if (!profile.emailAddress) fail('无法确认 Gmail 账号', 502);
      const previous = load(attempt.projectId);
      save(attempt.projectId, {
        access_token: data.access_token, refresh_token: data.refresh_token ?? (previous?.email === profile.emailAddress ? previous.refresh_token : undefined),
        expires_at: Date.now() + (data.expires_in ?? 3600) * 1000, email: profile.emailAddress,
      });
      return `${attempt.door}/projects/${encodeURIComponent(attempt.projectId)}?view=mail`;
    },
    async search(userId: number, id: string, query: string) {
      check(userId, id);
      if (query.length > 500) fail('搜索条件过长');
      const tokens = await access(id);
      const listing = await gmail(`${GMAIL}/messages?${new URLSearchParams({ q: query || 'in:inbox', maxResults: '20' })}`, tokens.access_token) as { messages?: { id: string }[] };
      return Promise.all((listing.messages ?? []).map(async item => {
        const message = await gmail(`${GMAIL}/messages/${encodeURIComponent(item.id)}?format=metadata`, tokens.access_token) as GmailMessage;
        const header = (name: string) => message.payload?.headers?.find(value => value.name.toLowerCase() === name)?.value ?? '';
        return { id: message.id, subject: header('subject'), from: header('from'), date: header('date'), snippet: message.snippet ?? '' };
      }));
    },
    async message(userId: number, id: string, messageId: string) {
      check(userId, id);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(messageId)) fail('邮件标识无效');
      const tokens = await access(id);
      const message = await gmail(`${GMAIL}/messages/${messageId}?format=full`, tokens.access_token) as GmailMessage;
      function plain(part: GmailMessage['payload']): string {
        if (!part) return '';
        if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
        return (part.parts ?? []).map(plain).filter(Boolean).join('\n');
      }
      return { id: message.id, text: (plain(message.payload) || message.snippet || '').slice(0, 20000) };
    },
  };
}
