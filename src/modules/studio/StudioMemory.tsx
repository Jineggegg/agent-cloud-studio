import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { toast } from 'sonner';
import { AlertTriangle, BookOpen, Check, ChevronRight, Search, SearchX, ServerOff, Sparkles, X } from 'lucide-react';

import type { StudioMemoryFolder, StudioMemoryNote, StudioMemoryStatus } from '@/shared/types';
import { readableErrorMessage } from '@/shared/utils';
import { useStudioMemory } from '@/modules/studio/hooks/useStudioMemory';
import { StudioConfirmSheet } from '@/modules/studio/StudioConfirmSheet';
import { MemoryFolderMark, MemoryTime, MemoryWriterTag } from '@/modules/studio/StudioMemoryMarks';
import { StudioMemoryReader } from '@/modules/studio/StudioMemoryReader';
import { StudioSpinner } from '@/modules/studio/StudioSpinner';
import '@/modules/studio/studio-memory.css';

const ROW_EXIT = { opacity: 0, height: 0, transition: { duration: 0.24, ease: [0.22, 0.8, 0.2, 1] } } as const;

// Marks the query's words inside a snippet; plain text in, React nodes out (never HTML).
function highlight(text: string, query: string): ReactNode {
  const words = [...new Set(query.split(/\s+/).filter(word => word.length > 0))].sort((a, b) => b.length - a.length);
  if (!words.length || !text) return text;
  const pattern = new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(pattern).map((part, index) => (index % 2 === 1 ? <mark key={index} className="memory-mark">{part}</mark> : part));
}

function folderOf(folders: StudioMemoryFolder[], name: string): StudioMemoryFolder {
  return folders.find(folder => folder.name === name) ?? { name, project: null };
}

type Agent = { id: string; name: string; tone: string; mark: ReactNode; ok: boolean; detail: string };
function agentsOf(status: StudioMemoryStatus): Agent[] {
  const { claude, codex, deepseek } = status.clients;
  const wired = (client: { registered: boolean; transport: string | null; conventions: boolean }) => {
    if (!client.registered) return { ok: false, detail: '未注册，运行安装脚本' };
    if (!client.conventions) return { ok: false, detail: '已注册，使用约定未写入' };
    return { ok: true, detail: client.transport === 'stdio' ? '已接入 · 本地进程' : '已接入 · 共享服务' };
  };
  return [
    { id: 'claude', name: 'Claude Code', tone: 'clay', mark: 'C', ...wired(claude) },
    { id: 'codex', name: 'Codex', tone: 'graphite', mark: 'O', ...wired(codex) },
    {
      id: 'deepseek', name: 'Studio DeepSeek', tone: 'slate', mark: <Sparkles size={16} strokeWidth={1.8} />,
      ok: deepseek.enabled && status.reachable,
      detail: !deepseek.enabled ? '已关闭（STUDIO_MEMORY_DEEPSEEK）' : status.reachable ? '回复前查阅记忆' : '等待记忆服务',
    },
  ];
}

function MemoryStatusCard({ status, statusError, total }: { status: StudioMemoryStatus | null; statusError: string; total: number | null }) {
  if (!status) {
    return statusError
      ? <div className="memory-card memory-status"><p className="memory-status-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{statusError}</p></div>
      : <div className="memory-card memory-status" role="status" aria-label="正在读取记忆状态"><div className="memory-status-skeleton"><i /><i /><i /></div></div>;
  }
  return <section className="memory-card memory-status" aria-labelledby="memory-status-title">
    <div className="memory-server">
      <span className={`status-dot ${status.reachable ? 'good' : 'bad'}`} aria-hidden="true" />
      <div>
        <h2 id="memory-status-title">{status.reachable ? '记忆库在线' : '记忆服务未运行'}</h2>
        <p>{status.reachable
          ? [status.notesPath, total !== null ? `${total} 条笔记` : null].filter(Boolean).join(' · ')
          : '启动后三个助手才能读写记忆'}</p>
      </div>
    </div>
    <ul className="memory-agents" aria-label="接入的助手">
      {agentsOf(status).map(agent => <li key={agent.id} className={agent.ok ? 'ok' : 'warn'}>
        <span className={`home-icon small tone-${agent.tone} memory-agent-mark`} aria-hidden="true">{agent.mark}</span>
        <span className="memory-agent-body"><strong>{agent.name}</strong><small>{agent.detail}</small></span>
        {agent.ok ? <Check size={17} className="memory-agent-state" aria-label="正常" /> : <AlertTriangle size={16} className="memory-agent-state" aria-label="需要处理" />}
      </li>)}
    </ul>
  </section>;
}

