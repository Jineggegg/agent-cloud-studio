import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImapFlow } from 'imapflow';

import { connectImapFlow, createGmailImapAdapter } from '../mail/gmail-imap.adapter.js';

type Connect = NonNullable<NonNullable<Parameters<typeof createGmailImapAdapter>[0]>['connect']>;
type Session = ReturnType<Connect>;
type Fetched = Awaited<ReturnType<Session['fetchPreviews']>>[number];

const CREDENTIALS = { email: 'owner@example.test', password: 'abcdefghijklmnop' };

function source(subject: string, body: string, type = 'text/plain') {
  return Buffer.from([
    'From: "Alice" <alice@example.test>', 'To: owner@example.test', `Subject: ${subject}`,
    'MIME-Version: 1.0', `Content-Type: ${type}; charset=utf-8`, '', body,
  ].join('\r\n'));
}
function message(uid: number, minutesAgo: number, seen: boolean, body = source('事项', '你好')): Fetched {
  return {
    uid, flags: new Set(seen ? ['\\Seen'] : []), internalDate: new Date(Date.UTC(2026, 9, 1, 12, 0) - minutesAgo * 60_000),
    envelope: { subject: `主题 ${uid}`, from: [{ name: 'Alice', address: 'alice@example.test' }], to: [{ address: 'owner@example.test' }] },
    source: body,
  };
}

function fakeConnect(options: { connectError?: object; hang?: boolean; inbox?: Fetched[]; allMail?: string | null } = {}) {
  const calls: string[] = [];
  const logins: { host: string; port: number; user: string; pass: string }[] = [];
  const inbox = options.inbox ?? [message(41, 30, true), message(42, 5, false)];
  const connect: Connect = login => {
    logins.push(login);
    return {
      async connect() {
        calls.push('connect');
        if (options.hang) await new Promise(() => {});
        if (options.connectError) throw options.connectError;
      },
      async openReadOnly(path) { calls.push(`open:${path}`); return { exists: inbox.length }; },
      async specialUseMailbox(flag) { calls.push(`special:${flag}`); return options.allMail === undefined ? '[Gmail]/All Mail' : options.allMail; },
      async searchGmail(query) { calls.push(`search:${query}`); return [42, 7, 41]; },
      async fetchPreviews(range, byUid, bytes) { calls.push(`previews:${range}:${byUid}:${bytes}`); return inbox; },
      async fetchMessage(uid, maxBytes) {
        calls.push(`message:${uid}:${maxBytes}`);
        return uid === 42 ? message(42, 5, false, source('长邮件', '<p>正文</p>', 'text/html')) : null;
      },
      async logout() { calls.push('logout'); },
      close() { calls.push('close'); },
    } satisfies Session;
  };
  return { connect, calls, logins };
}

test('IMAP lists the newest INBOX messages read-only, newest first, with previews and unread flags', async () => {
  const fake = fakeConnect();
  const adapter = createGmailImapAdapter({ connect: fake.connect });
  const messages = await adapter.list(CREDENTIALS, '', 30);
  assert.deepEqual(fake.logins, [{ host: 'imap.gmail.com', port: 993, user: 'owner@example.test', pass: 'abcdefghijklmnop' }]);
  assert.deepEqual(fake.calls, ['connect', 'open:INBOX', 'previews:1:*:false:24576', 'logout']);
  assert.deepEqual(messages.map(item => [item.id, item.unread]), [['i42', true], ['i41', false]]);
  assert.equal(messages[0].from, 'Alice');
  assert.equal(messages[0].fromAddress, 'alice@example.test');
  assert.equal(messages[0].subject, '主题 42');
  assert.deepEqual(messages[0].body, { kind: 'text', content: '你好' });
  assert.match(messages[0].date, /^2026-10-01T11:55:00/);
});

test('IMAP searches Gmail syntax through X-GM-RAW in All Mail and keeps only the newest matches', async () => {
  const fake = fakeConnect();
  const adapter = createGmailImapAdapter({ connect: fake.connect });
  const messages = await adapter.list(CREDENTIALS, 'from:alice is:unread', 2);
  assert.deepEqual(fake.calls, ['connect', 'special:\\All', 'open:[Gmail]/All Mail', 'search:from:alice is:unread', 'previews:41,42:true:24576', 'logout']);
  assert.ok(messages.every(item => item.id.startsWith('a')));
});

