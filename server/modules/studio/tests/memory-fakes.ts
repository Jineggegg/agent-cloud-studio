import type { StudioMemoryToolCaller } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type FakeNote = { permalink: string; title: string; filePath: string; content: string; tags: string[]; updatedAt: string };
type Call = { name: string; args: Record<string, unknown> };

/**
 * An in-memory stand-in for the shared basic-memory server, used by the memory service, bridge and route tests.
 * It answers the tools Studio calls with the same JSON shapes basic-memory 0.23 returns (observed against the
 * real server), logs every call, and can be switched off to simulate a stopped server. Search is a plain
 * substring match over `term` or `term*` alternatives, enough to check what Studio asks for.
 */
export function createFakeMemory(notes: Array<Partial<FakeNote> & { permalink: string }> = []) {
  const store = new Map<string, FakeNote>();
  for (const [index, note] of notes.entries()) {
    const folder = note.permalink.split('/')[1] ?? '';
    const title = note.title ?? note.permalink.split('/').at(-1) ?? note.permalink;
    store.set(note.permalink, {
      permalink: note.permalink, title, filePath: note.filePath ?? `${folder}/${title}.md`, content: note.content ?? '',
      tags: note.tags ?? [], updatedAt: note.updatedAt ?? `2026-10-0${Math.min(index + 1, 9)}T10:00:00+01:00`,
    });
  }
  const calls: Call[] = [];
  // `slowTools` time out the way a busy server does (the session stays up; ping still answers); `slowPing` makes the
  // ping time out too, like a server that accepts connections but cannot answer yet.
  const state = { down: false, delayMs: 0, slowTools: [] as string[], slowPing: false };

  const row = (note: FakeNote) => ({
    title: note.title, type: 'entity', score: -1, entity: note.permalink, permalink: note.permalink,
    content: note.content, file_path: note.filePath, updated_at: note.updatedAt, metadata: { note_type: 'note' },
  });
  const matches = (note: FakeNote, query: string) => query.split(/\s+OR\s+|\s+AND\s+|\s+/).map(term => term.replace(/\*$/, '').toLowerCase())
    .filter(Boolean).some(term => `${note.title}\n${note.content}`.toLowerCase().includes(term));

  async function call(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
    calls.push({ name, args });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    options?.signal?.throwIfAborted();
    if (state.down) throw new AppError('共享记忆服务未运行或无法连接', { statusCode: 503, code: 'MEMORY_UNAVAILABLE' });
    if (state.slowTools.includes(name)) throw new AppError('共享记忆服务响应超时，请稍后重试', { statusCode: 504, code: 'MEMORY_TIMEOUT' });
    const all = [...store.values()];
    switch (name) {
      case 'search_notes': {
        const tags = Array.isArray(args.tags) ? args.tags as string[] : [];
        const query = typeof args.query === 'string' ? args.query : '';
        const results = all.filter(note => (!tags.length || tags.some(tag => note.tags.includes(tag))) && (!query || matches(note, query)));
        return { results: results.map(row), current_page: 1, page_size: args.page_size ?? 10, total: results.length, has_more: false };
      }
      case 'list_directory': {
        // Like basic-memory 0.23: every node `depth` levels below `dir_name`, flat, directories first; the glob only
        // filters which nodes are returned (directories never match `*.md`); `total` counts them all before paging.
        const dir = String(args.dir_name ?? '/').replace(/^\/+|\/+$/g, '');
        const depth = Number(args.depth ?? 1);
        const glob = typeof args.file_name_glob === 'string' ? args.file_name_glob : null;
        const page = Number(args.page ?? 1);
        const size = Number(args.page_size ?? 10);
        const directories = new Set<string>();
        const files: FakeNote[] = [];
        for (const note of all) {
          if (dir && !note.filePath.startsWith(`${dir}/`)) continue;
          const parts = (dir ? note.filePath.slice(dir.length + 1) : note.filePath).split('/');
          for (let level = 1; level < parts.length && level <= depth; level++) directories.add([dir, ...parts.slice(0, level)].filter(Boolean).join('/'));
          if (parts.length <= depth && (!glob || (glob === '*.md' && note.filePath.endsWith('.md')))) files.push(note);
        }
        if (args.sort === 'updated_desc') files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const nodes = [
          ...(glob ? [] : [...directories].sort().map(directory => ({ name: directory.split('/').at(-1), directory_path: `/${directory}`, type: 'directory', children: [], permalink: null, updated_at: null }))),
          ...files.map(note => ({
            name: note.filePath.split('/').at(-1), file_path: note.filePath, directory_path: `/${note.filePath}`, type: 'file', children: [],
            title: note.title, permalink: note.permalink, content_type: 'text/markdown', updated_at: note.updatedAt,
          })),
        ];
        const start = (page - 1) * size;
        return { nodes: nodes.slice(start, start + size), page, page_size: size, total: nodes.length, has_more: start + size < nodes.length };
      }
      case 'read_note': {
        const identifier = String(args.identifier);
        // Like basic-memory, an unknown permalink falls back to a title match.
        const note = store.get(identifier) ?? all.find(item => item.title === identifier);
        if (!note) return { title: null, permalink: null, file_path: null, content: null, frontmatter: null };
        return {
          title: note.title, permalink: note.permalink, file_path: note.filePath, content: `\n${note.content}`,
          frontmatter: { title: note.title, type: 'note', permalink: note.permalink, tags: note.tags },
        };
      }
      case 'delete_note': {
        const identifier = String(args.identifier);
        const note = store.get(identifier) ?? all.find(item => item.title === identifier);
        if (!note) return { deleted: false, title: null, permalink: null, file_path: null };
        store.delete(note.permalink);
        return { deleted: true, title: note.title, permalink: note.permalink, file_path: note.filePath };
      }
      case 'write_note': {
        const title = String(args.title);
        const folder = String(args.directory);
        // Like basic-memory 0.23 (sanitize_for_filename): the file name, not the title, decides whether the note
        // exists, and an overwrite replaces whatever note lives in that file.
        let name = title;
        for (const [pattern, value] of [[/[/\\]/g, '-'], [/[<>:"|?*]/g, '-'], [/-+/g, '-'], [/^\.+|\.+$/g, ''], [/^-+|-+$/g, '']] as const) name = name.replace(pattern, value);
        const filePath = `${folder}/${name}.md`;
        const existing = all.find(note => note.filePath === filePath);
        if (existing && args.overwrite !== true) {
          return { title, permalink: existing.permalink, file_path: null, action: 'conflict', error: 'NOTE_ALREADY_EXISTS' };
        }
        const permalink = existing?.permalink ?? `studio/${folder}/${name.toLowerCase().replace(/\s+/g, '-')}`;
        store.set(permalink, {
          permalink, title, filePath, content: String(args.content),
          tags: Array.isArray(args.tags) ? args.tags as string[] : [], updatedAt: '2026-10-09T12:00:00+01:00',
        });
        return { title, permalink, file_path: filePath, checksum: null, action: existing ? 'updated' : 'created' };
      }
      case 'list_memory_projects':
        return {
          projects: [{ name: 'main', path: '/home/owner/basic-memory' }, { name: 'studio', path: '/home/owner/studio-memory', is_default: true }],
          default_project: 'studio', constrained_project: 'studio',
        };
      default:
        throw new AppError(`unknown tool ${name}`, { statusCode: 502, code: 'MEMORY_TOOL_ERROR' });
    }
  }

  const client: StudioMemoryToolCaller = {
    call,
    async ping() {
      if (state.down) throw new AppError('共享记忆服务未运行或无法连接', { statusCode: 503, code: 'MEMORY_UNAVAILABLE' });
      if (state.slowPing) throw new AppError('共享记忆服务响应超时，请稍后重试', { statusCode: 504, code: 'MEMORY_TIMEOUT' });
    },
  };
  return { client, store, calls, state, callsNamed: (name: string) => calls.filter(item => item.name === name) };
}
