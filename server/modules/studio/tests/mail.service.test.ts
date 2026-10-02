import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { createMailService } from '../mail/mail.service.js';

type Dependencies = Parameters<typeof createMailService>[0];
type Connect = NonNullable<Dependencies['imapConnect']>;
type Session = ReturnType<Connect>;
type Fetched = Awaited<ReturnType<Session['fetchPreviews']>>[number];
type Call = { url: string; method: string; body: string; headers: Record<string, string> };

const APP_PASSWORD = 'abcd efgh ijkl mnop';

function rfc822(subject: string, body: string, type = 'text/html') {
  return Buffer.from([
    'From: "Alice" <alice@example.test>', 'To: owner@example.test', `Subject: ${subject}`,
    'MIME-Version: 1.0', `Content-Type: ${type}; charset=utf-8`, '', body,
  ].join('\r\n'));
}
const HTML = '<html><head><style>.x{color:red}</style><title>t</title></head><body><p>会议改到 <b>周五</b> &amp; 请确认</p>'
  + '<script>alert("x")</script><div>第二段\u202Eevil\u200B</div><img src="https://tracker.example.test/p.gif"></body></html>';

// Fake Gmail: logins with `bad` in the address or a revoked password fail, `state.down` makes the server
// unreachable, everything else sees the INBOX messages (two by default; tests may add more).
function fakeImap() {
  const logins: { user: string; pass: string }[] = [];
  const calls: string[] = [];
  const revoked = new Set<string>();
  const state = { down: false };
  const inbox: Fetched[] = [
    { uid: 7, flags: new Set(['\\Seen']), internalDate: new Date('2026-10-01T08:00:00Z'), envelope: { subject: '旧邮件', from: [{ address: 'bob@example.test' }] }, source: rfc822('旧邮件', '纯文本', 'text/plain') },
    { uid: 9, flags: new Set(), internalDate: new Date('2026-10-01T09:00:00Z'), envelope: { subject: '会议', from: [{ name: 'Alice', address: 'alice@example.test' }] }, source: rfc822('会议', HTML) },
  ];
  const connect: Connect = login => ({
    async connect() {
      logins.push({ user: login.user, pass: login.pass });
      if (state.down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (login.user.includes('bad') || revoked.has(login.pass)) throw Object.assign(new Error('[AUTHENTICATIONFAILED]'), { authenticationFailed: true });
    },
    async openReadOnly(mailbox) { calls.push(`open:${mailbox}`); return { exists: inbox.length }; },
    async specialUseMailbox() { return '[Gmail]/All Mail'; },
    async searchGmail(query) { calls.push(`search:${query}`); return [9]; },
    async fetchPreviews(range, byUid) { return byUid ? inbox.filter(item => range.split(',').map(Number).includes(item.uid)) : inbox; },
    async fetchMessage(uid) { return inbox.find(item => item.uid === uid) ?? null; },
    async logout() {},
    close() {},
  } satisfies Session);
  return { connect, logins, calls, revoked, state, inbox };
}

// Fake Microsoft identity platform and Graph; `script` decides each token-endpoint answer in order.
function fakeMicrosoft(script: { token: (Record<string, unknown> & { status?: number })[]; graph401Once?: boolean }) {
  const calls: Call[] = [];
  let graph401 = script.graph401Once ?? false;
  const request = (async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? ''), headers });
    if (url.endsWith('/devicecode')) {
      return Response.json({ device_code: 'server-only-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://www.microsoft.com/link', expires_in: 900, interval: 5 });
    }
    if (url.endsWith('/token')) {
      const next = script.token.shift() ?? { status: 400, error: 'invalid_grant' };
      const { status = 200, ...body } = next;
      return Response.json(body, { status });
    }
    if (url.includes('/me?')) return Response.json({ displayName: '我', mail: null, userPrincipalName: 'Me@Outlook.test' });
    if (graph401) { graph401 = false; return Response.json({ error: { code: 'InvalidAuthenticationToken' } }, { status: 401 }); }
    if (url.includes('/me/mailFolders/inbox/messages') || url.includes('/me/messages?')) {
      return Response.json({ value: [
        { id: 'AAMkAG-1=', subject: 'Outlook 邮件', from: { emailAddress: { name: 'Carol', address: 'carol@example.test' } }, receivedDateTime: '2026-10-01T10:00:00Z', bodyPreview: '预览', isRead: false },
        { id: 'bad id with spaces', subject: 'dropped' },
      ] });
    }
    if (url.includes('/me/messages/')) {
      return Response.json({ id: 'AAMkAG-1=', subject: 'Outlook 邮件', from: { emailAddress: { name: 'Carol', address: 'carol@example.test' } }, toRecipients: [{ emailAddress: { name: '我', address: 'me@outlook.test' } }], receivedDateTime: '2026-10-01T10:00:00Z', isRead: true, body: { contentType: 'text', content: '正文\r\n\r\n\r\n\r\n结束' } });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { request, calls };
}

