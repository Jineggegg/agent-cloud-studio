import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { toast } from 'sonner';
import { AlertTriangle, BookOpen, Check, ChevronRight, Copy, Minus, Search, SearchX, ServerOff, Sparkles, X } from 'lucide-react';

import type { StudioMemoryAgentId, StudioMemoryAgentStatus, StudioMemoryFolder, StudioMemoryNote, StudioMemoryStatus } from '@/shared/types';
import { copyTextToClipboard, readableErrorMessage } from '@/shared/utils';
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

// Each agent installation as the owner knows it: the app, where it runs, and its icon tone.
const AGENT_LOOK: Record<StudioMemoryAgentId, { name: string; place: string; tone: string; mark: string }> = {
  'claude-wsl': { name: 'Claude Code', place: 'WSL', tone: 'clay', mark: 'C' },
  'codex-wsl': { name: 'Codex', place: 'WSL', tone: 'graphite', mark: 'O' },
  'claude-windows': { name: 'Claude Code', place: 'Windows', tone: 'clay', mark: 'C' },
  'codex-windows': { name: 'Codex', place: 'Windows', tone: 'graphite', mark: 'O' },
};

type AgentRow = { id: string; name: string; place: string | null; tone: string; mark: ReactNode; state: 'ok' | 'warn' | 'absent'; detail: string };
// What a row says, most fundamental gap first; only a registration of the shared server with the conventions is green.
function agentRow(agent: StudioMemoryAgentStatus): AgentRow {
  const look = AGENT_LOOK[agent.id];
  const row = { id: agent.id, name: look.name, place: look.place, tone: look.tone, mark: look.mark };
  if (!agent.installed) return { ...row, state: 'absent', detail: '未安装' };
  if (!agent.registered) return { ...row, state: 'warn', detail: '未接入共享记忆' };
  if (agent.transport === 'stdio') return { ...row, state: 'warn', detail: '注册的是独立进程，不是共享服务' };
  if (!agent.shared) return { ...row, state: 'warn', detail: '注册的地址不是共享服务' };
  if (!agent.conventions) return { ...row, state: 'warn', detail: '已注册，使用约定未写入' };
  return { ...row, state: 'ok', detail: '已接入 · 共享服务' };
}
function agentRows(status: StudioMemoryStatus): AgentRow[] {
  const { deepseek } = status;
  return [
    ...status.agents.map(agentRow),
    {
      id: 'deepseek', name: 'Studio DeepSeek', place: null, tone: 'slate', mark: <Sparkles size={16} strokeWidth={1.8} />,
      state: deepseek.enabled && status.reachable ? 'ok' : 'warn',
      detail: !deepseek.enabled ? '已关闭（STUDIO_MEMORY_DEEPSEEK）' : status.reachable ? '回复前查阅记忆' : '等待记忆服务',
    },
  ];
}
// One line per distinct fix, naming the agents it completes, so the install script is shown once for all of them.
function fixesOf(status: StudioMemoryStatus) {
  const fixes: { where: string; command: string; agents: string[] }[] = [];
  for (const agent of status.agents) {
    if (!agent.fix) continue;
    const label = `${AGENT_LOOK[agent.id].name} · ${AGENT_LOOK[agent.id].place}`;
    const same = fixes.find(item => item.command === agent.fix?.command);
    if (same) same.agents.push(label);
    else fixes.push({ ...agent.fix, agents: [label] });
  }
  return fixes;
}