function MemoryGuide() {
  return <section className="memory-guide" aria-labelledby="memory-guide-title">
    <h2 id="memory-guide-title">它怎么工作</h2>
    <ul>
      <li>Claude Code 和 Codex 开工前先在这里搜索，把项目事实、决定和你的偏好记成笔记。</li>
      <li>Studio 里的 DeepSeek 回复前会查阅本项目和全局的笔记，也能自己记下要点。</li>
      <li>笔记是 <code>~/studio-memory</code> 里的 Markdown 文件，按项目分文件夹，跨项目的放在 global，可以直接编辑。</li>
      <li>不要让任何助手记下密钥、令牌或密码；看到不对的记忆，打开后删除。</li>
    </ul>
    <p>修复或重新接入：在 WSL 里运行 <code>bash scripts/wsl/install-memory.sh</code>，说明见 docs/memory.md。</p>
  </section>;
}

/**
 * Used by StudioPage for the 记忆 system app: the shared memory that Claude Code, Codex and Studio's DeepSeek read
 * and write through basic-memory. Search, newest notes by folder, a Markdown reader with delete, whether each
 * agent is wired up, and a short explanation. `refreshing` is StudioPage's header refresh (the app bar's only
 * refresh button): each time it starts, the memory is read again too.
 */
export function StudioMemory({ refreshing = false }: { refreshing?: boolean }) {
  const memory = useStudioMemory();
  // The header refresh flag seen by the previous render; a change to true (a new header refresh) reads everything
  // again. Compared during render, React's pattern for reacting to a prop change without an effect.
  const [seenRefreshing, setSeenRefreshing] = useState(refreshing);
  if (refreshing !== seenRefreshing) {
    setSeenRefreshing(refreshing);
    if (refreshing) memory.refresh();
  }
  // The note open in the reader sheet; null while the sheet is closed.
  const [openNote, setOpenNote] = useState<StudioMemoryNote | null>(null);
  // The note waiting for the delete confirmation; null while no confirmation is showing.
  const [pendingDelete, setPendingDelete] = useState<StudioMemoryNote | null>(null);

  const folders = useMemo(() => {
    const list = memory.recent?.folders ?? [];
    // A selected folder keeps its chip even after its last note is deleted.
    return memory.folder && !list.some(item => item.name === memory.folder) ? [...list, { name: memory.folder, project: null }] : list;
  }, [memory.recent?.folders, memory.folder]);
  const notes = memory.searching ? memory.results : memory.recent?.notes ?? null;
  const loading = notes === null;
  const trimmed = memory.query.trim();

  const confirmDelete = async (note: StudioMemoryNote) => {
    setPendingDelete(null);
    try {
      await memory.remove(note);
      setOpenNote(null);
      toast(`已删除「${note.title}」`);
    } catch (reason) {
      toast.error(readableErrorMessage(reason, '删除失败'));
    }
  };

  const header = memory.searching
    ? { title: '搜索结果', caption: memory.searchPending && !memory.results ? '' : `${notes?.length ?? 0} 条` }
    : { title: '最近更新', caption: memory.recent ? `共 ${memory.recent.total} 条` : '' };

  return <div className="memory-app">
    <div className="memory-main">
      <div className="memory-toolbar">
        <label className="ios-search memory-search">
          <Search size={17} aria-hidden="true" />
          <span className="studio-visually-hidden">搜索记忆</span>
          <input type="search" value={memory.query} placeholder="搜索决定、偏好和项目事实" enterKeyHint="search" autoComplete="off"
            onChange={event => memory.setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape' && memory.query) { event.preventDefault(); memory.setQuery(''); } }} />
          {memory.searchPending && <StudioSpinner size={15} />}
          {memory.query && <button type="button" className="memory-search-clear" aria-label="清除搜索" onClick={() => memory.setQuery('')}><X size={14} strokeWidth={2.4} aria-hidden="true" /></button>}
        </label>
      </div>

      {folders.length > 1 && <div className="memory-folders" role="group" aria-label="按文件夹筛选">
        <button type="button" className="memory-chip" aria-pressed={memory.folder === undefined} onClick={() => memory.setFolder(undefined)}>全部</button>
        {folders.map(folder => <button type="button" key={folder.name} className="memory-chip" aria-pressed={memory.folder === folder.name}
          onClick={() => memory.setFolder(memory.folder === folder.name ? undefined : folder.name)}>
          <MemoryFolderMark folder={folder} variant="label" />
        </button>)}
      </div>}

      <div className="ios-section-header memory-list-header">
        <h2>{header.title}</h2>
        <span className="caption" aria-live="polite">{header.caption}</span>
      </div>

      {memory.error && !loading && notes.length > 0 && <p className="memory-notice" role="alert">
        <AlertTriangle size={15} aria-hidden="true" />{memory.error.offline ? '记忆服务暂时不可用，显示的是上次读取的笔记。' : memory.error.message}
      </p>}

      {loading && <div className="memory-list memory-list-skeleton" role="status" aria-label="正在读取笔记">
        {[0, 1, 2, 3].map(index => <div key={index} className="memory-skeleton-row"><i /><div><i /><i /></div></div>)}
      </div>}

      {!loading && notes.length === 0 && (memory.error
        ? <div className="ios-empty memory-empty" role="alert">
          {memory.error.offline ? <ServerOff size={32} strokeWidth={1.5} aria-hidden="true" /> : <AlertTriangle size={30} strokeWidth={1.5} aria-hidden="true" />}
          <strong>{memory.error.offline ? '记忆服务未运行' : memory.error.message}</strong>
          {memory.error.offline && <span>在 WSL 里运行 <code>systemctl --user start studio-memory</code>，或重新执行安装脚本。</span>}
          <button type="button" className="ios-button tinted" onClick={() => void memory.refresh()}>重试</button>
        </div>
        : memory.searching
          ? !memory.searchPending && <div className="ios-empty memory-empty">
            <SearchX size={30} strokeWidth={1.5} aria-hidden="true" />
            <strong>没有找到「{trimmed}」</strong>
            <span>中文按词检索，试试更短的词，比如「部署」或「端口」。</span>
          </div>
          : <div className="ios-empty memory-empty">
            <BookOpen size={32} strokeWidth={1.5} aria-hidden="true" />
            <strong>{memory.folder ? '这个文件夹还没有笔记' : '还没有记忆'}</strong>
            <span>在 Claude Code、Codex 或 DeepSeek 里说出值得长期记住的决定和偏好，它们会记在这里。</span>
          </div>)}

      {!loading && notes.length > 0 && <ul className={`memory-list ${memory.searchPending ? 'is-stale' : ''}`}>
        <AnimatePresence initial={false}>
          {notes.map(note => {
            const folder = folderOf(folders, note.folder);
            return <m.li key={note.id} className="memory-item" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={ROW_EXIT}>
              <button type="button" className="memory-row" onClick={() => setOpenNote(note)}>
                <MemoryFolderMark folder={folder} variant="icon" />
                <span className="memory-row-body">
                  <span className="memory-row-top">
                    <strong>{note.title}</strong>
                    <MemoryWriterTag source={note.source} />
                  </span>
                  <small><MemoryFolderMark folder={folder} variant="label" />{note.updatedAt && <> · <MemoryTime value={note.updatedAt} /></>}</small>
                  {memory.searching && note.snippet && <span className="memory-snippet">{highlight(note.snippet, trimmed)}</span>}
                </span>
                <ChevronRight size={18} className="chevron" aria-hidden="true" />
              </button>
            </m.li>;
          })}
        </AnimatePresence>
      </ul>}
    </div>

    <aside className="memory-aside">
      <MemoryStatusCard status={memory.status} statusError={memory.statusError} total={memory.folder ? null : memory.recent?.total ?? null} />
      <MemoryGuide />
    </aside>

    <AnimatePresence>
      {openNote && <StudioMemoryReader key={openNote.id} note={openNote} folder={folderOf(folders, openNote.folder)}
        onClose={() => setOpenNote(null)}
        onDelete={setPendingDelete}
        onKeyword={keyword => { setOpenNote(null); memory.setQuery(keyword); }} />}
    </AnimatePresence>

    {pendingDelete && <StudioConfirmSheet title="删除这条记忆？"
      message={`「${pendingDelete.title}」会从 ~/studio-memory 删除，Claude Code、Codex 和 DeepSeek 以后都看不到它。此操作无法撤销。`}
      confirmLabel="删除" onCancel={() => setPendingDelete(null)} onConfirm={() => void confirmDelete(pendingDelete)} />}
  </div>;
}