function fixture(overrides: Partial<Dependencies> = {}) {
  const database = new Database(':memory:');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'studio-mail-test-'));
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const imap = fakeImap();
  const service = createMailService({ database, vaultDirectory: directory, imapConnect: imap.connect, now: () => clock, ...overrides });
  return {
    database, directory, imap, service,
    advance(ms: number) { clock += ms; },
    close() { database.close(); rmSync(directory, { recursive: true }); },
  };
}

test('Gmail App Passwords are verified by a real login before saving, stored encrypted and never returned', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.addGmailImap(1, { email: 'owner@gmail.test', password: 'Correct-Horse-9' }), /16 位字母/);
    await assert.rejects(f.service.addGmailImap(1, { email: 'not-an-email', password: APP_PASSWORD }), /有效的 Gmail 地址/);
    assert.equal(f.imap.logins.length, 0);

    const account = await f.service.addGmailImap(1, { email: ' Owner@Gmail.test ', password: APP_PASSWORD });
    assert.deepEqual(f.imap.logins, [{ user: 'owner@gmail.test', pass: 'abcdefghijklmnop' }]);
    assert.equal(account.provider, 'gmail-imap');
    assert.equal(account.email, 'owner@gmail.test');
    assert.equal(account.status, 'ok');
    const stored = f.database.prepare('SELECT encrypted_secret FROM studio_mail_accounts').get() as { encrypted_secret: string };
    assert.ok(!stored.encrypted_secret.includes('abcdefghijklmnop'));
    assert.ok(readdirSync(f.directory).includes('mail.key'));
    const listing = f.service.accounts(1);
    assert.ok(!JSON.stringify(listing).includes('abcdefghijklmnop'));
    assert.equal(listing.outlookConfigured, false);
    assert.deepEqual(f.service.accounts(2).accounts, []);

    // Re-adding the same address replaces the credential instead of duplicating the account.
    const again = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: 'ponmlkjihgfedcba' });
    assert.equal(again.id, account.id);
    assert.equal(f.service.accounts(1).accounts.length, 1);
  } finally { f.close(); }
});

test('a rejected Google login stores nothing, explains App Passwords and is rate limited', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.addGmailImap(1, { email: 'bad@gmail.test', password: APP_PASSWORD }),
      /Google 拒绝了登录：请确认已开启两步验证并使用应用专用密码/);
    assert.deepEqual(f.service.accounts(1).accounts, []);
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(f.service.addGmailImap(1, { email: 'bad@gmail.test', password: APP_PASSWORD }), /拒绝/);
    await assert.rejects(f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD }), /尝试次数过多/);
    assert.equal(f.imap.logins.length, 6);
    f.advance(11 * 60_000);
    await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
  } finally { f.close(); }
});