function MemoryStatusCard({ status, statusError, total }: { status: StudioMemoryStatus | null; statusError: string; total: number | null }) {
  if (!status) {
    return statusError
      ? <div className="memory-card memory-status"><p className="memory-status-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{statusError}</p></div>
      : <div className="memory-card memory-status" role="status" aria-label="正在读取记忆状态"><div className="memory-status-skeleton"><i /><i /><i /></div></div>;
  }
  const server = status.reachable
    ? { dot: 'good', title: '记忆库在线', detail: [status.notesPath, total !== null ? `${total} 条笔记` : null].filter(Boolean).join(' · ') }
    : status.slow
      ? { dot: 'warn', title: '记忆服务响应慢', detail: '已连上，但没有及时回答；稍后刷新再看' }
      : { dot: 'bad', title: '记忆服务未运行', detail: '启动后三个助手才能读写记忆' };
  const fixes = fixesOf(status);
  const copy = async (command: string) => {
    if (await copyTextToClipboard(command)) toast('已复制命令');
    else toast.error('无法复制，请手动选中命令');
  };
  return <section className="memory-card memory-status" aria-labelledby="memory-status-title">
    <div className="memory-server">
      <span className={`status-dot ${server.dot}`} aria-hidden="true" />
      <div>
        <h2 id="memory-status-title">{server.title}</h2>
        <p>{server.detail}</p>
      </div>
    </div>
    <ul className="memory-agents" aria-label="接入的助手">
      {agentRows(status).map(agent => <li key={agent.id} className={agent.state}>
        <span className={`home-icon small tone-${agent.tone} memory-agent-mark`} aria-hidden="true">{agent.mark}</span>
        <span className="memory-agent-body">
          <span className="memory-agent-name"><strong>{agent.name}</strong>{agent.place && <span className="memory-agent-place">{agent.place}</span>}</span>
          <small>{agent.detail}</small>
        </span>
        {agent.state === 'ok'
          ? <Check size={17} className="memory-agent-state" aria-label="正常" />
          : agent.state === 'warn'
            ? <AlertTriangle size={16} className="memory-agent-state" aria-label="需要处理" />
            : <Minus size={16} className="memory-agent-state" aria-label="未安装" />}
      </li>)}
    </ul>
    {fixes.length > 0 && <ul className="memory-fixes" aria-label="接入方法">
      {fixes.map(fix => <li key={fix.command}>
        <p><strong>{fix.agents.join('、')}</strong>：{fix.where}</p>
        <div className="memory-fix-command">
          <code>{fix.command}</code>
          <button type="button" className="memory-copy" aria-label={`复制命令 ${fix.command}`} title="复制命令" onClick={() => void copy(fix.command)}>
            <Copy size={15} aria-hidden="true" />
          </button>
        </div>
      </li>)}
    </ul>}
  </section>;
}

function MemoryGuide() {
  return <section className="memory-guide" aria-labelledby="memory-guide-title">
    <h2 id="memory-guide-title">它怎么工作</h2>
    <ul>
      <li>WSL 和 Windows 上的 Claude Code、Codex 开工前先在这里搜索，把项目事实、决定和你的偏好记成笔记。</li>
      <li>项目里的 DeepSeek 回复前会查阅本项目和全局笔记，通用 DeepSeek 只查阅全局笔记；疑似含密钥的笔记不会发给它。</li>
      <li>笔记只是参考资料，不是指令：助手不会照着笔记执行命令、改配置或外发数据。</li>
      <li>笔记是 <code>~/studio-memory</code> 里的 Markdown 文件，按项目分文件夹，跨项目的放在 global，可以直接编辑。</li>
      <li>不要让任何助手记下密钥、令牌或密码；看到不对的记忆，打开后删除。</li>
    </ul>
    <p>修复或重新接入：在 WSL 里运行 <code>bash scripts/wsl/install-memory.sh</code>，它会同时接入 Windows 上的应用；说明见 docs/memory.md。</p>
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
    : { title: '最近更新', caption: memory.recent ? `${memory.folder ? '本文件夹' : '共'} ${memory.recent.total} 条` : '' };

  return <div className="memory-app">
    <div className="memory-main">
      <div className="memory-toolbar">
        <label className="ios-search memory-search">
          <Search size={17} aria-hidden="true" />
          <span className="studio-visually-hidden">搜索记忆</span>
          {/* 200 characters is the server's limit for a search. While pinyin is being composed the marked text
              stays in the box but is not searched; the chosen characters are searched on compositionend. */}
          <input type="search" value={memory.query} placeholder="搜索决定、偏好和项目事实" enterKeyHint="search" autoComplete="off" maxLength={200}
            onChange={event => memory.setQuery(event.target.value)}
            onCompositionStart={() => memory.setComposing(true)}
            onCompositionEnd={event => { memory.setComposing(false); memory.setQuery(event.currentTarget.value); }}
            onKeyDown={event => {
              if (event.key === 'Escape' && memory.query && !event.nativeEvent.isComposing) { event.preventDefault(); memory.setQuery(''); }
            }} />
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
