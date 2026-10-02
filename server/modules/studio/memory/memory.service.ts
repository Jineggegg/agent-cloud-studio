import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  StudioMemoryFolder,
  StudioMemoryNoteDetail,
  StudioMemoryNoteSummary,
  StudioMemorySource,
  StudioMemoryStatus,
  StudioMemoryToolCaller,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

// A hub project with the memory folder its notes belong in.
type HubFolder = { id: string; name: string; tone: string; glyph: string; folder: string };
type Dependencies = {
  client: StudioMemoryToolCaller;
  url: string;
  // Whether Studio's DeepSeek bridge is switched on (STUDIO_MEMORY_DEEPSEEK).
  deepseekEnabled: boolean;
  // The user's hub projects with their memory folders, so folders can carry the project's icon.
  projects?: (userId: number) => HubFolder[];
  // Home directory whose client configs are checked; injected by tests.
  home?: string;
  // Reads a small text file, or null when it is missing; injected by tests.
  readText?: (file: string) => string | null;
  now?: () => number;
};
type SearchOptions = {
  // Only notes in these top-level folders; null or absent means every folder.
  folders?: string[] | null;
  limit?: number;
  // `terms` searches only the segmented keywords (for long chat messages); `query` also tries the text as typed.
  mode?: 'query' | 'terms';
  signal?: AbortSignal;
};
type WriteInput = {
  title: string;
  content: string;
  folder: string;
  tags: string[];
  keywords: string[];
  overwrite: boolean;
  source: StudioMemorySource;
};
type Json = Record<string, unknown>;

const SERVER_NAME = 'studio-memory';
const CONVENTIONS_MARK = '<!-- studio-memory:begin -->';
const SOURCES: StudioMemorySource[] = ['claude', 'codex', 'deepseek'];
const QUERY_CHARS = 200;
const SNIPPET_CHARS = 600;
const READ_CHARS = 200_000;
// Notes Studio writes on DeepSeek's behalf stay short: durable facts, not transcripts.
const NOTE_CHARS = 8000;
const TITLE_CHARS = 120;
const SOURCE_CACHE_MS = 15_000;
const FOLDER = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const TAG = /^[\p{L}\p{N}_-]{1,24}$/u;

// Words that carry no meaning on their own in a search; single Han characters are dropped separately.
const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和', '与', '或', '吗', '呢', '吧', '啊', '呀', '请', '把', '被', '给', '就', '都', '也', '还',
  '帮我', '一下', '这个', '那个', '这些', '那些', '什么', '怎么', '怎样', '如何', '为什么', '可以', '能否', '需要', '一个', '没有', '不是', '就是',
  '还是', '然后', '现在', '我们', '你们', '他们', '自己', '已经', '以及', '因为', '所以', '如果', '但是', '还有',
  'the', 'and', 'for', 'are', 'with', 'what', 'how', 'why', 'please', 'can', 'you', 'this', 'that', 'from', 'have', 'into', 'about',
]);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN = /^\p{Script=Han}$/u;

// Splits text into search keywords for basic-memory's full-text index, which tokenizes on spaces and
// punctuation and therefore cannot find a word in the middle of an unbroken run of Chinese. Words come from
// Intl.Segmenter; neighbouring single Han characters (which its dictionary often leaves split, e.g. 端|口) are
// joined back into one word, and stop words and lone characters are dropped.
function memorySearchTerms(text: string, max = 10): string[] {
  const terms: string[] = [];
  let run = '';
  const push = (word: string) => {
    if (terms.length < max && word && !STOP_WORDS.has(word) && !terms.includes(word)) terms.push(word);
  };
  const flush = () => {
    if ([...run].length >= 2) push(run);
    run = '';
  };
  for (const { segment, isWordLike } of segmenter.segment(text.slice(0, 2000))) {
    const word = isWordLike ? segment.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '') : '';
    if (word && HAN.test(word) && !STOP_WORDS.has(word)) { run += word; continue; }
    flush();
    if (!word || [...word].length < 2) continue;
    push(word);
  }
  flush();
  return terms;
}

/**
 * Names the memory folder of a project: the first candidate (workspace path, remote directory, project name)
 * whose last path segment survives slugging, lowercased like the conventions tell Claude Code and Codex to
 * do (`~/projects/Agent-Cloud-Studio` → `agent-cloud-studio`). Used by studio.module for hub projects.
 */
export function memoryFolderName(candidates: string[], fallbackId: string) {
  for (const candidate of candidates) {
    const base = path.posix.basename(candidate.trim().replace(/\\/g, '/').replace(/\/+$/, ''));
    const slug = base.normalize('NFKC').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
    if (slug && FOLDER.test(slug)) return slug;
  }
  return `project-${fallbackId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'unnamed'}`;
}