test('the unified inbox reads INBOX read-only, cleans previews and isolates a failing account', async () => {
  const f = fixture();
  try {
    const good = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    const bad = await f.service.addGmailImap(1, { email: 'second@gmail.test', password: APP_PASSWORD });
    // The second account's password is later revoked: simulate by renaming it so the fake rejects it.
    f.database.prepare("UPDATE studio_mail_accounts SET email = 'bad@gmail.test' WHERE id = ?").run(bad.id);

    const inbox = await f.service.messages(1, {});
    assert.deepEqual(inbox.messages.map(item => [item.accountId, item.id, item.unread]), [[good.id, 'i9', true], [good.id, 'i7', false]]);
    const preview = inbox.messages[0].snippet;
    assert.equal(preview, '会议改到 周五 & 请确认 第二段evil');
    assert.ok(!/[<>]|color:red|alert|tracker/.test(preview));
    assert.deepEqual(inbox.errors, [{ accountId: bad.id, email: 'bad@gmail.test', message: 'Google 拒绝了登录：请确认已开启两步验证并使用应用专用密码' }]);
    const statuses = Object.fromEntries(f.service.accounts(1).accounts.map(account => [account.id, account.status]));
    assert.deepEqual(statuses, { [good.id]: 'ok', [bad.id]: 'reauth' });
    assert.ok(f.imap.calls.every(call => call.startsWith('open:') || call.startsWith('search:')));

    const searched = await f.service.messages(1, { accountId: good.id, query: 'is:unread\u0000', limit: 5 });
    assert.deepEqual(searched.messages.map(item => item.id), ['a9']);
    assert.ok(f.imap.calls.includes('search:is:unread'));
    await assert.rejects(f.service.messages(1, { query: 'x'.repeat(301) }), /过长/);
    await assert.rejects(f.service.messages(2, { accountId: good.id }), /不存在/);
  } finally { f.close(); }
});

test('opening a message returns capped, markup-free plain text', async () => {
  const f = fixture();
  try {
    const account = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    const detail = await f.service.message(1, account.id, 'i9');
    assert.equal(detail.subject, '会议');
    assert.equal(detail.from, 'Alice');
    assert.equal(detail.unread, true);
    assert.equal(detail.text, '会议改到 周五 & 请确认\n第二段evil');
    assert.equal(detail.truncated, false);
    await assert.rejects(f.service.message(1, account.id, 'i404'), /不存在/);
    await assert.rejects(f.service.message(1, account.id, 'DROP TABLE'), /标识无效/);
    // A missing message does not mark the account unhealthy.
    assert.equal(f.service.accounts(1).accounts[0].status, 'ok');
  } finally { f.close(); }
});

test('long HTML bodies keep the text after inline images and report when the source was cut', async () => {
  const f = fixture();
  try {
    const account = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    const image = `<img src="data:image/png;base64,${'A'.repeat(500_000)}">`;
    const styled = `<div style="${'color:red;'.repeat(200)}">段落</div>`.repeat(250);
    f.imap.inbox.push(
      { uid: 11, flags: new Set(), internalDate: new Date('2026-10-01T10:00:00Z'), envelope: { subject: '大图' }, source: rfc822('大图', `<html><body>${image}<p>图片后面的正文</p><p>data: 保留</p></body></html>`) },
      { uid: 12, flags: new Set(), internalDate: new Date('2026-10-01T11:00:00Z'), envelope: { subject: '长 HTML' }, source: rfc822('长 HTML', `<html><body>${styled}<p>结尾</p></body></html>`) },
    );
    // The inline image no longer eats the size cap; ordinary text that says "data:" is left alone.
    const withImage = await f.service.message(1, account.id, 'i11');
    assert.equal(withImage.text, '图片后面的正文\ndata: 保留');
    assert.equal(withImage.truncated, false);
    // Short text but a source beyond the cap: the reader must say it shows only the beginning.
    const long = await f.service.message(1, account.id, 'i12');
    assert.ok(long.text.startsWith('段落\n段落'));
    assert.ok(!long.text.includes('结尾'));
    assert.equal(long.truncated, true);
  } finally { f.close(); }
});

