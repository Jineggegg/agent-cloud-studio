import type {
  StudioAutomationAction, StudioAutomationInput, StudioAutomationNotifyWhen, StudioAutomationPlan, StudioAutomationRepeat, StudioAutomationTrigger,
} from '@/shared/types.js';
import { AppError, zonedDateParts, zonedTimeToInstant } from '@/shared/utils.js';

// What the planner knows about the project and the owner when it reads a request.
type PlannerContext = {
  projectName: string;
  // “早上” without a time (the project's 设置 tab), "HH:MM".
  morningTime: string;
  // The project's default mailbox ('' = none).
  defaultMailAccountId: string;
  accounts: { id: string; provider: string; email: string }[];
  // Whether DeepSeek can judge and summarise mail for this owner.
  aiAvailable: boolean;
  timeZone: string;
  now: number;
};
// DeepSeek as a fallback reader of requests the rules do not understand; returns its parsed JSON or null.
type Interpret = (text: string, hint: string) => Promise<unknown>;

const MAX_TEXT = 500;
const MAX_TITLE = 40;
const MAX_MESSAGE = 120;
const MAX_QUERY = 60;
const DAY_MS = 86_400_000;

// Requests that would act outside Studio. Automations only read and notify the owner.
const OUTSIDE_STUDIO = [
  /(?:发|寄|回复|回|转发|群发|写)(?:一|几|这|那)?封?(?:邮件|信|e-?mail|mail)/i,
  /(?:邮件|e-?mail|mail)[^，。,；;]{0,8}?(?:发|寄|转)给(?!我)/i,
  /转发|抄送|回信/,
  /(?:给|向)(?!我)[^，。,；;\s]{1,20}?(?:发|寄|回)(?:邮件|消息|短信|信|微信)/,
  /下单|买入|卖出|买进|抛售|转账|付款|(?:执行|进行|自动)交易/,
  /(?:标记|标为|设为)\s*为?\s*(?:已读|未读|星标|垃圾)/,
  /(?:删除|删掉|归档|移走|清理)[^，。,；;]{0,6}?(?:邮件|信)|(?:邮件|信)[^，。,；;]{0,6}?(?:删除|删掉|归档|移走|清理)/,
  /(?:发|推送|同步|转)到(?:微信|钉钉|飞书|slack|telegram|推特|twitter|群)/i,
];
const BUILD_FAILED = /(?:构建|编译|打包|开发|部署|build)[^，。,；;]{0,4}?(?:失败|出错|报错|挂了|没成功|不成功|fail)/i;
const MAIL = /邮件|邮箱|收件箱|信箱|e-?mail|gmail|outlook|hotmail/i;
const NOTIFY = /通知|提醒|告诉|提示|叫我|推送|发给我|告知/;
const IMPORTANT = /重要|紧急|要紧|关键|需要(?:我)?(?:处理|回复)/;
const NEW_MAIL = /有新(?:的)?(?:邮件|信)?|新邮件|一有|只要有|收到(?:新)?(?:邮件|信)/;
const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEKDAYS: Record<string, number> = { 日: 0, 天: 0, 七: 0, 7: 0, 一: 1, 1: 1, 二: 2, 2: 2, 三: 3, 3: 3, 四: 4, 4: 4, 五: 5, 5: 5, 六: 6, 6: 6 };
const NUMBER = '[零〇一二两三四五六七八九十\\d]{1,3}';
const PERIODS = /(凌晨|清晨|早上|早晨|一早|明早|每早|上午|中午|下午|傍晚|晚上|今晚|明晚|每晚|夜里|半夜|深夜)/;
// A period said without a time: “早上” uses the project's morning time.
const PERIOD_DEFAULTS: Record<string, string> = {
  凌晨: '05:00', 上午: '10:00', 中午: '12:00', 下午: '15:00', 傍晚: '18:00', 晚上: '21:00', 今晚: '21:00', 明晚: '21:00', 每晚: '21:00',
  夜里: '22:00', 半夜: '00:00', 深夜: '23:00',
};
const EVENING = new Set(['下午', '傍晚', '晚上', '今晚', '明晚', '每晚', '夜里']);
const NIGHT = new Set(['晚上', '今晚', '明晚', '每晚', '夜里', '凌晨', '半夜']);
const DAY_OFFSETS: Record<string, number> = { 今天: 0, 今晚: 0, 明天: 1, 明早: 1, 明晚: 1, 后天: 2 };
const EXAMPLES = '可以试试：“每天早上读一下我邮箱里超级教授相关的邮件，有重要的就通知我”“构建失败时给我发通知”“每周一上午 9 点提醒我写周报”。';

