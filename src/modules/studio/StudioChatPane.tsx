import { useState } from 'react';

import { IconMessages, IconSearch, IconTrash } from '@/modules/studio/icons/tabler';
import type { StudioConversation, StudioGlyph } from '@/shared/types';
import type { useStudio } from '@/modules/studio/hooks/useStudio';
import { StudioChat } from '@/modules/studio/StudioChat';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

function formatDay(value: string) {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** Used by StudioPage for the DeepSeek app and every project's DeepSeek tab: conversation list plus thread. */
export function StudioChatPane({ studio, assistant, tone, glyph, title, onOpenThread, onDelete }: {
  studio: ReturnType<typeof useStudio>; assistant: string; tone: string; glyph: StudioGlyph | 'sparkles'; title: string;
  onOpenThread: () => void; onDelete: (conversation: StudioConversation) => void;
}) {
  // History filtering is local and never changes saved conversation titles.
  const [search, setSearch] = useState('');
  const history = studio.history.filter(item => item.title.toLowerCase().includes(search.toLowerCase()));
  const open = async (id?: string) => {
    if (studio.sending) return;
    if (id) await studio.select(id); else studio.startNew();
    onOpenThread();
  };
  return <div className="studio-chat-layout">
    <aside className="studio-chat-list" aria-label="对话列表">
      <div className="chat-list-search">
        <label className="ios-search"><IconSearch size={17} aria-hidden="true" />
          <input type="search" aria-label="搜索对话" placeholder="搜索" value={search} onChange={event => setSearch(event.target.value)} />
        </label>
      </div>
      <div className="chat-list-scroll">
        {history.length > 0 && <div className="chat-list-group studio-stagger">
          {history.map(item => <div className={`chat-list-item ${studio.active?.id === item.id ? 'selected' : ''}`} key={item.id}>
            <button type="button" className="ios-row" disabled={studio.sending} aria-current={studio.active?.id === item.id ? 'true' : undefined} onClick={() => void open(item.id)}>
              <StudioTileIcon tone={tone} glyph={glyph} size={16} variant="small" />
              <span className="ios-row-body"><strong>{item.title}</strong><small>{item.model}</small></span>
              <time dateTime={item.updated_at}>{formatDay(item.updated_at)}</time>
            </button>
            <button type="button" className="icon-button" title="删除对话" aria-label={`删除 ${item.title}`} disabled={studio.sending} onClick={() => onDelete(item)}><IconTrash size={17} aria-hidden="true" /></button>
          </div>)}
        </div>}
        {!history.length && <div className="ios-empty"><IconMessages size={30} strokeWidth={1.5} aria-hidden="true" /><span>{search ? '没有匹配的对话' : `${title} 还没有对话`}</span>
          {!search && <button type="button" className="ios-button tinted" onClick={() => void open()}>新建对话</button>}</div>}
      </div>
    </aside>
    <StudioChat assistant={assistant} tone={tone} active={studio.active} models={studio.status?.deepseek.models ?? ['deepseek-flash', 'deepseek-v4-pro']} sending={studio.sending} onSend={studio.send} onStop={studio.stop} />
  </div>;
}
