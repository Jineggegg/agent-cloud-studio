import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  StudioMemoryAgentFix,
  StudioMemoryAgentId,
  StudioMemoryAgentStatus,
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
  // Linux home whose Claude Code and Codex configs are checked (the WSL agents); injected by tests.
  home?: string;
  // The Windows user's home as WSL sees it (/mnt/c/Users/<name>), where the Windows Claude Code and Codex desktop
  // apps keep their configs; null or absent when Studio does not run under WSL. See findWindowsHome.
  windowsHome?: string | null;
  // Reads a small text file, or null when it is missing; injected by tests.
  readText?: (file: string) => Promise<string | null> | string | null;
  // Names in a directory, or [] when it is missing; injected by tests.
  listDir?: (dir: string) => Promise<string[]> | string[];
  now?: () => number;
};
// One agent installation whose wiring the status card reports.
type AgentProbe = { id: StudioMemoryAgentId; kind: 'claude' | 'codex'; home: string; windows: boolean };
// A `studio-memory` entry found in an agent's config.
type Registration = { transport: string | null; url: string | null };
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
// list_directory returns at most 200 nodes per page and recurses at most 10 levels.
const DIRECTORY_PAGE = 200;
const DIRECTORY_PAGES = 5;
const DIRECTORY_DEPTH = 10;
const FOLDER = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const TAG = /^[\p{L}\p{N}_-]{1,24}$/u;
const WRITERS: Record<StudioMemorySource, string> = { claude: 'Claude Code', codex: 'Codex', deepseek: 'DeepSeek' };
// The install script wires every agent it can reach (both homes) and writes the conventions.
const SCRIPT_FIX: StudioMemoryAgentFix = { where: '在 WSL 的仓库目录运行', command: 'bash scripts/wsl/install-memory.sh' };
// PowerShell that finds the newest claude.exe the Claude desktop app downloaded, in the Store app's virtualized
// %APPDATA% or the plain one; the same line scripts/wsl/install-memory.sh prints.
const WINDOWS_DESKTOP_CLAUDE = String.raw`$claude = (Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\*\*\claude.exe", "$env:APPDATA\Claude\claude-code\*\*\claude.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1).FullName`;
// Folders under C:\Users that are not a person's home.
const SYSTEM_USERS = new Set(['public', 'default', 'default user', 'all users', 'defaultapppool', 'wdagutilityaccount']);

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

// Words that introduce a credential in English notes ("API key", "api_key", "client-secret", …).
const CREDENTIAL_WORDS = '(?:password|passwd|pwd|passphrase|secret|token|api[_ -]?key|apikey|access[_ -]?key|secret[_ -]?key|client[_ -]?secret|private[_ -]?key)';
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
  [new RegExp(String.raw`\b${CREDENTIAL_WORDS}\b\s*["']?\s*[:=]\s*["']?[^\s"',;]{6,}`, 'i'), '密码或密钥'],
  // Prose: "my password is Hunter2xyz", "api key was 9f8e7d6c5b4a". The value must hold a digit or a symbol, so
  // "the token is stored in the vault" passes.
  [new RegExp(String.raw`\b${CREDENTIAL_WORDS}\s+(?:is|was|are|equals)\s*[:=]?\s*["'\`]?(?=[^\s"'\`,;]*[\d!@#$%^&*])[^\s"'\`,;/\\]{6,}`, 'i'), '密码或密钥'],
  // Just a space: "password Hunter2xyz". An 8–64 character ASCII value with a letter and a digit and no path
  // separators, so "token budget 4096", "private key ed25519" and "private key ~/.ssh/id_ed25519" pass.
  [new RegExp(String.raw`\b${CREDENTIAL_WORDS}\s+["'\`]?(?=[!-~]*\d)(?=[!-~]*[A-Za-z])(?![!-~]*[/\\])[!-~]{8,64}(?![!-~])`, 'i'), '密码或密钥'],
  [/(?:密码|口令|密钥|秘钥|私钥|令牌)\s*(?:[:：=]|是|为)\s*[^\s，。,;；]{4,}/, '密码或密钥'],
  // 「密码 Hunter2xyz」: separated by spaces only, with the same ASCII-value shape as above.
  [/(?:密码|口令|密钥|秘钥|私钥|令牌)\s+(?=[!-~]*\d)(?=[!-~]*[A-Za-z])(?![!-~]*[/\\])[!-~]{8,64}(?![!-~])/, '密码或密钥'],
];