function fail(message: string, statusCode = 422, code = 'AUTOMATION_PLAN_FAILED'): never {
  throw new AppError(message, { statusCode, code });
}

// Full-width digits and colons as ASCII, one space between words.
function normalise(text: string) {
  return text.replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0)).replace(/：/g, ':').replace(/\s+/g, ' ').trim();
}

// 0–99 in Arabic or Chinese numerals (八, 十二, 二十三, 零五); null otherwise.
function readNumber(value: string): number | null {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (/^零[一二三四五六七八九]$/.test(value)) return DIGITS[value[1]];
  if (!value.includes('十')) return value.length === 1 && value in DIGITS ? DIGITS[value] : null;
  const [tens, ones] = value.split('十');
  if (tens.length > 1 || ones.length > 1) return null;
  const ten = tens ? DIGITS[tens] : 1;
  const one = ones ? DIGITS[ones] : 0;
  return ten === undefined || one === undefined ? null : ten * 10 + one;
}

const pad = (value: number) => String(value).padStart(2, '0');

// The clock time a request names ("8 点半", "20:30", "晚上九点一刻"), or the period's default; null when it names none.
function readTime(text: string, morningTime: string): string | null {
  const period = PERIODS.exec(text)?.[1] ?? null;
  let hour: number | null = null;
  let minute = 0;
  const clock = /(\d{1,2}):(\d{2})/.exec(text);
  const spoken = new RegExp(`(${NUMBER})\\s*[点时](?:\\s*(半|一刻|三刻|整|${NUMBER})\\s*分?)?`).exec(text);
  if (clock) {
    hour = Number(clock[1]);
    minute = Number(clock[2]);
  } else if (spoken) {
    hour = readNumber(spoken[1]);
    const part = spoken[2];
    minute = !part || part === '整' ? 0 : part === '半' ? 30 : part === '一刻' ? 15 : part === '三刻' ? 45 : readNumber(part) ?? 0;
  }
  if (hour === null) {
    if (!period) return null;
    return ['清晨', '早上', '早晨', '一早', '明早', '每早'].includes(period) ? morningTime : PERIOD_DEFAULTS[period];
  }
  // “晚上 12 点” is midnight; “下午 3 点” is 15:00; “中午 1 点” is 13:00.
  if (period && NIGHT.has(period) && hour === 12) hour = 0;
  else if (period && EVENING.has(period) && hour < 12) hour += 12;
  else if (period === '中午' && hour >= 1 && hour <= 4) hour += 12;
  if (hour > 23 || minute > 59) fail('时间看不懂，请用像“8 点半”或“20:30”这样的写法');
  return `${pad(hour)}:${pad(minute)}`;
}

