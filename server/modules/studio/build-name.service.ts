import { AppError } from '@/shared/utils.js';

import { MAX_NAME, MAX_REQUEST } from './builds.service.js';

/** What POST /api/studio/builds/suggest-name returns: a short name for the app being described, and who made it. */
export type StudioBuildNameSuggestion = { name: string; source: 'deepseek' | 'local' };

type Dependencies = {
  // The user's DeepSeek key (saved in Studio, else STUDIO_DEEPSEEK_ENV_FILE), or null. Never logged or returned.
  deepseekKey: (userId: number) => string | null;
  request?: typeof fetch;
  // The chat model asked for names (STUDIO_BUILD_NAME_MODEL, default deepseek-chat).
  model?: string;
  timeoutMs?: number;
  // DeepSeek calls one user may make per minute; further suggestions use the local rule until the minute is over.
  perMinute?: number;
  now?: () => number;
};

const API_URL = 'https://api.deepseek.com/chat/completions';
// A non-reasoning model: a reasoning one (deepseek-flash) spends the few tokens allowed on thinking and answers nothing.
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
// Shorter descriptions are not worth a model call.
const MIN_PROMPT = 4;
// The head of the description is enough to name an app, and keeps the call cheap.
const PROMPT_SENT = 2000;
const AI_NAME_MAX = Math.min(12, MAX_NAME);
const LOCAL_NAME_MAX = Math.min(8, MAX_NAME);
const FALLBACK = '新 App';
const SYSTEM_PROMPT = '根据用户对一个小应用的描述，起一个 2 到 8 个汉字的简短中文名字（可以含常见英文缩写）。只输出名字本身，不要引号、书名号和标点，不要解释。';

// Code points, so a name is never cut inside a surrogate pair.
const clip = (text: string, max: number) => Array.from(text).slice(0, max).join('').trim();

/**
 * A model reply reduced to a name: its first non-empty line without a "名字：" label, quotes, brackets, punctuation
 * or symbols, inner whitespace collapsed, at most 12 characters. Empty when nothing usable is left.
 */
export function cleanSuggestedName(raw: string) {
  const line = raw.split(/\r?\n/).map(entry => entry.trim()).find(Boolean) ?? '';
  const text = line.replace(/^(?:应用名称|应用名|名称|名字|App\s*名)\s*[:：]\s*/i, '')
    .replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clip(text, AI_NAME_MAX);
}

// Requests and fillers in front of what the app is: 请帮我做一个… / 我想要… / 一款… / a / an.
const LEADING = [
  /^(?:请|麻烦|拜托)你?/,
  /^(?:帮我|给我|替我|帮忙|我想要|我想|我要|我需要|我希望|想要|需要)(?:做|写|开发|生成|创建|设计|搞|弄|实现)?/,
  // A verb only when a measure word follows, so 做饭记录 keeps its 做.
  /^(?:做|写|开发|生成|创建|设计|搞|弄|实现)(?:一个|一款|一套|一份|一下|个|款)/,
  /^(?:一个|一款|一套|一份|一只)/,
  /^(?:an?|the)\s+/i,
];
// What kind of thing it is, at the end: …的网页 / 网站 / App / 应用 / 小程序 / 工具.
const TRAILING = /(?:的)?(?:网页版|网页|网站|页面|微信小程序|小程序|应用程序|应用|小工具|工具|软件|程序)$|\s*\b(?:web\s*app|app|website|site|tool)$/i;

function stripLoop(text: string, patterns: RegExp[]) {
  let current = text.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const pattern of patterns) {
      const next = current.replace(pattern, '').trim();
      if (next !== current) { current = next; changed = true; }
    }
  }
  return current;
}

/**
 * The name made without a model: the first clause of the description without its request words, the noun after its
 * last 的 when that is more than a generic kind (一个支持 Markdown 的记事本 → 记事本), trailing kinds removed
 * (喝水打卡网页 → 喝水打卡), at most 8 characters; 新 App when nothing is left.
 */
export function localBuildName(prompt: string) {
  const clause = stripLoop(prompt, LEADING).split(/[\p{P}\n]/u).map(part => part.trim()).find(Boolean) ?? '';
  const subject = stripLoop(clause, LEADING);
  const split = subject.lastIndexOf('的');
  const head = split >= 0 ? stripLoop(subject.slice(split + 1), [TRAILING]) : '';
  const body = stripLoop(split >= 0 ? subject.slice(0, split) : subject, [TRAILING]);
  const name = Array.from(head).length >= 2 ? head : body || head;
  return clip(name, LOCAL_NAME_MAX) || FALLBACK;
}

/**
 * Used by the builds router for POST /api/studio/builds/suggest-name: names an app from its description, through
 * DeepSeek with the user's key when there is one, otherwise (and on any failure, timeout or empty reply) through
 * the local rule. The description and the key are never logged.
 */
export function createBuildNameSuggester(deps: Dependencies) {
  const request = deps.request ?? fetch;
  const model = deps.model?.trim() || DEFAULT_MODEL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const perMinute = deps.perMinute ?? DEFAULT_PER_MINUTE;
  const now = deps.now ?? Date.now;
  // DeepSeek calls per user in the current one-minute window.
  const windows = new Map<number, { start: number; count: number }>();
  // HTTP statuses already reported, so a wrong model or a spent balance is said once rather than per keystroke.
  const reported = new Set<number>();

  function allow(userId: number) {
    const at = now();
    for (const [id, window] of windows) if (at - window.start >= WINDOW_MS) windows.delete(id);
    const window = windows.get(userId) ?? { start: at, count: 0 };
    if (window.count >= perMinute) return false;
    window.count += 1;
    windows.set(userId, window);
    return true;
  }

  function keyOf(userId: number) {
    try {
      return deps.deepseekKey(userId);
    } catch {
      // An unreadable vault only costs the AI suggestion.
      return null;
    }
  }

  async function askDeepseek(key: string, prompt: string, signal?: AbortSignal) {
    const response = await request(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 20, stream: false,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt.slice(0, PROMPT_SENT) }],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      if (!reported.has(response.status)) {
        reported.add(response.status);
        console.warn(`[studio-builds] DeepSeek name suggestions answered ${response.status}; using the local rule`);
      }
      return '';
    }
    const payload = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === 'string' ? cleanSuggestedName(content) : '';
  }

  return {
    async suggest(userId: number, prompt: string, signal?: AbortSignal): Promise<StudioBuildNameSuggestion> {
      const text = prompt.trim();
      if (text.length > MAX_REQUEST) throw new AppError(`描述最多 ${MAX_REQUEST} 个字符`, { statusCode: 400, code: 'STUDIO_BUILD_ERROR' });
      const local = (): StudioBuildNameSuggestion => ({ name: localBuildName(text), source: 'local' });
      if (Array.from(text).length < MIN_PROMPT) return local();
      const key = keyOf(userId);
      if (!key || !allow(userId)) return local();
      try {
        const name = await askDeepseek(key, text, signal);
        return name ? { name, source: 'deepseek' } : local();
      } catch {
        // Timeouts, aborts and transport errors alike: the local rule always has an answer.
        return local();
      }
    },
  };
}
