import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '@/shared/utils.js';

import { cleanSuggestedName, createBuildNameSuggester, localBuildName } from '../build-name.service.js';

// A stand-in value only; no real key is read anywhere in these tests.
const KEY = 'test-deepseek-key-0000';
const PROMPT = '一个记录每天喝水的网页，可以设定每日目标';

type Seen = { url: string; init: RequestInit };
// A fake fetch that records each call and answers with `reply` (a chat completion's content, a status or a thrower).
function fakeDeepseek(reply: string | number | (() => Promise<Response>)) {
  const seen: Seen[] = [];
  const request = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (typeof reply === 'function') return reply();
    if (typeof reply === 'number') return new Response('{}', { status: reply });
    return Response.json({ choices: [{ message: { role: 'assistant', content: reply } }] });
  }) as unknown as typeof fetch;
  return { seen, request };
}

test('the local rule keeps what the app is and drops request words, kinds and the rest of the sentence', () => {
  assert.equal(localBuildName('一个记录每天喝水的网页。可以设定每日目标、一键打卡'), '记录每天喝水');
  assert.equal(localBuildName('帮我做一个番茄钟，25 分钟一轮'), '番茄钟');
  assert.equal(localBuildName('我想要一款喝水打卡小程序'), '喝水打卡');
  assert.equal(localBuildName('写一个支持 Markdown 的记事本'), '记事本');
  assert.equal(localBuildName('能设目标的喝水打卡工具'), '喝水打卡');
  assert.equal(localBuildName('做饭记录，每天一条'), '做饭记录');
  assert.equal(localBuildName('a todo app'), 'todo');
  // At most eight characters, counted as characters rather than UTF-16 units.
  assert.equal(localBuildName('家庭成员共享的周末出游计划清单'), '周末出游计划清单');
  assert.equal(localBuildName('🍅🍅🍅🍅🍅🍅🍅🍅🍅🍅 计时'), '🍅🍅🍅🍅🍅🍅🍅🍅');
  assert.equal(localBuildName(''), '新 App');
  assert.equal(localBuildName('   。，！'), '新 App');
  assert.equal(localBuildName('做一个网页'), '新 App');
});

test('a model reply is reduced to the name: first line, no label, quotes, brackets or punctuation, at most 12 characters', () => {
  assert.equal(cleanSuggestedName('「喝水打卡」'), '喝水打卡');
  assert.equal(cleanSuggestedName('"番茄钟"\n这个名字简洁易记。'), '番茄钟');
  assert.equal(cleanSuggestedName('\n\n名字：《记账本》。'), '记账本');
  assert.equal(cleanSuggestedName('AI 记账'), 'AI 记账');
  assert.equal(cleanSuggestedName('一二三四五六七八九十甲乙丙丁'), '一二三四五六七八九十甲乙');
  assert.equal(cleanSuggestedName('“”。'), '');
});