function localDate(instant: number, timeZone: string, dayOffset: number) {
  const today = zonedDateParts(instant, timeZone);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function instantOf(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return zonedTimeToInstant({ year, month, day, hour, minute }, timeZone);
}

// The schedule a request names, or null when it names no repeat and no time.
function readSchedule(text: string, context: PlannerContext): Extract<StudioAutomationTrigger, { kind: 'schedule' }> | null {
  const base = { weekday: null, date: null, timeZone: context.timeZone };
  const time = readTime(text, context.morningTime);
  if (/每(?:隔)?(?:一|1)?个?小时|整点/.test(text)) {
    const minute = /(?:第|过|的)?\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*分/.exec(text);
    const value = minute ? readNumber(minute[1]) ?? 0 : /半点/.test(text) ? 30 : 0;
    if (value > 59) fail('每小时的分钟数应在 0 到 59 之间');
    return { ...base, kind: 'schedule', repeat: 'hourly', time: `00:${pad(value)}` };
  }
  if (/工作日|周一(?:到|至|~|-)周五|星期一(?:到|至)星期五|礼拜一(?:到|至)礼拜五/.test(text)) {
    return { ...base, kind: 'schedule', repeat: 'weekdays', time: time ?? context.morningTime };
  }
  const weekly = /每(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])/.exec(text);
  if (weekly) return { ...base, kind: 'schedule', repeat: 'weekly', weekday: WEEKDAYS[weekly[1]], time: time ?? context.morningTime };
  if (/每天|每日|天天|每(?:个)?(?:早上|早晨|上午|中午|下午|傍晚|晚上)|每晚|每早/.test(text)) {
    return { ...base, kind: 'schedule', repeat: 'daily', time: time ?? context.morningTime };
  }
  // One-off: a named day or date, or just a time (the next time the clock shows it).
  const named = /(今天|今晚|明天|明早|明晚|后天)/.exec(text)?.[1];
  const dated = /(\d{1,2})月(\d{1,2})[日号]/.exec(text);
  if (!named && !dated && !time) return null;
  const at = time ?? context.morningTime;
  let date: string;
  if (dated) {
    const year = zonedDateParts(context.now, context.timeZone).year;
    date = `${year}-${pad(Number(dated[1]))}-${pad(Number(dated[2]))}`;
    if (instantOf(date, at, context.timeZone) <= context.now) date = `${year + 1}-${date.slice(5)}`;
  } else {
    const offset = named ? DAY_OFFSETS[named] ?? 0 : 0;
    date = localDate(context.now, context.timeZone, offset);
    if (!named && instantOf(date, at, context.timeZone) <= context.now) date = localDate(context.now + DAY_MS, context.timeZone, 0);
  }
  return { ...base, kind: 'schedule', repeat: 'once', time: at, date };
}

// The keywords a mail request is about: quoted text, “关于 X 的邮件”, “X 相关的邮件”, “来自 X 的邮件”.
function readMailQuery(text: string, projectName: string) {
  const quoted = /[「“"『']([^」”"』']{1,40})[」”"』']/.exec(text)?.[1];
  const about = /(?:关于|有关|涉及)\s*([^，。,；;\s的][^，。,；;\s]{0,29}?)\s*的?(?:邮件|信|内容)/.exec(text)?.[1];
  const related = /([^，。,；;\s]{1,30}?)\s*(?:相关|有关)的?(?:邮件|信)/.exec(text)?.[1]
    ?.replace(/^.*(?:邮箱|信箱|收件箱|邮件|里|中|内|把|看|读|查|找)/, '');
  const sender = /来自\s*([^，。,；;\s的]{1,60}?)\s*的?(?:邮件|信)/.exec(text)?.[1];
  const keyword = /(?:关键词|关键字|主题(?:包含|含有|里有)?)\s*[:是为]?\s*([^，。,；;\s]{1,30})/.exec(text)?.[1];
  let query = quoted ?? about ?? related ?? keyword ?? '';
  query = query.replace(/^(?:我的|我)/, '').replace(/的$/, '').trim();
  if (/^(?:这个|本|该)?项目$/.test(query)) query = projectName;
  if (!query && sender) query = /@/.test(sender) ? `from:${sender}` : sender;
  return query.slice(0, MAX_QUERY);
}

// The mailbox a request names (an address, Gmail or Outlook), else the project's default, else the only one.
function pickAccount(text: string, context: PlannerContext) {
  const address = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0]?.toLowerCase();
  const byAddress = address ? context.accounts.find(account => account.email.toLowerCase() === address) : undefined;
  if (byAddress) return byAddress.id;
  if (/gmail|谷歌/i.test(text)) return context.accounts.find(account => account.provider.startsWith('gmail'))?.id ?? '';
  if (/outlook|hotmail|微软|live\.com/i.test(text)) return context.accounts.find(account => account.provider === 'outlook')?.id ?? '';
  if (context.accounts.some(account => account.id === context.defaultMailAccountId)) return context.defaultMailAccountId;
  return context.accounts.length === 1 ? context.accounts[0].id : '';
}

function readNotifyWhen(text: string): StudioAutomationNotifyWhen {
  if (IMPORTANT.test(text)) return 'important';
  if (NEW_MAIL.test(text)) return 'new';
  return 'always';
}

// What to remind the owner of: the words after “提醒我”, else a sensible default.
function readMessage(text: string, fallback: string) {
  const said = /(?:提醒|告诉|通知|提示|叫)我(?:一下|一声)?\s*[:,，]?\s*(.+)$/.exec(text)?.[1]
    ?.replace(/[。！!；;，,]+$/, '').trim();
  return (said && !/^(?:一下|一声)$/.test(said) ? said : fallback).slice(0, MAX_MESSAGE);
}

