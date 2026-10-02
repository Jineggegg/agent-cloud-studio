import { ImapFlow } from 'imapflow';
import type { ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';

import { AppError, toIsoDateOrEmpty } from '@/shared/utils.js';
import type { StudioMailRawMessage } from '@/shared/types.js';

type ImapAddress = { name?: string; address?: string };
// The subset of imapflow's FetchMessageObject this adapter reads.
type ImapFetchedMessage = {
  uid: number;
  flags?: Set<string>;
  internalDate?: Date | string;
  envelope?: { date?: Date | string; subject?: string; from?: ImapAddress[]; to?: ImapAddress[] };
  source?: Buffer;
};
// Read-only by construction: the session offers no command that could store flags, move or delete mail.
type ImapSession = {
  connect(): Promise<void>;
  // EXAMINE, never SELECT, so fetching a body can never set \Seen.
  openReadOnly(path: string): Promise<{ exists: number }>;
  // Path of the mailbox carrying a special-use flag (Gmail's "All Mail" is \All), or null.
  specialUseMailbox(flag: string): Promise<string | null>;
  // UIDs matching a Gmail search expression (X-GM-RAW) in the open mailbox.
  searchGmail(query: string): Promise<number[]>;
  // Envelope, flags, date and the first `previewBytes` of each source (BODY.PEEK) for a range.
  fetchPreviews(range: string, byUid: boolean, previewBytes: number): Promise<ImapFetchedMessage[]>;
  // One message with at most `maxBytes` of its source (BODY.PEEK), or null when the UID is gone.
  fetchMessage(uid: number, maxBytes: number): Promise<ImapFetchedMessage | null>;
  logout(): Promise<void>;
  close(): void;
};
type ImapConnectOptions = { host: string; port: number; user: string; pass: string };
type ImapConnect = (options: ImapConnectOptions) => ImapSession;
type Credentials = { email: string; password: string };

const GMAIL_IMAP = { host: 'imap.gmail.com', port: 993 };
// Gmail's own headers are often 5-10 KB, so previews read enough to reach the first text part.
const PREVIEW_BYTES = 24 * 1024;
// A single opened message; larger sources (attachments) are cut and reported as truncated.
const MESSAGE_BYTES = 4 * 1024 * 1024;
// Whole-operation deadline (connect, login, open, search, fetch); the socket is closed when it passes.
const OPERATION_MS = 45_000;
const LOGOUT_MS = 3_000;
const PARSER_OPTIONS = { skipHtmlToText: true, skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true } as const;
const TIMEOUT_CODES = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEOUT', 'ETIMEDOUT', 'LockTimeout']);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectTLS']);
// Listing ids say which mailbox the UID belongs to: i = INBOX, a = All Mail (search results).
const MESSAGE_ID = /^([ia])([1-9]\d{0,9})$/;

/**
 * Used by the Gmail IMAP adapter as its default transport (tests inject a fake). Wraps imapflow with
 * fixed timeouts, TLS, no logging (so credentials never reach logs) and a read-only command surface.
 */
export function connectImapFlow(options: ImapConnectOptions, Client: new (options: ImapFlowOptions) => ImapFlow = ImapFlow): ImapSession {
  const client = new Client({
    host: options.host, port: options.port, secure: true,
    auth: { user: options.user, pass: options.pass },
    logger: false, disableAutoIdle: true,
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
    maxLiteralSize: 8 * 1024 * 1024, maxResponseSize: 16 * 1024 * 1024,
  });
  // imapflow emits socket errors as events; without a listener they would crash the process.
  client.on('error', () => {});
  return {
    connect: () => client.connect(),
    async openReadOnly(path) {
      const mailbox = await client.mailboxOpen(path, { readOnly: true });
      return { exists: mailbox.exists };
    },
    async specialUseMailbox(flag) {
      return (await client.list()).find(mailbox => mailbox.specialUse === flag)?.path ?? null;
    },
    async searchGmail(query) {
      const result = await client.search({ gmraw: query }, { uid: true });
      return Array.isArray(result) ? result : [];
    },
    async fetchPreviews(range, byUid, previewBytes) {
      return client.fetchAll(range, { uid: true, flags: true, envelope: true, internalDate: true, source: { maxLength: previewBytes } }, { uid: byUid });
    },
    async fetchMessage(uid, maxBytes) {
      const message = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true, internalDate: true, source: { maxLength: maxBytes } }, { uid: true });
      return message || null;
    },
    logout: () => client.logout(),
    close: () => client.close(),
  };
}