test('a rejected credential pauses the account: no more Google logins until the App Password is replaced', async () => {
  const f = fixture();
  try {
    const account = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    // Changing the Google password revokes every App Password.
    f.imap.revoked.add('abcdefghijklmnop');
    const first = await f.service.messages(1, {});
    assert.match(first.errors[0].message, /Google 拒绝了登录/);
    assert.equal(f.service.accounts(1).accounts[0].status, 'reauth');
    assert.equal(f.imap.logins.length, 2);

    // Reloading the inbox, filtering to the account, searching and opening a message all stay off the network.
    for (const input of [{}, { accountId: account.id }, { accountId: account.id, query: 'from:alice' }]) {
      const inbox = await f.service.messages(1, input);
      assert.deepEqual(inbox.messages, []);
      assert.match(inbox.errors[0].message, /应用专用密码已失效，Studio 已暂停读取这个账户/);
    }
    await assert.rejects(f.service.message(1, account.id, 'i9'), /已暂停读取这个账户/);
    f.advance(60 * 60_000);
    await f.service.messages(1, {});
    assert.equal(f.imap.logins.length, 2);

    // A new App Password for the same address replaces the credential and reading resumes at once.
    const replaced = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: 'ponm lkji hgfe dcba' });
    assert.equal(replaced.id, account.id);
    assert.equal(replaced.status, 'ok');
    const resumed = await f.service.messages(1, {});
    assert.deepEqual(resumed.errors, []);
    assert.equal(resumed.messages.length, 2);
    assert.deepEqual(f.imap.logins.slice(2).map(login => login.pass), ['ponmlkjihgfedcba', 'ponmlkjihgfedcba']);
  } finally { f.close(); }
});

test('repeated provider failures cool an account down; a success or new credentials end the streak', async () => {
  const f = fixture();
  try {
    const account = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    f.imap.state.down = true;
    const unreachable = /^无法连接 Gmail 服务器/;
    assert.match((await f.service.messages(1, {})).errors[0].message, unreachable);
    assert.match((await f.service.messages(1, { accountId: account.id })).errors[0].message, unreachable);
    assert.equal(f.imap.logins.length, 3);
    // The second consecutive failure starts a one-minute cooldown: no connection, an explanation instead.
    const cooling = await f.service.messages(1, {});
    assert.match(cooling.errors[0].message, /^无法连接 Gmail 服务器.*。连续失败，已暂停读取，约 1 分钟后自动重试$/);
    await assert.rejects(f.service.message(1, account.id, 'i9'), /已暂停读取/);
    assert.equal(f.imap.logins.length, 3);
    assert.equal(f.service.accounts(1).accounts[0].status, 'error');

    // Still down after the cooldown: one attempt, then a doubled (two-minute) cooldown.
    f.advance(61_000);
    assert.match((await f.service.messages(1, {})).errors[0].message, unreachable);
    assert.equal(f.imap.logins.length, 4);
    f.advance(90_000);
    assert.match((await f.service.messages(1, {})).errors[0].message, /约 1 分钟后自动重试$/);
    assert.equal(f.imap.logins.length, 4);

    // Back online: the first attempt after the cooldown succeeds and clears the streak and the status.
    f.imap.state.down = false;
    f.advance(31_000);
    assert.deepEqual((await f.service.messages(1, {})).errors, []);
    assert.equal(f.imap.logins.length, 5);
    assert.equal(f.service.accounts(1).accounts[0].status, 'ok');
    f.imap.state.down = true;
    await f.service.messages(1, {});
    await f.service.messages(1, {});
    assert.equal(f.imap.logins.length, 7);

    // Replacing the credentials ends a cooldown immediately.
    f.imap.state.down = false;
    await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    assert.deepEqual((await f.service.messages(1, {})).errors, []);
    assert.equal(f.imap.logins.length, 9);
  } finally { f.close(); }
});

test('identical listings running at the same time share one Gmail session', async () => {
  const f = fixture();
  try {
    const account = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    const [first, second] = await Promise.all([f.service.messages(1, { accountId: account.id }), f.service.messages(1, { accountId: account.id })]);
    assert.deepEqual(first, second);
    assert.equal(f.imap.logins.length, 2);
    await f.service.messages(1, { accountId: account.id });
    assert.equal(f.imap.logins.length, 3);
  } finally { f.close(); }
});