function titleFor(trigger: StudioAutomationTrigger, action: StudioAutomationAction) {
  if (action.kind === 'mail-digest') {
    const subject = action.query.replace(/^from:/, '');
    return (subject ? `「${subject}」邮件摘要` : '邮件摘要').slice(0, MAX_TITLE);
  }
  if (trigger.kind === 'event') return '构建失败通知';
  return `提醒：${action.message}`.slice(0, MAX_TITLE);
}

function mailAction(text: string, context: PlannerContext, query = readMailQuery(text, context.projectName), notifyWhen = readNotifyWhen(text)): StudioAutomationAction {
  return { kind: 'mail-digest', accountId: pickAccount(text, context), query, notifyWhen, useAi: context.aiAvailable };
}

function finish(text: string, trigger: StudioAutomationTrigger, action: StudioAutomationAction, source: StudioAutomationPlan['source'], notes: string[], context: PlannerContext, title?: string): StudioAutomationPlan {
  const draft: StudioAutomationInput = { title: (title?.trim() || titleFor(trigger, action)).slice(0, MAX_TITLE), prompt: text, trigger, action };
  const needs: StudioAutomationPlan['needs'] = action.kind === 'mail-digest' && !action.accountId ? ['mail-account'] : [];
  if (action.kind === 'mail-digest' && !context.accounts.length) notes.push('还没有连接邮箱：先在「设置 → 邮箱」添加一个账户');
  else if (needs.length) notes.push('请选择要读取的邮箱');
  if (action.kind === 'mail-digest' && action.notifyWhen === 'important' && !action.useAi) notes.push('没有 DeepSeek 时，有新的相关邮件就算重要');
  return { draft, needs, source, notes };
}

// Studio's own reading of a request; null when it does not recognise what to do.
function readWithRules(text: string, context: PlannerContext): StudioAutomationPlan | null {
  const notes: string[] = [];
  if (BUILD_FAILED.test(text)) {
    if (MAIL.test(text)) notes.push('构建失败时只能发通知，不会去读邮件');
    const action: StudioAutomationAction = { kind: 'notify', message: readMessage(text, `「${context.projectName}」的 AI 开发失败了`) };
    return finish(text, { kind: 'event', event: 'build-failed' }, action, 'rules', notes, context);
  }
  const mail = MAIL.test(text);
  if (!mail && !NOTIFY.test(text)) return null;
  let trigger = readSchedule(text, context);
  if (!trigger) {
    if (!mail) fail(`说一下什么时候：比如“每天早上 8 点”“每周一上午 9 点”或“构建失败时”。${EXAMPLES}`);
    trigger = { kind: 'schedule', repeat: 'daily', time: context.morningTime, weekday: null, date: null, timeZone: context.timeZone };
    notes.push(`没说时间，先按每天 ${context.morningTime}`);
  }
  const action: StudioAutomationAction = mail ? mailAction(text, context) : { kind: 'notify', message: readMessage(text, `「${context.projectName}」的定时提醒`) };
  return finish(text, trigger, action, 'rules', notes, context);
}

