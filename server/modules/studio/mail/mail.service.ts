import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { AppError, toIsoDateOrEmpty } from '@/shared/utils.js';
import type { StudioMailRawBody, StudioMailRawMessage, StudioOutlookTokens } from '@/shared/types.js';

import { createGmailImapAdapter } from './gmail-imap.adapter.js';
import { createOutlookGraphAdapter } from './outlook-graph.adapter.js';

type Provider = 'gmail-imap' | 'outlook' | 'gmail-oauth';
type AccountStatus = 'ok' | 'error' | 'reauth';
// Public account metadata; mirrors StudioMailAccount in the client contract and never carries secrets.
type MailAccount = { id: string; provider: Provider; email: string; displayName: string; status: AccountStatus; lastError: string | null; createdAt: string };
type MailMessage = { id: string; accountId: string; subject: string; from: string; fromAddress: string; date: string; snippet: string; unread: boolean };
type MailMessageDetail = MailMessage & { to: string; text: string; truncated: boolean };
type AccountRow = {
  id: string; user_id: number; provider: 'gmail-imap' | 'outlook'; email: string; display_name: string;
  encrypted_secret: string; status: AccountStatus; last_error: string | null; created_at: string;
};
type ImapSecret = { password: string };
// One failure of an account in the unified inbox; `skipped` marks a search the account's provider cannot run.
type AccountFailure = { accountId: string; email: string; message: string; skipped?: true };
// Consecutive provider failures of one account and when Studio may contact the provider again.
type FailureStreak = { count: number; retryAt: number };
type DeviceFlow = { userId: number; deviceCode: string; expiresAt: number; interval: number; nextPollAt: number };
// The project-bound Gmail OAuth connections (project-mail.service), shown as read-only legacy accounts.
type LegacyGmail = {
  accounts(userId: number): { projectId: string; projectName: string; email: string }[];
  search(userId: number, projectId: string, query: string): Promise<{ id: string; subject: string; from: string; date: string; snippet: string }[]>;
  message(userId: number, projectId: string, messageId: string): Promise<{ id: string; text: string }>;
  forget(userId: number, projectId: string): void;
};
type Dependencies = {
  database: Database.Database;
  vaultDirectory: string;
  // STUDIO_OUTLOOK_CLIENT_ID: a public-client Microsoft Entra app id (no secret).
  outlookClientId?: string;
  // Test seams: an IMAP session factory and fetch. Production uses imapflow and the global fetch.
  imapConnect?: NonNullable<Parameters<typeof createGmailImapAdapter>[0]>['connect'];
  imapTimeoutMs?: number;
  request?: typeof fetch;
  now?: () => number;
  legacyGmail?: LegacyGmail;
};

const COLUMNS = 'id, user_id, provider, email, display_name, encrypted_secret, status, last_error, created_at';
const MAX_ACCOUNTS = 10;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
// A unified inbox merges every account's newest messages and shows at most this many.
const MAX_MERGED = 120;
const MAX_QUERY = 300;
const SUBJECT_CHARS = 300;
const NAME_CHARS = 200;
const SNIPPET_CHARS = 200;
const BODY_CHARS = 50_000;
// App Password attempts per user per window; each one is a real Google login.
const VERIFY_ATTEMPTS = 6;
const VERIFY_WINDOW_MS = 10 * 60_000;
// After this many consecutive provider failures (timeouts, network, busy, provider errors) an account cools
// down: no connection for COOLDOWN_MS, doubling with each further failure up to MAX_COOLDOWN_MS. A success,
// replaced credentials or removing the account ends the streak. Rejected credentials pause the account instead.
const FAILURES_BEFORE_COOLDOWN = 2;
const COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const MAX_PENDING_DEVICE_FLOWS = 50;
const ACCOUNT_ID = /^[A-Za-z0-9-]{1,100}$/;
const LEGACY_PREFIX = 'gmail-oauth-';
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
// C0/C1 controls (except tab/newline), bidi overrides and invisible padding newsletters use in previews.
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]|\u034F/g;
// Gmail search operators that Outlook's KQL does not know. A query using one skips Outlook accounts with a notice
// instead of sending Graph a search it rejects or misreads; operators both understand (from:, to:, subject:…) do not.
const GMAIL_ONLY_OPERATOR = /(?:^|[\s(])-?(?:is|in|label|has|after|before|older|newer|older_than|newer_than|filename|category|larger|smaller|list|deliveredto|rfc822msgid):/i;
// Elements whose content is never readable text; removed whole, or to the end when a size cap cut them off.
const HIDDEN_BLOCKS = /<(script|style|head|title|noscript|template|svg|object|iframe)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', zwnj: '', zwj: '' };

function fail(message: string, statusCode = 400, code = 'MAIL_ERROR'): never {
  throw new AppError(message, { statusCode, code });
}

function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? entity;
    const point = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return point > 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF) ? String.fromCodePoint(point) : ' ';
  });
}