/**
 * What kind of credential `text` appears to contain (for a refusal that never repeats the value), or null.
 * Besides known token formats, `password = …` assignments and `password is …` prose it flags long random-looking
 * strings with several upper-case letters, lower-case letters and digits each; hex hashes and camelCase paths pass.
 * Used here to refuse writes and by the DeepSeek bridge (memory-chat.service) to keep notes that Claude Code or
 * Codex wrote with a credential in them from being sent to the DeepSeek API.
 */
export function findMemorySecret(text: string): string | null {
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
// One page of list_directory: a flat node list (directories first) with the total and whether more pages follow.
function directoryPage(value: unknown) {
  const listing = record(value);
  const nodes = Array.isArray(listing?.nodes) ? listing.nodes.map(record).filter((node): node is Json => node !== null) : [];
  return { nodes, total: typeof listing?.total === 'number' ? listing.total : null, more: listing?.has_more === true };
}
function noteFromNode(node: Json): StudioMemoryNoteSummary | null {
  const id = text(node.permalink);
  const filePath = text(node.file_path);
  if (node.type !== 'file' || !id || !filePath.toLowerCase().endsWith('.md')) return null;
  return { id, title: text(node.title) || path.posix.basename(filePath, '.md'), folder: folderOf(filePath), source: null, updatedAt: text(node.updated_at) || null, snippet: '' };
}

/**
 * Used by studio.module: the Windows user's home as WSL sees it (`/mnt/c/Users/<name>`), where the Windows Claude
 * Code and Codex desktop apps keep their configs, or null when Studio does not run under WSL. Prefers the folder
 * named like the Linux user, else the only user folder holding a `.claude` or `.codex` directory. Synchronous and
 * meant to run once at startup (STUDIO_MEMORY_WINDOWS_HOME overrides it).
 */
export function findWindowsHome(root = '/mnt/c/Users'): string | null {
  try {
    if (!/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return null;
    const names = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !SYSTEM_USERS.has(entry.name.toLowerCase())).map(entry => entry.name);
    const hasAgents = (name: string) => existsSync(path.join(root, name, '.claude')) || existsSync(path.join(root, name, '.codex'));
    const own = names.find(name => name.toLowerCase() === os.userInfo().username.toLowerCase());
    if (own && hasAgents(own)) return path.join(root, own);
    const candidates = names.filter(hasAgents);
    return candidates.length === 1 ? path.join(root, candidates[0]) : null;
  } catch {
    return null;
  }
}

// Whether two MCP URLs name the same server. localhost and 127.0.0.1 are one host: Windows reaches WSL's loopback
// through localhost forwarding, so a Windows registration may use either.
function sameEndpoint(a: string, b: string) {
  const canonical = (value: string) => {
    try {
      const url = new URL(value.trim());
      const host = url.hostname === 'localhost' || url.hostname === '[::1]' ? '127.0.0.1' : url.hostname;
      return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  };
  const left = canonical(a);
  return left !== null && left === canonical(b);
}
// /mnt/c/Users/me/.codex/config.toml → C:\Users\me\.codex\config.toml, the way the owner sees it on Windows.
function windowsPath(file: string) {
  const match = /^\/mnt\/([a-z])(\/.*)?$/i.exec(file);
  return match ? `${match[1].toUpperCase()}:${(match[2] ?? '/').replace(/\//g, '\\')}` : file;
}
// The user-scope `mcpServers.studio-memory` entry of a .claude.json (read, never printed), or null.
function claudeRegistration(raw: string | null): Registration | null {
  let entry: Json | null = null;
  try { entry = record(record(record(JSON.parse(raw ?? 'null'))?.mcpServers)?.[SERVER_NAME]); } catch { return null; }
  if (!entry) return null;
  return { transport: text(entry.type) || (entry.command ? 'stdio' : entry.url ? 'http' : null), url: text(entry.url) || null };
}
// The `[mcp_servers.studio-memory]` table of a Codex config.toml, or null. Codex speaks streamable HTTP when the
// table has a `url`, stdio when it has a `command`.
function codexRegistration(raw: string | null): Registration | null {
  const table = new RegExp(String.raw`^\s*\[mcp_servers\.(?:"${SERVER_NAME}"|'${SERVER_NAME}'|${SERVER_NAME})\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))`, 'm').exec(raw ?? '');
  if (!table) return null;
  const url = /^\s*url\s*=\s*["']([^"'\n]*)["']/m.exec(table[1])?.[1] ?? null;
  return { transport: url ? 'http' : /^\s*command\s*=/m.test(table[1]) ? 'stdio' : null, url };
}

/** Used by studio.module, the memory routes and the DeepSeek bridge: Studio's view of the shared memory server. */
export function createMemoryService(deps: Dependencies) {
  const client = deps.client;
  const now = deps.now ?? Date.now;
  const home = deps.home ?? os.homedir();
  const windowsHome = deps.windowsHome ?? null;
  // Config files are read asynchronously: the Windows ones sit on /mnt/c, which is slow to reach from WSL.
  const readText = async (file: string) => {
    if (deps.readText) return deps.readText(file);
    try { return await readFile(file, 'utf8'); } catch { return null; }
  };
  const listDir = async (dir: string) => {
    if (deps.listDir) return deps.listDir(dir);
    try { return await readdir(dir); } catch { return []; }
  };
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

  // Every top-level folder. Directories come first in a listing, so the first file (or the last page) ends it.
  async function topFolders(signal?: AbortSignal) {
    const names: string[] = [];
    for (let page = 1; page <= DIRECTORY_PAGES; page++) {
      const listing = directoryPage(await client.call('list_directory', { dir_name: '/', depth: 1, page, page_size: DIRECTORY_PAGE, output_format: 'json' }, { signal }));
      for (const node of listing.nodes) {
        const name = node.type === 'directory' ? text(node.directory_path).split('/').filter(Boolean)[0] : '';
        if (name) names.push(name);
      }
      if (!listing.more || listing.nodes.some(node => node.type !== 'directory')) break;
    }
    return names;
  }

  // The newest notes of the whole memory or of one folder (all its subfolders included), with the exact number of
  // notes there. The server filters to Markdown files and sorts by update time, so the first page is the newest.
  async function recent(options: { userId?: number; folder?: string; limit?: number; signal?: AbortSignal } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
    const [listing, names] = await Promise.all([
      client.call('list_directory', {
        dir_name: options.folder ? `/${options.folder}` : '/', depth: DIRECTORY_DEPTH, file_name_glob: '*.md', sort: 'updated_desc',
        page: 1, page_size: limit, output_format: 'json',
      }, { signal: options.signal }).then(directoryPage),
      topFolders(options.signal),
    ]);
    const notes = listing.nodes.map(noteFromNode).filter((note): note is StudioMemoryNoteSummary => note !== null).slice(0, limit);
    const map = await sources(options.signal);
    return {
      notes: notes.map(note => ({ ...note, source: map.get(note.id) ?? null })),
      folders: folders(options.userId, names),
      // Notes in the listed scope (the folder when one is given), not just the ones returned.
      total: listing.total ?? notes.length,
    };
  }

  // The note in `folder` (top level) whose title is `title`, compared the way basic-memory names files.
  async function noteTitled(folder: string, title: string, signal?: AbortSignal) {
    const wanted = title.normalize('NFC').toLowerCase();
    for (let page = 1; page <= DIRECTORY_PAGES; page++) {
      const listing = directoryPage(await client.call('list_directory', { dir_name: `/${folder}`, depth: 1, file_name_glob: '*.md', page, page_size: DIRECTORY_PAGE, output_format: 'json' }, { signal }));
      const match = listing.nodes.map(noteFromNode).find(note => note && note.title.normalize('NFC').toLowerCase() === wanted);
      if (match) return match;
      if (!listing.more) break;
    }
    return null;
  }

  // How one agent installation is wired, from its own config files. Only presence and the URL are read.
  async function agentStatus(probe: AgentProbe): Promise<StudioMemoryAgentStatus> {
    const configFile = probe.kind === 'claude' ? path.join(probe.home, '.claude.json') : path.join(probe.home, '.codex', 'config.toml');
    const instructionsFile = probe.kind === 'claude' ? path.join(probe.home, '.claude', 'CLAUDE.md') : path.join(probe.home, '.codex', 'AGENTS.md');
    const [config, instructions, appDir] = await Promise.all([
      readText(configFile), readText(instructionsFile), listDir(path.join(probe.home, probe.kind === 'claude' ? '.claude' : '.codex')),
    ]);
    const registration = probe.kind === 'claude' ? claudeRegistration(config) : codexRegistration(config);
    const shared = registration !== null && registration.transport === 'http' && registration.url !== null && sameEndpoint(registration.url, deps.url);
    const conventions = (instructions ?? '').includes(CONVENTIONS_MARK);
    const installed = config !== null || appDir.length > 0;
    let fix: StudioMemoryAgentFix | null = null;
    if (installed && !(shared && conventions)) {
      fix = SCRIPT_FIX;
      // Windows Claude Code is registered only through its own CLI, run on Windows: its .claude.json is a large
      // state file the running app rewrites constantly, so nothing edits it by hand, and the WSL script cannot start
      // Windows programs (interop may be off). The script still writes the conventions file.
      if (probe.windows && probe.kind === 'claude' && !shared) {
        fix = windowsClaudeFix(await windowsClaudeCli(probe.home), registration !== null);
      }
    }
    const shown = (file: string) => (probe.windows ? windowsPath(file) : file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file);
    return {
      id: probe.id, installed, registered: registration !== null, transport: registration?.transport ?? null, shared, conventions,
      config: shown(configFile), fix,
    };
  }
  // Which Windows Claude Code CLI exists: the one the desktop app downloads (claude-code\<version>\<build>\claude.exe,
  // not on PATH; the Store app's %APPDATA% is virtualized under Packages\Claude_*\LocalCache\Roaming), one on PATH
  // (native installer or npm), or none.
  async function windowsClaudeCli(winHome: string): Promise<'desktop' | 'path' | null> {
    const packages = path.join(winHome, 'AppData', 'Local', 'Packages');
    const roots = [
      ...(await listDir(packages)).filter(name => name.startsWith('Claude_')).map(name => path.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude-code')),
      path.join(winHome, 'AppData', 'Roaming', 'Claude', 'claude-code'),
    ];
    for (const root of roots) {
      for (const version of await listDir(root)) {
        for (const build of await listDir(path.join(root, version))) {
          if ((await listDir(path.join(root, version, build))).includes('claude.exe')) return 'desktop';
        }
      }
    }
    if ((await listDir(path.join(winHome, '.local', 'bin'))).includes('claude.exe')) return 'path';
    return (await listDir(path.join(winHome, 'AppData', 'Roaming', 'npm'))).includes('claude.cmd') ? 'path' : null;
  }
  // The PowerShell line that registers the shared server with Windows Claude Code through its own CLI (the
  // desktop app's newest bundled claude.exe when that is the one installed), replacing a wrong entry first.
  function windowsClaudeFix(cli: 'desktop' | 'path' | null, registered: boolean): StudioMemoryAgentFix {
    const desktop = cli === 'desktop';
    const run = desktop ? '& $claude' : 'claude';
    const steps = [registered ? `${run} mcp remove ${SERVER_NAME} -s user` : null, `${run} mcp add -s user -t http ${SERVER_NAME} ${deps.url}`].filter(Boolean);
    return {
      where: cli ? '在 Windows PowerShell 运行' : '先在 Windows 安装 Claude Code 命令行，再在 PowerShell 运行',
      command: `${desktop ? `${WINDOWS_DESKTOP_CLAUDE}; ` : ''}${steps.join('; ')}`,
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
      // A model may only replace its own notes: a prompt-injected conversation must not rewrite what Claude Code,
      // Codex or the owner recorded. Untagged notes (written by hand) count as someone else's.
      if (input.overwrite) {
        const existing = await noteTitled(input.folder, title, signal);
        const owner = existing ? (await read(existing.id, signal)).source : input.source;
        if (owner !== input.source) {
          fail(`同名笔记是${owner ? ` ${WRITERS[owner]} ` : '别人'}记下的，${WRITERS[input.source]} 不能覆盖它；请换个标题另写一条。`, 409, 'MEMORY_NOTE_PROTECTED');
        }
      }
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
      let slow = false;
      let project: string | null = null;
      let notesPath: string | null = null;
      // Reachability is a protocol ping, which the server answers without touching its index; the project details
      // come from a tool call that may be slow right after a long idle, so missing details never mean "down".
      try {
        await client.ping({ timeoutMs: 4000 });
        reachable = true;
      } catch (error) {
        // Connected but no answer in time: busy or still starting, which the card tells apart from a stopped server.
        slow = error instanceof AppError && error.code === 'MEMORY_TIMEOUT';
      }
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

      const probes: AgentProbe[] = [
        { id: 'claude-wsl', kind: 'claude', home, windows: false },
        { id: 'codex-wsl', kind: 'codex', home, windows: false },
        ...(windowsHome ? [
          { id: 'claude-windows', kind: 'claude', home: windowsHome, windows: true },
          { id: 'codex-windows', kind: 'codex', home: windowsHome, windows: true },
        ] satisfies AgentProbe[] : []),
      ];
      return {
        reachable, slow, url: deps.url, project, notesPath,
        agents: await Promise.all(probes.map(agentStatus)),
        deepseek: { enabled: deps.deepseekEnabled },
      };
    },
  };
}