function addressList(addresses: ImapAddress[] | undefined) {
  return (addresses ?? []).map(item => item.name && item.address ? `${item.name} <${item.address}>` : item.address ?? item.name ?? '')
    .filter(Boolean).join(', ');
}

// Bodies come from mailparser with HTML-to-text disabled, so `text` is a real text/plain part when present;
// otherwise the HTML is handed on and the mail service reduces it to plain text.
async function toRawMessage(mailbox: 'i' | 'a', message: ImapFetchedMessage, sourceCap: number): Promise<StudioMailRawMessage> {
  const parsed = message.source?.length ? await simpleParser(message.source, PARSER_OPTIONS).catch(() => null) : null;
  const sender = message.envelope?.from?.[0];
  const text = parsed?.text?.trim() ? parsed.text : '';
  const html = typeof parsed?.html === 'string' ? parsed.html : '';
  return {
    id: `${mailbox}${message.uid}`,
    subject: message.envelope?.subject ?? parsed?.subject ?? '',
    from: sender?.name || sender?.address || '',
    fromAddress: sender?.address ?? '',
    to: addressList(message.envelope?.to),
    date: toIsoDateOrEmpty(message.internalDate ?? message.envelope?.date),
    unread: !message.flags?.has('\\Seen'),
    body: text ? { kind: 'text', content: text } : { kind: 'html', content: html },
    truncated: (message.source?.length ?? 0) >= sourceCap,
  };
}

function newestFirst(messages: ImapFetchedMessage[]) {
  const time = (message: ImapFetchedMessage) => new Date(message.internalDate ?? message.envelope?.date ?? 0).getTime() || 0;
  return [...messages].sort((left, right) => time(right) - time(left) || right.uid - left.uid);
}

// Provider errors become short Chinese messages; server response text is never echoed to the browser.
function imapFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const detail = (error ?? {}) as { authenticationFailed?: boolean; code?: string; serverResponseCode?: string; responseText?: string };
  const responseText = typeof detail.responseText === 'string' ? detail.responseText : '';
  if (detail.authenticationFailed || detail.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new AppError('Google 拒绝了登录：请确认已开启两步验证并使用应用专用密码', { statusCode: 400, code: 'MAIL_AUTH_FAILED' });
  }
  if (/too many simultaneous connections/i.test(responseText)) {
    return new AppError('Gmail 同时连接过多，请稍后再试', { statusCode: 429, code: 'MAIL_PROVIDER_BUSY' });
  }
  if (detail.code && TIMEOUT_CODES.has(detail.code)) {
    return new AppError('Gmail 服务器响应超时，请稍后重试', { statusCode: 504, code: 'MAIL_PROVIDER_TIMEOUT' });
  }
  if (detail.code && NETWORK_CODES.has(detail.code)) {
    return new AppError('无法连接 Gmail 服务器（imap.gmail.com:993），请检查这台电脑的网络', { statusCode: 502, code: 'MAIL_PROVIDER_UNREACHABLE' });
  }
  // Codes only: messages can quote server text, and nothing here should identify mailbox contents.
  console.warn('[studio] Gmail IMAP failure:', detail.code ?? 'unknown', detail.serverResponseCode ?? '');
  return new AppError('Gmail 读取失败，请稍后重试', { statusCode: 502, code: 'MAIL_PROVIDER_ERROR' });
}