// Markup is removed, never rendered: hidden blocks (style, script, head…) go entirely, block ends become
// line breaks, every remaining tag (including one cut off by a size cap) is dropped, entities are decoded.
function htmlToPlain(html: string) {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(HIDDEN_BLOCKS, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|tr|li|ul|ol|h[1-6]|blockquote|table|section|article|header|footer|pre)\s*>/gi, '\n')
    .replace(/<[^>]*(?:>|$)/g, ' '));
}

// Bulk without readable text, removed from the whole HTML before the size cap so the cap is spent on text:
// comments, hidden blocks and inline data: URIs in attributes or url() (often megabytes of base64 images).
// Every pattern is linear, so this stays cheap on the multi-megabyte bodies the adapters allow.
function stripBulkyMarkup(html: string) {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(HIDDEN_BLOCKS, ' ')
    .replace(/(=\s*["']?|url\(\s*["']?)data:[^"'\s>)]*/gi, '$1');
}

// Safe plain text: no markup, no control or direction-override characters, tidy whitespace, hard length cap.
// `truncated` is true when either the text or the source it came from was cut.
function plainText(body: StudioMailRawBody, limit: number) {
  const isHtml = body.kind === 'html';
  const source = isHtml ? stripBulkyMarkup(body.content) : body.content;
  const sourceCap = isHtml ? limit * 8 : limit * 2;
  const capped = source.slice(0, sourceCap);
  const text = (isHtml ? htmlToPlain(capped) : capped).replace(/\r\n?/g, '\n').replace(UNSAFE_CHARACTERS, '')
    .split('\n').map(line => line.replace(/[ \t\u00A0\u3000]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return { text: text.slice(0, limit), truncated: text.length > limit || source.length > sourceCap };
}

// A quoted phrase is literal text, so `"is:unread"` is not an operator.
function usesGmailOnlySyntax(query: string) {
  return GMAIL_ONLY_OPERATOR.test(query.replace(/"[^"]*"/g, ' '));
}

function isAuthFailure(error: unknown) {
  return error instanceof AppError && error.code === 'MAIL_AUTH_FAILED';
}

function line(value: string, limit: number) {
  return value.replace(UNSAFE_CHARACTERS, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// "Name <address>" header text from the legacy Gmail API listing.
function splitSender(value: string) {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (match) return { name: match[1].trim() || match[2], address: match[2] };
  return { name: value.trim(), address: value.includes('@') ? value.trim() : '' };
}

function summary(accountId: string, raw: StudioMailRawMessage): MailMessage {
  return {
    id: raw.id, accountId,
    subject: line(raw.subject, SUBJECT_CHARS),
    from: line(raw.from, NAME_CHARS),
    fromAddress: line(raw.fromAddress, NAME_CHARS),
    date: toIsoDateOrEmpty(raw.date),
    snippet: line(plainText(raw.body, SNIPPET_CHARS * 4).text, SNIPPET_CHARS),
    unread: raw.unread,
  };
}

/** Used by studio.module (mounted at /api/studio/mail) and its tests: per-user read-only mail accounts for Gmail and Outlook. */
export function createMailService(deps: Dependencies) {
  const db = deps.database;
  const now = deps.now ?? Date.now;
  const imap = createGmailImapAdapter({ connect: deps.imapConnect, operationTimeoutMs: deps.imapTimeoutMs });
  const outlook = createOutlookGraphAdapter({ clientId: deps.outlookClientId, request: deps.request, now });
  const deviceFlows = new Map<string, DeviceFlow>();
  const verifyAttempts = new Map<number, number[]>();
  // One refresh per Outlook account at a time, so concurrent reads never race a rotating refresh token.
  const refreshing = new Map<string, Promise<StudioOutlookTokens>>();
  // Per-account failure streaks driving the cooldown (in memory: a restart simply allows one fresh attempt).
  const failureStreaks = new Map<string, FailureStreak>();
  // Identical listings already running (a double tap, a filter switched away and back) share one provider
  // session instead of opening another login.
  const listings = new Map<string, Promise<MailMessage[]>>();
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_mail_accounts (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL, email TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '', encrypted_secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok', last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (user_id, provider, email)
    );
    CREATE INDEX IF NOT EXISTS studio_mail_accounts_user ON studio_mail_accounts (user_id);
  `);

  function vaultKey() {
    mkdirSync(deps.vaultDirectory, { recursive: true, mode: 0o700 });
    const file = path.join(deps.vaultDirectory, 'mail.key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    const key = readFileSync(file);
    if (key.length !== 32) fail('邮箱密钥库不可用', 500, 'MAIL_VAULT');
    return key;
  }
  function encrypt(secret: ImapSecret | StudioOutlookTokens) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', vaultKey(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map(value => value.toString('base64')).join('.');
  }
  function decrypt<T>(row: AccountRow): T {
    try {
      const [iv, tag, body] = row.encrypted_secret.split('.').map(value => Buffer.from(value, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', vaultKey(), iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail('邮箱凭据无法解密，请删除这个账户后重新添加', 500, 'MAIL_VAULT');
    }
  }
  function publicAccount(row: AccountRow): MailAccount {
    return { id: row.id, provider: row.provider, email: row.email, displayName: row.display_name, status: row.status, lastError: row.last_error, createdAt: row.created_at };
  }
  function rows(userId: number) {
    return db.prepare(`SELECT ${COLUMNS} FROM studio_mail_accounts WHERE user_id = ? ORDER BY created_at, email`).all(userId) as AccountRow[];
  }
  function legacyAccounts(userId: number): MailAccount[] {
    if (!deps.legacyGmail) return [];
    try {
      return deps.legacyGmail.accounts(userId).map(item => ({
        id: `${LEGACY_PREFIX}${item.projectId}`, provider: 'gmail-oauth', email: item.email,
        displayName: `项目「${item.projectName}」`, status: 'ok', lastError: null, createdAt: '',
      }));
    } catch { return []; }
  }
  function findAccount(userId: number, accountId: string): { row: AccountRow | null; account: MailAccount } {
    if (!ACCOUNT_ID.test(accountId)) fail('邮箱账户标识无效');
    if (accountId.startsWith(LEGACY_PREFIX)) {
      const account = legacyAccounts(userId).find(item => item.id === accountId);
      if (!account) fail('邮箱账户不存在', 404, 'MAIL_ACCOUNT_NOT_FOUND');
      return { row: null, account };
    }
    const row = db.prepare(`SELECT ${COLUMNS} FROM studio_mail_accounts WHERE user_id = ? AND id = ?`).get(userId, accountId) as AccountRow | undefined;
    if (!row) fail('邮箱账户不存在', 404, 'MAIL_ACCOUNT_NOT_FOUND');
    return { row, account: publicAccount(row) };
  }
  // Same address re-added = credentials replaced (re-verification), never a duplicate account. Replacing them
  // lifts a reauth pause and ends any failure cooldown, so the account is read again right away.
  function upsert(userId: number, provider: 'gmail-imap' | 'outlook', email: string, displayName: string, secret: ImapSecret | StudioOutlookTokens) {
    const timestamp = new Date(now()).toISOString();
    const normalized = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM studio_mail_accounts WHERE user_id = ? AND provider = ? AND email = ?').get(userId, provider, normalized) as { id: string } | undefined;
    if (!existing && rows(userId).length >= MAX_ACCOUNTS) fail(`最多添加 ${MAX_ACCOUNTS} 个邮箱账户`, 409, 'MAIL_TOO_MANY_ACCOUNTS');
    const id = existing?.id ?? randomUUID();
    db.prepare(`INSERT INTO studio_mail_accounts (id, user_id, provider, email, display_name, encrypted_secret, status, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, encrypted_secret = excluded.encrypted_secret,
        status = 'ok', last_error = NULL, updated_at = excluded.updated_at`)
      .run(id, userId, provider, normalized, line(displayName, NAME_CHARS), encrypt(secret), timestamp, timestamp);
    failureStreaks.delete(id);
    return findAccount(userId, id).account;
  }
  // Health bookkeeping after every provider call: the stored status (a rejected credential becomes `reauth`, which
  // pauses the account) and the in-memory streak of other failures that drives the cooldown.
  function recordOutcome(row: AccountRow, error: unknown) {
    const status: AccountStatus = !error ? 'ok' : isAuthFailure(error) ? 'reauth' : 'error';
    if (status === 'error') {
      const count = (failureStreaks.get(row.id)?.count ?? 0) + 1;
      const cooldown = count < FAILURES_BEFORE_COOLDOWN ? 0 : Math.min(COOLDOWN_MS * 2 ** (count - FAILURES_BEFORE_COOLDOWN), MAX_COOLDOWN_MS);
      failureStreaks.set(row.id, { count, retryAt: now() + cooldown });
    } else failureStreaks.delete(row.id);
    const message = error ? (error instanceof AppError ? error.message : '读取失败') : null;
    if (row.status === status && row.last_error === message) return;
    db.prepare('UPDATE studio_mail_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, message, new Date(now()).toISOString(), row.id);
  }
  // Runs before any login: an account whose credential the provider rejected stays untouched until the user
  // replaces it (each retry with a revoked App Password is another failed Google login and risks an IMAP lock),
  // and an account in a failure cooldown waits for it to pass.
  function assertContactable(row: AccountRow) {
    if (row.status === 'reauth') {
      fail(row.provider === 'outlook'
        ? 'Outlook 授权已失效，Studio 已暂停读取这个账户：请在设置里重新连接 Outlook'
        : '应用专用密码已失效，Studio 已暂停读取这个账户：请在设置里用新的应用专用密码重新验证', 409, 'MAIL_REAUTH_REQUIRED');
    }
    const streak = failureStreaks.get(row.id);
    if (streak && streak.retryAt > now()) {
      const minutes = Math.max(1, Math.ceil((streak.retryAt - now()) / 60_000));
      const reason = (row.last_error ?? '读取失败').replace(/[，。,.]?请稍后(?:重试|再试)[。.]?$/, '');
      fail(`${reason}。连续失败，已暂停读取，约 ${minutes} 分钟后自动重试`, 503, 'MAIL_COOLING_DOWN');
    }
  }
  async function refreshOutlook(row: AccountRow, current: StudioOutlookTokens) {
    const inFlight = refreshing.get(row.id);
    if (inFlight) return inFlight;
    const next = (async () => {
      const tokens = await outlook.refresh(current.refreshToken);
      db.prepare('UPDATE studio_mail_accounts SET encrypted_secret = ?, updated_at = ? WHERE id = ?').run(encrypt(tokens), new Date(now()).toISOString(), row.id);
      return tokens;
    })();
    refreshing.set(row.id, next);
    try { return await next; } finally { refreshing.delete(row.id); }
  }
  // Access tokens are refreshed on demand: shortly before expiry, and once more if Graph rejects one early.
  async function withOutlookToken<T>(row: AccountRow, work: (accessToken: string) => Promise<T>) {
    let secret = decrypt<StudioOutlookTokens>(row);
    if (secret.expiresAt <= now() + 60_000) secret = await refreshOutlook(row, secret);
    try {
      return await work(secret.accessToken);
    } catch (error) {
      if (!isAuthFailure(error)) throw error;
      secret = await refreshOutlook(row, secret);
      return work(secret.accessToken);
    }
  }
  async function listAccount(userId: number, found: ReturnType<typeof findAccount>, query: string, limit: number) {
    const { row, account } = found;
    if (!row) {
      const projectId = account.id.slice(LEGACY_PREFIX.length);
      const items = await deps.legacyGmail!.search(userId, projectId, query);
      return items.slice(0, limit).map(item => {
        const sender = splitSender(item.from);
        return summary(account.id, { id: item.id, subject: item.subject, from: sender.name, fromAddress: sender.address, to: '', date: item.date, unread: false, body: { kind: 'text', content: item.snippet }, truncated: false });
      });
    }
    // Checked before anything else so a Gmail-only search never counts against the Outlook account's health.
    if (row.provider === 'outlook' && query && usesGmailOnlySyntax(query)) {
      fail('这个搜索用了 Gmail 专用语法（如 is:、label:、after:），Outlook 不支持，已跳过这个账户', 400, 'MAIL_QUERY_UNSUPPORTED');
    }
    assertContactable(row);
    const key = `${row.id}\n${limit}\n${query}`;
    const running = listings.get(key);
    if (running) return running;
    const listing = (async () => {
      try {
        const raw = row.provider === 'gmail-imap'
          ? await imap.list({ email: row.email, password: decrypt<ImapSecret>(row).password }, query, limit)
          : await withOutlookToken(row, token => outlook.list(token, query, limit));
        recordOutcome(row, null);
        return raw.map(item => summary(account.id, item));
      } catch (error) {
        recordOutcome(row, error);
        throw error;
      }
    })();
    listings.set(key, listing);
    try { return await listing; } finally { listings.delete(key); }
  }
  function cleanQuery(query: string) {
    const value = query.replace(UNSAFE_CHARACTERS, ' ').trim();
    if (value.length > MAX_QUERY) fail('搜索条件过长');
    return value;
  }

  return {
    accounts(userId: number) {
      return { accounts: [...rows(userId).map(publicAccount), ...legacyAccounts(userId)], outlookConfigured: outlook.configured };
    },

    // Verifies the App Password with a real (read-only) IMAP login before anything is stored.
    async addGmailImap(userId: number, input: { email: string; password: string }) {
      const email = input.email.trim().toLowerCase();
      if (email.length > 254 || !EMAIL.test(email)) fail('请输入有效的 Gmail 地址');
      // Google shows App Passwords as "abcd efgh ijkl mnop"; spaces are not part of the password.
      const password = input.password.replace(/\s+/g, '');
      if (!/^[a-z]{16}$/i.test(password)) fail('应用专用密码是 16 位字母（可以直接粘贴带空格的格式），不是 Google 账号密码');
      const recent = (verifyAttempts.get(userId) ?? []).filter(at => at > now() - VERIFY_WINDOW_MS);
      if (recent.length >= VERIFY_ATTEMPTS) fail('尝试次数过多，请 10 分钟后再试', 429, 'MAIL_RATE_LIMITED');
      verifyAttempts.set(userId, [...recent, now()]);
      await imap.verify({ email, password });
      return upsert(userId, 'gmail-imap', email, '', { password });
    },

    // Starts an Outlook device-code sign-in; one active flow per user, the device code never leaves the server.
    async startOutlookDevice(userId: number) {
      for (const [id, flow] of deviceFlows) if (flow.expiresAt <= now() || flow.userId === userId) deviceFlows.delete(id);
      if (deviceFlows.size >= MAX_PENDING_DEVICE_FLOWS) fail('登录请求过多，请稍后再试', 429, 'MAIL_RATE_LIMITED');
      const device = await outlook.startDevice();
      const pollId = randomBytes(24).toString('base64url');
      const expiresAt = now() + device.expiresIn * 1000;
      deviceFlows.set(pollId, { userId, deviceCode: device.deviceCode, expiresAt, interval: device.interval * 1000, nextPollAt: now() + device.interval * 1000 });
      return { pollId, userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: new Date(expiresAt).toISOString(), interval: device.interval };
    },

    // Polls Microsoft at most once per server-side interval, so a fast client cannot trigger slow_down.
    async pollOutlookDevice(userId: number, pollId: string): Promise<{ status: 'pending' | 'connected' | 'expired' | 'error'; account?: MailAccount; message?: string }> {
      const flow = deviceFlows.get(pollId);
      if (!flow || flow.userId !== userId) fail('登录请求不存在或已结束，请重新开始', 404, 'MAIL_DEVICE_NOT_FOUND');
      if (now() >= flow.expiresAt) { deviceFlows.delete(pollId); return { status: 'expired' }; }
      if (now() < flow.nextPollAt) return { status: 'pending' };
      flow.nextPollAt = now() + flow.interval;
      try {
        const result = await outlook.pollDevice(flow.deviceCode);
        if (result.kind === 'pending') return { status: 'pending' };
        if (result.kind === 'slow_down') {
          flow.interval += 5000;
          flow.nextPollAt = now() + flow.interval;
          return { status: 'pending' };
        }
        deviceFlows.delete(pollId);
        if (result.kind === 'expired') return { status: 'expired' };
        if (result.kind === 'declined') return { status: 'error', message: '你在 Microsoft 页面拒绝了授权' };
        const profile = await outlook.profile(result.tokens.accessToken);
        return { status: 'connected', account: upsert(userId, 'outlook', profile.email, profile.displayName, result.tokens) };
      } catch (error) {
        deviceFlows.delete(pollId);
        return { status: 'error', message: error instanceof AppError ? error.message : 'Outlook 登录失败，请重试' };
      }
    },

    removeAccount(userId: number, accountId: string) {
      const { row, account } = findAccount(userId, accountId);
      if (row) {
        db.prepare('DELETE FROM studio_mail_accounts WHERE user_id = ? AND id = ?').run(userId, row.id);
        failureStreaks.delete(row.id);
      } else deps.legacyGmail!.forget(userId, account.id.slice(LEGACY_PREFIX.length));
      return { removed: true };
    },

    // One account (the Studio inbox asks per account, so a slow server never holds back the others), or every
    // account in parallel, newest first. A failing, paused or skipped account never hides the others.
    async messages(userId: number, input: { accountId?: string; query?: string; limit?: number }) {
      const query = cleanQuery(input.query ?? '');
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const targets = input.accountId ? [findAccount(userId, input.accountId)]
        : [...rows(userId).map(row => ({ row, account: publicAccount(row) })), ...legacyAccounts(userId).map(account => ({ row: null, account }))];
      const results = await Promise.all(targets.map(async target => {
        try { return { messages: await listAccount(userId, target, query, limit), error: null }; }
        catch (error) {
          const failure: AccountFailure = { accountId: target.account.id, email: target.account.email, message: error instanceof AppError ? error.message : '读取失败，请稍后重试' };
          if (error instanceof AppError && error.code === 'MAIL_QUERY_UNSUPPORTED') failure.skipped = true;
          return { messages: [], error: failure };
        }
      }));
      const messages = results.flatMap(result => result.messages)
        .sort((left, right) => right.date.localeCompare(left.date))
        .slice(0, input.accountId ? limit : MAX_MERGED);
      return { messages, errors: results.flatMap(result => result.error ? [result.error] : []) };
    },

    // One message as capped, markup-free plain text. Opening never marks it read on the provider.
    async message(userId: number, accountId: string, messageId: string): Promise<MailMessageDetail> {
      const { row, account } = findAccount(userId, accountId);
      if (!messageId || messageId.length > 512) fail('邮件标识无效', 400, 'MAIL_INVALID_ID');
      let raw: StudioMailRawMessage;
      if (!row) {
        const result = await deps.legacyGmail!.message(userId, account.id.slice(LEGACY_PREFIX.length), messageId);
        raw = { id: result.id, subject: '', from: '', fromAddress: '', to: '', date: '', unread: false, body: { kind: 'text', content: result.text }, truncated: false };
      } else {
        assertContactable(row);
        try {
          raw = row.provider === 'gmail-imap'
            ? await imap.read({ email: row.email, password: decrypt<ImapSecret>(row).password }, messageId)
            : await withOutlookToken(row, token => outlook.read(token, messageId));
          recordOutcome(row, null);
        } catch (error) {
          // A missing message or bad id says nothing about the account's health.
          if (!(error instanceof AppError && ['MAIL_NOT_FOUND', 'MAIL_INVALID_ID'].includes(error.code))) recordOutcome(row, error);
          throw error;
        }
      }
      const body = plainText(raw.body, BODY_CHARS);
      return { ...summary(account.id, raw), to: line(raw.to, 1000), text: body.text, truncated: raw.truncated || body.truncated };
    },
  };
}