test('IMAP reads one message with BODY.PEEK limits from the right mailbox and rejects foreign ids', async () => {
  const fake = fakeConnect();
  const adapter = createGmailImapAdapter({ connect: fake.connect });
  const detail = await adapter.read(CREDENTIALS, 'i42');
  assert.deepEqual(fake.calls, ['connect', 'open:INBOX', `message:42:${4 * 1024 * 1024}`, 'logout']);
  assert.equal(detail.body.kind, 'html');
  assert.match(detail.body.content, /<p>正文<\/p>/);
  await assert.rejects(adapter.read(CREDENTIALS, 'i7'), /不存在/);
  for (const id of ['42', 'x42', 'i0', 'i-1', 'i42;', '../i42']) await assert.rejects(adapter.read(CREDENTIALS, id), /标识无效/);
});

test('IMAP failures map to clear Chinese messages and never echo the server text', async () => {
  const auth = createGmailImapAdapter({ connect: fakeConnect({ connectError: Object.assign(new Error('[AUTHENTICATIONFAILED] Invalid credentials (Failure) secret-detail'), { authenticationFailed: true }) }).connect });
  await assert.rejects(auth.verify(CREDENTIALS), (error: Error & { code?: string }) =>
    error.message === 'Google 拒绝了登录：请确认已开启两步验证并使用应用专用密码' && error.code === 'MAIL_AUTH_FAILED');
  const offline = createGmailImapAdapter({ connect: fakeConnect({ connectError: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) }).connect });
  await assert.rejects(offline.verify(CREDENTIALS), /无法连接 Gmail 服务器/);
  const busy = createGmailImapAdapter({ connect: fakeConnect({ connectError: Object.assign(new Error('x'), { responseText: '[ALERT] Too many simultaneous connections.' }) }).connect });
  await assert.rejects(busy.verify(CREDENTIALS), /同时连接过多/);
  const odd = createGmailImapAdapter({ connect: fakeConnect({ connectError: Object.assign(new Error('private server text'), { code: 'Weird' }) }).connect });
  await assert.rejects(odd.verify(CREDENTIALS), (error: Error) => error.message === 'Gmail 读取失败，请稍后重试');
});

test('IMAP operations are bounded by a deadline that closes the socket', async () => {
  const fake = fakeConnect({ hang: true });
  const adapter = createGmailImapAdapter({ connect: fake.connect, operationTimeoutMs: 30 });
  await assert.rejects(adapter.list(CREDENTIALS, '', 30), /超时/);
  assert.deepEqual(fake.calls, ['connect', 'close']);
});

test('the imapflow transport opens mailboxes read-only, fetches partial sources and never logs', async () => {
  const seen: { options?: Record<string, unknown>; calls: unknown[][] } = { calls: [] };
  class FakeImapFlow {
    constructor(options: Record<string, unknown>) { seen.options = options; }
    on() { return this; }
    async connect() {}
    async mailboxOpen(...args: unknown[]) { seen.calls.push(['mailboxOpen', ...args]); return { exists: 3 }; }
    async list() { return [{ path: 'INBOX' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }]; }
    async search(...args: unknown[]) { seen.calls.push(['search', ...args]); return false; }
    async fetchAll(...args: unknown[]) { seen.calls.push(['fetchAll', ...args]); return []; }
    async fetchOne(...args: unknown[]) { seen.calls.push(['fetchOne', ...args]); return false; }
    async logout() {}
    close() {}
  }
  const session = connectImapFlow({ host: 'imap.gmail.com', port: 993, user: 'u@example.test', pass: 'p' }, FakeImapFlow as unknown as typeof ImapFlow);
  assert.equal(seen.options?.secure, true);
  assert.equal(seen.options?.logger, false);
  assert.equal(seen.options?.disableAutoIdle, true);
  assert.ok(Number(seen.options?.socketTimeout) > 0 && Number(seen.options?.connectionTimeout) > 0);
  assert.deepEqual(await session.openReadOnly('INBOX'), { exists: 3 });
  assert.equal(await session.specialUseMailbox('\\All'), '[Gmail]/All Mail');
  assert.deepEqual(await session.searchGmail('in:inbox'), []);
  await session.fetchPreviews('1:*', false, 100);
  assert.equal(await session.fetchMessage(9, 200), null);
  assert.deepEqual(seen.calls[0], ['mailboxOpen', 'INBOX', { readOnly: true }]);
  assert.deepEqual(seen.calls[1], ['search', { gmraw: 'in:inbox' }, { uid: true }]);
  assert.deepEqual(seen.calls[2][2], { uid: true, flags: true, envelope: true, internalDate: true, source: { maxLength: 100 } });
  assert.deepEqual(seen.calls[3].slice(1), ['9', { uid: true, flags: true, envelope: true, internalDate: true, source: { maxLength: 200 } }, { uid: true }]);
});