// DeepSeek's JSON, checked field by field; anything outside the automation vocabulary is refused.
function readInterpreted(raw: unknown, text: string, context: PlannerContext): StudioAutomationPlan {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!value) fail(`没看懂要自动化什么。${EXAMPLES}`);
  if (typeof value.unsupported === 'string') fail(`这个做不了：${value.unsupported.slice(0, 120)}。自动化只能读取邮件和给你发通知。`);
  const trigger = value.trigger && typeof value.trigger === 'object' ? value.trigger as Record<string, unknown> : {};
  const action = value.action && typeof value.action === 'object' ? value.action as Record<string, unknown> : {};
  let parsedTrigger: StudioAutomationTrigger;
  if (trigger.kind === 'event' && trigger.event === 'build-failed') parsedTrigger = { kind: 'event', event: 'build-failed' };
  else if (trigger.kind === 'schedule' && ['once', 'hourly', 'daily', 'weekdays', 'weekly'].includes(String(trigger.repeat))) {
    const time = typeof trigger.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) ? trigger.time : context.morningTime;
    const weekday = Number.isInteger(trigger.weekday) && Number(trigger.weekday) >= 0 && Number(trigger.weekday) <= 6 ? Number(trigger.weekday) : null;
    const date = typeof trigger.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(trigger.date) ? trigger.date : null;
    const repeat = trigger.repeat as StudioAutomationRepeat;
    if (repeat === 'weekly' && weekday === null) fail('没看懂是每周哪一天');
    if (repeat === 'once' && !date) fail('没看懂是哪一天');
    parsedTrigger = { kind: 'schedule', repeat, time, weekday: repeat === 'weekly' ? weekday : null, date: repeat === 'once' ? date : null, timeZone: context.timeZone };
  } else fail(`没看懂什么时候运行。${EXAMPLES}`);
  let parsedAction: StudioAutomationAction;
  if (action.kind === 'mail-digest' && parsedTrigger.kind === 'schedule') {
    const query = typeof action.query === 'string' ? action.query.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_QUERY) : '';
    const notifyWhen = ['important', 'new', 'always'].includes(String(action.notifyWhen)) ? action.notifyWhen as StudioAutomationNotifyWhen : readNotifyWhen(text);
    parsedAction = mailAction(text, context, query, notifyWhen);
  } else if (action.kind === 'notify') {
    const message = typeof action.message === 'string' ? action.message.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_MESSAGE) : '';
    parsedAction = { kind: 'notify', message: message || readMessage(text, `「${context.projectName}」的提醒`) };
  } else fail(`没看懂要做什么。${EXAMPLES}`);
  return finish(text, parsedTrigger, parsedAction, 'deepseek', [], context, typeof value.title === 'string' ? value.title : undefined);
}

// The instructions DeepSeek reads; the owner's words go separately, as data.
function interpretHint(context: PlannerContext) {
  return [
    '把用户的一句话转换成 Agent Cloud Studio 项目自动化的 JSON。只能使用下面这些值，只输出 JSON。',
    '{"title": "不超过 20 字", "trigger": {"kind": "schedule", "repeat": "once|hourly|daily|weekdays|weekly", "time": "HH:MM", "weekday": 0-6 或 null（0 是周日，只用于 weekly）, "date": "YYYY-MM-DD" 或 null（只用于 once）} 或 {"kind": "event", "event": "build-failed"},',
    ' "action": {"kind": "mail-digest", "query": "邮件搜索关键词，可为空", "notifyWhen": "important|new|always"} 或 {"kind": "notify", "message": "通知内容"}}',
    '自动化只能：读取用户自己的邮箱并总结（只读）、给用户本人发通知。要发邮件、回复、下单、删除或在 Studio 之外做事时，输出 {"unsupported": "原因"}。',
    `项目：${context.projectName.slice(0, 80)}。用户所在时区 ${context.timeZone}，今天是 ${localDate(context.now, context.timeZone, 0)}。“早上”指 ${context.morningTime}。`,
  ].join('\n');
}

/**
 * Used by the Studio automations service: turns the owner's words (e.g. “每天早上读一下我邮箱里超级教授相关的邮件，有重要
 * 的就通知我”) into an automation for the owner to review. Studio's rules read it first; what they do not recognise
 * goes to DeepSeek when `interpret` is given, and its answer is checked against the same vocabulary. Requests that
 * would send mail or act outside Studio are refused before anything else.
 */
export async function planAutomation(input: string, context: PlannerContext, interpret?: Interpret): Promise<StudioAutomationPlan> {
  const text = normalise(input);
  if (!text) fail('先说说想自动化什么', 400);
  if (text.length > MAX_TEXT) fail(`最多 ${MAX_TEXT} 个字`, 400);
  if (OUTSIDE_STUDIO.some(pattern => pattern.test(text))) {
    fail('自动化只能读取你的邮件、给你本人发通知，不会替你发邮件、下单或在 Studio 之外操作。', 422, 'AUTOMATION_OUTSIDE_STUDIO');
  }
  const planned = readWithRules(text, context);
  if (planned) return planned;
  if (!interpret) fail(`没看懂要自动化什么。${EXAMPLES}`);
  let raw: unknown;
  try {
    raw = await interpret(text, interpretHint(context));
  } catch {
    fail(`没看懂要自动化什么，DeepSeek 也暂时没有回应。${EXAMPLES}`);
  }
  return readInterpreted(raw, text, context);
}