test('with a key, DeepSeek names the app in one short, cheap call', async () => {
  const deepseek = fakeDeepseek('「喝水打卡」');
  const keysAskedFor: number[] = [];
  const names = createBuildNameSuggester({ deepseekKey: userId => { keysAskedFor.push(userId); return KEY; }, request: deepseek.request });
  assert.deepEqual(await names.suggest(7, `  ${PROMPT}  `), { name: '喝水打卡', source: 'deepseek' });
  assert.deepEqual(keysAskedFor, [7]);
  assert.equal(deepseek.seen.length, 1);
  const [{ url, init }] = deepseek.seen;
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${KEY}`);
  const body = JSON.parse(String(init.body)) as { model: string; temperature: number; max_tokens: number; stream: boolean; messages: { role: string; content: string }[] };
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 20);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /2 到 8 个汉字/);
  assert.deepEqual(body.messages[1], { role: 'user', content: PROMPT });

  const configured = fakeDeepseek('番茄钟');
  await createBuildNameSuggester({ deepseekKey: () => KEY, request: configured.request, model: 'deepseek-flash' }).suggest(1, PROMPT);
  assert.equal((JSON.parse(String(configured.seen[0].init.body)) as { model: string }).model, 'deepseek-flash');
});

test('without a key, or for a description shorter than four characters, the local rule answers and nothing is sent', async () => {
  const deepseek = fakeDeepseek('喝水打卡');
  assert.deepEqual(await createBuildNameSuggester({ deepseekKey: () => null, request: deepseek.request }).suggest(1, PROMPT), { name: '记录每天喝水', source: 'local' });
  const keyed = createBuildNameSuggester({ deepseekKey: () => KEY, request: deepseek.request });
  assert.deepEqual(await keyed.suggest(1, '番茄钟'), { name: '番茄钟', source: 'local' });
  assert.deepEqual(await keyed.suggest(1, '   '), { name: '新 App', source: 'local' });
  // An unreadable vault costs only the AI suggestion.
  const broken = createBuildNameSuggester({ deepseekKey: () => { throw new Error('本地密钥库不可用'); }, request: deepseek.request });
  assert.deepEqual(await broken.suggest(1, PROMPT), { name: '记录每天喝水', source: 'local' });
  assert.equal(deepseek.seen.length, 0);
});

test('a failed, unusable, slow or abandoned DeepSeek call falls back to the local rule, and says so once without the prompt or key', async (context) => {
  const warnings: string[] = [];
  context.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  const local = { name: '记录每天喝水', source: 'local' };
  const statusOnly = createBuildNameSuggester({ deepseekKey: () => KEY, request: fakeDeepseek(402).request });
  assert.deepEqual(await statusOnly.suggest(1, PROMPT), local);
  assert.deepEqual(await statusOnly.suggest(1, PROMPT), local);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /402/);
  assert.ok(!warnings[0].includes(KEY) && !warnings[0].includes('喝水'));

  for (const reply of ['', '「」。', () => Promise.reject(new TypeError('fetch failed')), () => Promise.resolve(new Response('not json'))]) {
    assert.deepEqual(await createBuildNameSuggester({ deepseekKey: () => KEY, request: fakeDeepseek(reply).request }).suggest(1, PROMPT), local);
  }

  // A reply that never comes is cut off by the timeout.
  const hanging = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as unknown as typeof fetch;
  const startedAt = Date.now();
  assert.deepEqual(await createBuildNameSuggester({ deepseekKey: () => KEY, request: hanging, timeoutMs: 30 }).suggest(1, PROMPT), local);
  assert.ok(Date.now() - startedAt < 2000);

  // So is one the browser stopped waiting for.
  const controller = new AbortController();
  const pending = createBuildNameSuggester({ deepseekKey: () => KEY, request: hanging }).suggest(1, PROMPT, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, local);
});

test('each user gets a limited number of DeepSeek suggestions a minute; the rest use the local rule', async () => {
  let now = Date.parse('2026-10-03T09:00:00.000Z');
  const deepseek = fakeDeepseek('喝水打卡');
  const names = createBuildNameSuggester({ deepseekKey: () => KEY, request: deepseek.request, perMinute: 2, now: () => now });
  // Short descriptions never count against the limit.
  assert.equal((await names.suggest(1, '番茄钟')).source, 'local');
  assert.equal((await names.suggest(1, PROMPT)).source, 'deepseek');
  assert.equal((await names.suggest(1, PROMPT)).source, 'deepseek');
  assert.deepEqual(await names.suggest(1, PROMPT), { name: '记录每天喝水', source: 'local' });
  // Other users have their own.
  assert.equal((await names.suggest(2, PROMPT)).source, 'deepseek');
  assert.equal(deepseek.seen.length, 3);
  now += 60_000;
  assert.equal((await names.suggest(1, PROMPT)).source, 'deepseek');
  assert.equal(deepseek.seen.length, 4);
});

test('a description over the build limit is refused like starting a build would be', async () => {
  const deepseek = fakeDeepseek('喝水打卡');
  const names = createBuildNameSuggester({ deepseekKey: () => KEY, request: deepseek.request });
  await assert.rejects(names.suggest(1, '喝'.repeat(8001)), (error: unknown) => error instanceof AppError && error.statusCode === 400 && /8000/.test(error.message));
  assert.equal((await names.suggest(1, `${'喝'.repeat(8000)}   `)).source, 'deepseek');
  // Only the head of a long description is sent.
  assert.equal((JSON.parse(String(deepseek.seen[0].init.body)) as { messages: { content: string }[] }).messages[1].content.length, 2000);
});