test('removing an account deletes only that user\'s row', async () => {
  const f = fixture();
  try {
    const account = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    assert.throws(() => f.service.removeAccount(2, account.id), /不存在/);
    assert.deepEqual(f.service.removeAccount(1, account.id), { removed: true });
    assert.deepEqual(f.service.accounts(1).accounts, []);
    assert.throws(() => f.service.removeAccount(1, '../etc'), /标识无效/);
  } finally { f.close(); }
});

test('Outlook is unavailable without a client id and makes no network calls', async () => {
  const microsoft = fakeMicrosoft({ token: [] });
  const f = fixture({ request: microsoft.request });
  try {
    await assert.rejects(f.service.startOutlookDevice(1), /STUDIO_OUTLOOK_CLIENT_ID/);
    assert.equal(microsoft.calls.length, 0);
  } finally { f.close(); }
});

test('Outlook device-code sign-in keeps the device code server-side and respects the poll interval', async () => {
  const microsoft = fakeMicrosoft({ token: [
    { status: 400, error: 'authorization_pending', error_description: 'AADSTS70016 secret-ish detail' },
    { status: 400, error: 'slow_down' },
    { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
  ] });
  const f = fixture({ request: microsoft.request, outlookClientId: 'public-client-id' });
  try {
    assert.equal(f.service.accounts(1).outlookConfigured, true);
    const device = await f.service.startOutlookDevice(1);
    assert.equal(device.userCode, 'ABCD-EFGH');
    assert.equal(device.verificationUri, 'https://www.microsoft.com/link');
    assert.equal(device.interval, 5);
    assert.ok(!JSON.stringify(device).includes('server-only-device-code'));
    const start = new URLSearchParams(microsoft.calls[0].body);
    assert.equal(microsoft.calls[0].url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode');
    assert.equal(start.get('client_id'), 'public-client-id');
    assert.equal(start.get('scope'), 'offline_access Mail.Read User.Read');
    assert.equal(start.get('client_secret'), null);

    // Too early: answered locally, Microsoft is not asked.
    assert.deepEqual(await f.service.pollOutlookDevice(1, device.pollId), { status: 'pending' });
    assert.equal(microsoft.calls.length, 1);
    await assert.rejects(f.service.pollOutlookDevice(2, device.pollId), /不存在/);

    f.advance(5000);
    assert.deepEqual(await f.service.pollOutlookDevice(1, device.pollId), { status: 'pending' });
    const poll = new URLSearchParams(microsoft.calls[1].body);
    assert.equal(poll.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(poll.get('device_code'), 'server-only-device-code');
    f.advance(5000);
    assert.deepEqual(await f.service.pollOutlookDevice(1, device.pollId), { status: 'pending' });
    // slow_down adds five seconds to the interval.
    f.advance(5000);
    assert.deepEqual(await f.service.pollOutlookDevice(1, device.pollId), { status: 'pending' });
    assert.equal(microsoft.calls.length, 3);
    f.advance(5000);
    const connected = await f.service.pollOutlookDevice(1, device.pollId);
    assert.equal(connected.status, 'connected');
    assert.equal(connected.account?.provider, 'outlook');
    assert.equal(connected.account?.email, 'me@outlook.test');
    assert.equal(connected.account?.displayName, '我');
    const stored = f.database.prepare("SELECT encrypted_secret FROM studio_mail_accounts WHERE provider = 'outlook'").get() as { encrypted_secret: string };
    assert.ok(!/access-1|refresh-1/.test(stored.encrypted_secret));
    await assert.rejects(f.service.pollOutlookDevice(1, device.pollId), /不存在/);
  } finally { f.close(); }
});

test('an Outlook device code that expires or is declined ends the flow', async () => {
  const microsoft = fakeMicrosoft({ token: [{ status: 400, error: 'authorization_declined' }] });
  const f = fixture({ request: microsoft.request, outlookClientId: 'public-client-id' });
  try {
    const declined = await f.service.startOutlookDevice(1);
    f.advance(5000);
    assert.deepEqual(await f.service.pollOutlookDevice(1, declined.pollId), { status: 'error', message: '你在 Microsoft 页面拒绝了授权' });
    const expired = await f.service.startOutlookDevice(1);
    f.advance(901_000);
    assert.deepEqual(await f.service.pollOutlookDevice(1, expired.pollId), { status: 'expired' });
  } finally { f.close(); }
});

test('Outlook reads use Graph read-only GETs, refresh tokens on demand and flag revoked sign-ins', async () => {
  const microsoft = fakeMicrosoft({ token: [
    { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
    { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 },
    { access_token: 'access-3', expires_in: 3600 },
    { status: 400, error: 'invalid_grant' },
  ], graph401Once: false });
  const f = fixture({ request: microsoft.request, outlookClientId: 'public-client-id' });
  try {
    const device = await f.service.startOutlookDevice(1);
    f.advance(5000);
    const { account } = await f.service.pollOutlookDevice(1, device.pollId);
    assert.ok(account);

    const inbox = await f.service.messages(1, { accountId: account.id });
    assert.deepEqual(inbox.messages.map(item => [item.id, item.from, item.snippet, item.unread]), [['AAMkAG-1=', 'Carol', '预览', true]]);
    const list = microsoft.calls.at(-1)!;
    assert.equal(list.method, 'GET');
    assert.equal(list.headers.Authorization, 'Bearer access-1');
    assert.ok(list.url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=30&$orderby=receivedDateTime%20desc&$select='));

    // Inner quotes are escaped for KQL (phrase search keeps working); backslashes become spaces.
    await f.service.messages(1, { accountId: account.id, query: 'from:"carol" \\ 发票', limit: 10 });
    assert.ok(microsoft.calls.at(-1)!.url.startsWith(`https://graph.microsoft.com/v1.0/me/messages?$search=${encodeURIComponent('"from:\\"carol\\"   发票"')}&$top=10`));

    const detail = await f.service.message(1, account.id, 'AAMkAG-1=');
    const read = microsoft.calls.at(-1)!;
    assert.ok(read.url.startsWith('https://graph.microsoft.com/v1.0/me/messages/AAMkAG-1%3D?$select='));
    assert.equal(read.headers.Prefer, 'outlook.body-content-type="text"');
    assert.equal(detail.text, '正文\n\n结束');
    assert.equal(detail.to, '我 <me@outlook.test>');
    assert.ok(microsoft.calls.every(call => call.url.includes('login.microsoftonline.com') || call.method === 'GET'));

    // Expired access token: refreshed before the call, and the rotated refresh token is kept.
    f.advance(3600_000);
    await f.service.messages(1, { accountId: account.id });
    const refresh = new URLSearchParams(microsoft.calls.find(call => call.body.includes('grant_type=refresh_token'))!.body);
    assert.equal(refresh.get('refresh_token'), 'refresh-1');
    assert.equal(microsoft.calls.at(-1)!.headers.Authorization, 'Bearer access-2');
    f.advance(3600_000);
    await f.service.messages(1, { accountId: account.id });
    assert.equal(microsoft.calls.at(-1)!.headers.Authorization, 'Bearer access-3');
    const refreshes = microsoft.calls.filter(call => call.body.includes('grant_type=refresh_token')).map(call => new URLSearchParams(call.body).get('refresh_token'));
    assert.deepEqual(refreshes, ['refresh-1', 'refresh-2']);

    // A revoked sign-in marks the account for re-authentication.
    f.advance(3600_000);
    const failed = await f.service.messages(1, {});
    assert.deepEqual(failed.errors.map(error => error.message), ['Outlook 登录已过期，请在设置里重新连接']);
    assert.equal(f.service.accounts(1).accounts[0].status, 'reauth');
    // Paused from now on: Microsoft is not asked again until the account is reconnected.
    const callsBefore = microsoft.calls.length;
    assert.match((await f.service.messages(1, {})).errors[0].message, /Outlook 授权已失效，Studio 已暂停读取这个账户/);
    await assert.rejects(f.service.message(1, account.id, 'AAMkAG-1='), /已暂停读取/);
    assert.equal(microsoft.calls.length, callsBefore);
  } finally { f.close(); }
});

test('a Gmail-only search skips Outlook accounts with a notice instead of a failing Graph call', async () => {
  const microsoft = fakeMicrosoft({ token: [{ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }] });
  const f = fixture({ request: microsoft.request, outlookClientId: 'public-client-id' });
  try {
    const gmail = await f.service.addGmailImap(1, { email: 'owner@gmail.test', password: APP_PASSWORD });
    const device = await f.service.startOutlookDevice(1);
    f.advance(5000);
    const outlook = (await f.service.pollOutlookDevice(1, device.pollId)).account!;
    const callsBefore = microsoft.calls.length;
    const inbox = await f.service.messages(1, { query: 'is:unread from:alice' });
    assert.deepEqual(inbox.messages.map(item => item.accountId), [gmail.id]);
    assert.deepEqual(inbox.errors, [{ accountId: outlook.id, email: 'me@outlook.test', message: '这个搜索用了 Gmail 专用语法（如 is:、label:、after:），Outlook 不支持，已跳过这个账户', skipped: true }]);
    assert.equal(microsoft.calls.length, callsBefore);
    assert.equal(f.service.accounts(1).accounts.find(item => item.id === outlook.id)?.status, 'ok');
    // Operators both providers understand, and quoted text that merely looks like an operator, still reach Outlook.
    for (const query of ['from:alice 发票', 'subject:"is:unread"']) {
      assert.deepEqual((await f.service.messages(1, { accountId: outlook.id, query })).errors, []);
    }
    assert.equal(microsoft.calls.length, callsBefore + 2);
  } finally { f.close(); }
});

test('a Graph 401 triggers one refresh and retry', async () => {
  const microsoft = fakeMicrosoft({ token: [
    { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 },
    { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 },
  ], graph401Once: true });
  const f = fixture({ request: microsoft.request, outlookClientId: 'public-client-id' });
  try {
    const device = await f.service.startOutlookDevice(1);
    f.advance(5000);
    const { account } = await f.service.pollOutlookDevice(1, device.pollId);
    const inbox = await f.service.messages(1, { accountId: account!.id });
    assert.equal(inbox.messages.length, 1);
    assert.deepEqual(inbox.errors, []);
    assert.equal(microsoft.calls.at(-1)!.headers.Authorization, 'Bearer access-2');
  } finally { f.close(); }
});

test('legacy project Gmail OAuth connections join the inbox as removable accounts', async () => {
  const forgotten: string[] = [];
  const f = fixture({
    legacyGmail: {
      accounts: userId => userId === 1 ? [{ projectId: 'project-one', projectName: '超级教授', email: 'oauth@gmail.test' }] : [],
      search: async () => [{ id: 'g1', subject: '旧授权', from: '"Dan" <dan@example.test>', date: 'Thu, 01 Oct 2026 07:00:00 +0000', snippet: '片段' }],
      message: async () => ({ id: 'g1', text: '<b>不渲染</b> 正文' }),
      forget: (_userId, projectId) => { forgotten.push(projectId); },
    },
  });
  try {
    const [legacy] = f.service.accounts(1).accounts;
    assert.deepEqual(legacy, { id: 'gmail-oauth-project-one', provider: 'gmail-oauth', email: 'oauth@gmail.test', displayName: '项目「超级教授」', status: 'ok', lastError: null, createdAt: '' });
    const inbox = await f.service.messages(1, {});
    assert.deepEqual(inbox.messages.map(item => [item.id, item.from, item.fromAddress, item.date]), [['g1', 'Dan', 'dan@example.test', '2026-10-01T07:00:00.000Z']]);
    assert.equal((await f.service.message(1, legacy.id, 'g1')).text, '<b>不渲染</b> 正文');
    await assert.rejects(f.service.messages(2, { accountId: legacy.id }), /不存在/);
    f.service.removeAccount(1, legacy.id);
    assert.deepEqual(forgotten, ['project-one']);
  } finally { f.close(); }
});