// Credential shapes a note must never contain. Each entry names what was found, never the value itself.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, '私钥'],
  [/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/, 'API 密钥'],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/, 'API 密钥'],
  [/\bAKIA[0-9A-Z]{16}\b/, '云服务访问密钥'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'API 密钥'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub 令牌'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, 'GitHub 令牌'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'GitLab 令牌'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack 令牌'],
  [/\b(?:npm|hf)_[A-Za-z0-9]{30,}/, '访问令牌'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, '登录令牌（JWT）'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, '访问令牌'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, '带密码的链接'],
  [/\b(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?[^\s"',;]{6,}/i, '密码或密钥'],
  [/(?:密码|口令|密钥|秘钥|私钥|令牌)\s*(?:[:：=]|是|为)\s*[^\s，。,;；]{4,}/, '密码或密钥'],
];

// What kind of credential `text` appears to contain (for a refusal that never repeats the value), or null.
// Besides known token formats and `password = …` style assignments it flags long random-looking strings with
// several upper-case letters, lower-case letters and digits each; hex hashes and camelCase paths pass.
function findMemorySecret(text: string): string | null {
  for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(text)) return label;
  const count = (value: string, pattern: RegExp) => value.match(pattern)?.length ?? 0;
  for (const [value] of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    if (count(value, /[A-Z]/g) >= 3 && count(value, /[a-z]/g) >= 3 && count(value, /\d/g) >= 3) return '疑似密钥的随机字符串';
  }
  return null;
}

function record(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}
function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}
function fail(message: string, statusCode: number, code = 'MEMORY_ERROR'): never {
  throw new AppError(message, { statusCode, code });
}
function folderOf(filePath: string) {
  const parts = filePath.replace(/^\/+/, '').split('/');
  return parts.length > 1 ? parts[0] : '';
}
// Markdown reduced to one line of plain text for list snippets and chat context.
function snippet(markdown: string) {
  return markdown.replace(/^---[\s\S]*?\n---\s*/, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`+/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
}
function tagList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean).slice(0, 20);
}
function sourceFrom(tags: string[], explicit: unknown): StudioMemorySource | null {
  const named = text(explicit).toLowerCase();
  if (SOURCES.includes(named as StudioMemorySource)) return named as StudioMemorySource;
  return SOURCES.find(source => tags.some(tag => tag.toLowerCase() === source)) ?? null;
}
function cleanList(values: string[], limit: number) {
  const items: string[] = [];
  for (const value of values) {
    const item = value.normalize('NFKC').trim().replace(/\s+/g, '-');
    if (TAG.test(item) && !items.some(existing => existing.toLowerCase() === item.toLowerCase())) items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}
function searchRows(value: unknown): Json[] {
  const results = record(value)?.results;
  return Array.isArray(results) ? results.map(record).filter((row): row is Json => row !== null) : [];
}
function summaryFromSearch(row: Json): StudioMemoryNoteSummary | null {
  const id = text(row.permalink);
  if (!id || (row.type !== undefined && row.type !== 'entity')) return null;
  return {
    id, title: text(row.title) || id, folder: folderOf(text(row.file_path)), source: null,
    updatedAt: text(row.updated_at) || null, snippet: snippet(text(row.content)),
  };
}
// list_directory nests children under directories when it recurses; both shapes are flattened.
function flatten(nodes: unknown, into: Json[] = []): Json[] {
  if (!Array.isArray(nodes)) return into;
  for (const node of nodes) {
    const item = record(node);
    if (!item) continue;
    into.push(item);
    flatten(item.children, into);
  }
  return into;
}

/** Used by studio.module, the memory routes and the DeepSeek bridge: Studio's view of the shared memory server. */
export function createMemoryService(deps: Dependencies) {
  const client = deps.client;
  const now = deps.now ?? Date.now;
  const home = deps.home ?? os.homedir();
  const readText = deps.readText ?? ((file: string) => { try { return readFileSync(file, 'utf8'); } catch { return null; } });
  let sourceCache: { at: number; map: Map<string, StudioMemorySource> } | null = null;

  // Which agent wrote each note, from three tag-filtered searches; cached briefly because listings ask often.
  // Sources only decorate rows, so a failed lookup yields no sources instead of failing the listing.
  async function sources(signal?: AbortSignal) {
    if (sourceCache && now() - sourceCache.at < SOURCE_CACHE_MS) return sourceCache.map;
    const map = new Map<string, StudioMemorySource>();
    try {
      const lists = await Promise.all(SOURCES.map(async source => ({
        source,
        rows: searchRows(await client.call('search_notes', { tags: [source], entity_types: ['entity'], page_size: 200, output_format: 'json' }, { signal })),
      })));
      for (const { source, rows } of lists) for (const row of rows) {
        const id = text(row.permalink);
        if (id && !map.has(id)) map.set(id, source);
      }
      sourceCache = { at: now(), map };
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return map;
  }
  function folders(userId: number | undefined, names: Iterable<string>): StudioMemoryFolder[] {
    const projects = userId === undefined ? [] : deps.projects?.(userId) ?? [];
    return [...new Set(names)].filter(Boolean)
      .sort((a, b) => (a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b, 'zh-CN')))
      .map(name => {
        const project = projects.find(item => item.folder === name);
        return { name, project: project ? { id: project.id, name: project.name, tone: project.tone, glyph: project.glyph } : null };
      });
  }

  async function search(query: string, options: SearchOptions = {}): Promise<StudioMemoryNoteSummary[]> {
    const typed = query.trim().slice(0, QUERY_CHARS);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const terms = memorySearchTerms(options.mode === 'terms' ? query : typed);
    const queries: string[] = [];
    if (options.mode !== 'terms' && typed) queries.push(typed);
    // Explicit prefix wildcards: basic-memory leaves `word*` alone inside an OR query. A single keyword equal to
    // the typed text adds nothing, since basic-memory already prefix-matches a plain word.
    const expanded = terms.map(term => `${term}*`).join(' OR ');
    if (expanded && !(queries.length && expanded === `${typed}*`)) queries.push(expanded);
    if (!queries.length) return [];
    const pageSize = options.folders ? 40 : Math.min(limit * 2, 60);
    const seen = new Set<string>();
    const notes: StudioMemoryNoteSummary[] = [];
    for (const fts of queries) {
      const rows = searchRows(await client.call('search_notes', { query: fts, entity_types: ['entity'], page_size: pageSize, output_format: 'json' }, { signal: options.signal }));
      for (const row of rows) {
        const note = summaryFromSearch(row);
        if (!note || seen.has(note.id) || (options.folders && !options.folders.includes(note.folder))) continue;
        seen.add(note.id);
        notes.push(note);
      }
      if (notes.length >= limit) break;
    }
    const map = await sources(options.signal);
    return notes.slice(0, limit).map(note => ({ ...note, source: map.get(note.id) ?? null }));
  }

  async function recent(options: { userId?: number; folder?: string; limit?: number; signal?: AbortSignal } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
    const listing = record(await client.call('list_directory', { dir_name: '/', depth: 3, sort: 'updated_desc', page_size: 200, output_format: 'json' }, { signal: options.signal }));
    const nodes = flatten(listing?.nodes);
    const names = new Set<string>();
    const notes: StudioMemoryNoteSummary[] = [];
    for (const node of nodes) {
      if (node.type === 'directory') {
        const segments = text(node.directory_path).split('/').filter(Boolean);
        if (segments.length === 1) names.add(segments[0]);
        continue;
      }
      const id = text(node.permalink);
      const filePath = text(node.file_path);
      if (node.type !== 'file' || !id || !filePath.toLowerCase().endsWith('.md')) continue;
      const folder = folderOf(filePath);
      if (folder) names.add(folder);
      notes.push({ id, title: text(node.title) || path.posix.basename(filePath, '.md'), folder, source: null, updatedAt: text(node.updated_at) || null, snippet: '' });
    }
    const selected = notes.filter(note => options.folder === undefined || note.folder === options.folder)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, limit);
    const map = await sources(options.signal);
    return {
      notes: selected.map(note => ({ ...note, source: map.get(note.id) ?? null })),
      folders: folders(options.userId, names),
      total: notes.length,
    };
  }

  async function read(id: string, signal?: AbortSignal): Promise<StudioMemoryNoteDetail> {
    const note = record(await client.call('read_note', { identifier: id, output_format: 'json' }, { signal }));
    // read_note falls back to a title search; only an exact permalink match is the note that was asked for.
    if (!note || text(note.permalink) !== id || typeof note.content !== 'string') fail('笔记不存在或已被删除', 404, 'MEMORY_NOTE_NOT_FOUND');
    const frontmatter = record(note.frontmatter) ?? {};
    const tags = tagList(frontmatter.tags);
    const content = note.content.replace(/^\s*\n/, '');
    return {
      id, title: text(note.title) || id, folder: folderOf(text(note.file_path)), source: sourceFrom(tags, frontmatter.source),
      updatedAt: null, snippet: snippet(content), tags, content: content.slice(0, READ_CHARS), truncated: content.length > READ_CHARS,
    };
  }

  return {
    search,
    recent,
    read,
    async remove(id: string, signal?: AbortSignal) {
      await read(id, signal);
      const result = record(await client.call('delete_note', { identifier: id, output_format: 'json' }, { signal }));
      if (result?.deleted !== true) fail('笔记不存在或已被删除', 404, 'MEMORY_NOTE_NOT_FOUND');
      sourceCache = null;
      return { deleted: true as const };
    },
    // Validated write on behalf of a model: size limits, no credentials, the writer's tag and optional keywords
    // (spaced words make Chinese notes findable by the full-text index).
    async write(input: WriteInput, signal?: AbortSignal) {
      const title = input.title.normalize('NFC').replace(/\s+/g, ' ').trim();
      if (!title || title.length > TITLE_CHARS || /[\p{Cc}/\\]/u.test(title)) fail(`标题需为 1–${TITLE_CHARS} 个字符，且不能包含斜杠或控制字符`, 400, 'MEMORY_INVALID_NOTE');
      if (!FOLDER.test(input.folder)) fail('文件夹名称无效', 400, 'MEMORY_INVALID_NOTE');
      const body = input.content.replace(/\r\n?/g, '\n').trim();
      if (!body) fail('笔记内容不能为空', 400, 'MEMORY_INVALID_NOTE');
      if (body.length > NOTE_CHARS) fail(`笔记超过 ${NOTE_CHARS} 字符；只记录持久的要点`, 400, 'MEMORY_INVALID_NOTE');
      const keywords = cleanList(input.keywords, 8);
      const tags = cleanList([input.source, ...input.tags], 6);
      const content = keywords.length ? `${body}\n\n关键词：${keywords.join(' ')}` : body;
      const secret = findMemorySecret(`${title}\n${content}\n${tags.join(' ')}`);
      if (secret) fail(`内容看起来包含${secret}，已拒绝保存。共享记忆不能存放密钥、令牌、密码或私钥。`, 422, 'MEMORY_SECRET_REJECTED');
      const result = record(await client.call('write_note', {
        title, directory: input.folder, content, tags, overwrite: input.overwrite, output_format: 'json',
      }, { signal }));
      if (text(result?.action) === 'conflict') fail('同名笔记已存在：先读取它，再用 overwrite=true 写入合并后的完整内容。', 409, 'MEMORY_NOTE_EXISTS');
      const id = text(result?.permalink);
      if (!id) fail('笔记没有保存成功', 502, 'MEMORY_TOOL_ERROR');
      sourceCache = null;
      return { id, title, folder: input.folder, action: text(result?.action) === 'updated' ? 'updated' as const : 'created' as const };
    },
    async status(): Promise<StudioMemoryStatus> {
      let reachable = false;
      let project: string | null = null;
      let notesPath: string | null = null;
      // Reachability is a protocol ping, which the server answers without touching its index; the project details
      // come from a tool call that may be slow right after a long idle, so missing details never mean "down".
      try {
        await client.ping({ timeoutMs: 4000 });
        reachable = true;
      } catch { /* reported as unreachable */ }
      if (reachable) {
        try {
          const listing = record(await client.call('list_memory_projects', { output_format: 'json' }));
          project = text(listing?.constrained_project) || text(listing?.default_project) || null;
          const entry = (Array.isArray(listing?.projects) ? listing.projects : []).map(record).find(item => item && text(item.name) === project);
          const location = text(entry?.path);
          // Shown to the owner as ~/… rather than the full home path.
          notesPath = location ? (location === home || location.startsWith(`${home}/`) ? `~${location.slice(home.length)}` : location) : null;
        } catch { /* details stay unknown */ }
      }

      const claudeEntry = (() => {
        try { return record(record(record(JSON.parse(readText(path.join(home, '.claude.json')) ?? 'null'))?.mcpServers)?.[SERVER_NAME]); } catch { return null; }
      })();
      const codexConfig = readText(path.join(home, '.codex', 'config.toml')) ?? '';
      const codexTable = new RegExp(String.raw`^\s*\[mcp_servers\.(?:"${SERVER_NAME}"|${SERVER_NAME})\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))`, 'm').exec(codexConfig);
      const hasConventions = (file: string) => (readText(file) ?? '').includes(CONVENTIONS_MARK);
      return {
        reachable, url: deps.url, project, notesPath,
        clients: {
          claude: {
            registered: claudeEntry !== null,
            transport: claudeEntry ? text(claudeEntry.type) || (claudeEntry.command ? 'stdio' : null) : null,
            conventions: hasConventions(path.join(home, '.claude', 'CLAUDE.md')),
          },
          codex: {
            registered: codexTable !== null,
            transport: codexTable ? (/^\s*url\s*=/m.test(codexTable[1]) ? 'http' : /^\s*command\s*=/m.test(codexTable[1]) ? 'stdio' : null) : null,
            conventions: hasConventions(path.join(home, '.codex', 'AGENTS.md')),
          },
          deepseek: { enabled: deps.deepseekEnabled },
        },
      };
    },
  };
}