async function logoutQuietly(session: ImapSession) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([session.logout(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('logout timeout')), LOGOUT_MS); })]);
  } catch { session.close(); } finally { clearTimeout(timer); }
}

/** Used by the Studio mail service to verify, list and read Gmail (and Google Workspace) over IMAP with an App Password. */
export function createGmailImapAdapter(deps: { connect?: ImapConnect; operationTimeoutMs?: number } = {}) {
  const connect = deps.connect ?? connectImapFlow;
  const operationMs = deps.operationTimeoutMs ?? OPERATION_MS;

  // One connection per operation, always bounded by the deadline and always logged out or closed afterwards.
  async function withSession<T>(credentials: Credentials, work: (session: ImapSession) => Promise<T>): Promise<T> {
    const session = connect({ ...GMAIL_IMAP, user: credentials.email, pass: credentials.password });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const run = (async () => { await session.connect(); return work(session); })();
    // A failure that lands after the deadline already answered must not become an unhandled rejection.
    run.catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        session.close();
        reject(Object.assign(new Error('IMAP operation timed out'), { code: 'ETIMEOUT' }));
      }, operationMs);
    });
    try {
      return await Promise.race([run, deadline]);
    } catch (error) {
      throw imapFailure(error);
    } finally {
      clearTimeout(timer);
      if (!timedOut) await logoutQuietly(session);
    }
  }

  return {
    // Logs in and examines INBOX; nothing is stored here, the caller saves the account only on success.
    async verify(credentials: Credentials) {
      await withSession(credentials, async session => { await session.openReadOnly('INBOX'); });
    },
    // Newest `limit` INBOX messages, or the newest `limit` Gmail search matches in All Mail.
    async list(credentials: Credentials, query: string, limit: number): Promise<StudioMailRawMessage[]> {
      return withSession(credentials, async session => {
        if (!query) {
          const inbox = await session.openReadOnly('INBOX');
          if (!inbox.exists) return [];
          const previews = await session.fetchPreviews(`${Math.max(1, inbox.exists - limit + 1)}:*`, false, PREVIEW_BYTES);
          return Promise.all(newestFirst(previews).slice(0, limit).map(message => toRawMessage('i', message, PREVIEW_BYTES)));
        }
        const allMail = await session.specialUseMailbox('\\All');
        await session.openReadOnly(allMail ?? 'INBOX');
        const uids = (await session.searchGmail(query)).sort((left, right) => left - right).slice(-limit);
        if (!uids.length) return [];
        const previews = await session.fetchPreviews(uids.join(','), true, PREVIEW_BYTES);
        return Promise.all(newestFirst(previews).map(message => toRawMessage(allMail ? 'a' : 'i', message, PREVIEW_BYTES)));
      });
    },
    // The full (size-capped) message for an id returned by `list`.
    async read(credentials: Credentials, id: string): Promise<StudioMailRawMessage> {
      const match = MESSAGE_ID.exec(id);
      if (!match) throw new AppError('邮件标识无效', { statusCode: 400, code: 'MAIL_INVALID_ID' });
      const mailbox = match[1] as 'i' | 'a';
      return withSession(credentials, async session => {
        const path = mailbox === 'a' ? await session.specialUseMailbox('\\All') : 'INBOX';
        if (!path) throw new AppError('找不到这封邮件所在的邮箱', { statusCode: 404, code: 'MAIL_NOT_FOUND' });
        await session.openReadOnly(path);
        const message = await session.fetchMessage(Number(match[2]), MESSAGE_BYTES);
        if (!message) throw new AppError('邮件不存在或已被移走', { statusCode: 404, code: 'MAIL_NOT_FOUND' });
        return toRawMessage(mailbox, message, MESSAGE_BYTES);
      });
    },
  };
}
