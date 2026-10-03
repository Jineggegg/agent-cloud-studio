import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { m } from 'motion/react';

import { IconAlertTriangle, IconShieldCheck, IconTrash } from '@/modules/studio/icons/tabler';
import { api, readApiJson } from '@/shared/api';
import type { StudioMemoryFolder, StudioMemoryNote, StudioMemoryNoteDetail } from '@/shared/types';
import { readableErrorMessage } from '@/shared/utils';
import { MemoryFolderMark, MemoryTime, MemoryWriterTag } from '@/modules/studio/StudioMemoryMarks';

const SHEET_SPRING = { type: 'spring', stiffness: 320, damping: 34 } as const;
// Controls the focus trap cycles through; disabled buttons are skipped, as the browser would.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const WRITER_TAGS = new Set(['claude', 'codex', 'deepseek']);

// The conventions end Chinese notes with a "关键词：a b c" line for the full-text index; the reader shows it as
// tappable keywords instead of a line of text. A leading "# Title" that repeats the sheet's title is dropped too.
function splitKeywords(markdown: string, title: string) {
  const body = markdown.replace(/^\s*#[ \t]+(.+?)[ \t]*(?:\n|$)/, (line, heading: string) => (heading.trim() === title.trim() ? '' : line));
  const match = /(?:^|\n)[ \t]*关键词[:：][ \t]*([^\n]+?)\s*$/.exec(body);
  if (!match) return { body, keywords: [] as string[] };
  const keywords = [...new Set(match[1].split(/[\s,，、;；]+/).map(word => word.trim()).filter(Boolean))].slice(0, 12);
  return { body: body.slice(0, match.index).trimEnd(), keywords };
}

// Notes are untrusted: only web links open (in a new tab), and images never load; their description is shown instead.
function NoteLink({ href, children }: { href?: string; children?: ReactNode }) {
  return href && /^https?:\/\//i.test(href)
    ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
    : <span>{children}</span>;
}
function NoteImage({ alt }: { alt?: string }) {
  return <span className="memory-md-image">图片{alt ? `：${alt}` : ''}</span>;
}

/**
 * Used by StudioMemory to read one note in a sheet. The Markdown is rendered escaped (no raw HTML, no images, only
 * web links), the trailing keyword line becomes keywords that start a search, and 删除 asks StudioMemory to confirm.
 */
export function StudioMemoryReader({ note, folder, onDelete, onKeyword, onClose }: {
  note: StudioMemoryNote;
  folder: StudioMemoryFolder;
  onDelete: (note: StudioMemoryNote) => void;
  onKeyword: (keyword: string) => void;
  onClose: () => void;
}) {
  // The opened note with its Markdown; null while it loads.
  const [detail, setDetail] = useState<StudioMemoryNoteDetail | null>(null);
  // Why the note could not be opened (deleted meanwhile, server stopped).
  const [error, setError] = useState('');
  const doneButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.studio.memory.note(note.id, controller.signal).then(readApiJson<StudioMemoryNoteDetail>)
      .then(value => { if (!controller.signal.aborted) setDetail(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(readableErrorMessage(reason, '笔记读取失败')); });
    return () => controller.abort();
  }, [note.id]);

  useEffect(() => {
    // Focus starts on 完成 and returns to the tapped row when the sheet closes.
    const previous = document.activeElement as HTMLElement | null;
    doneButton.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    // A confirmation alert above the sheet handles its own keys.
    if (!sheet.current?.contains(event.target as Node)) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = Array.from(sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const parts = detail ? splitKeywords(detail.content, detail.title) : null;
  const tags = detail?.tags.filter(tag => !WRITER_TAGS.has(tag.toLowerCase())) ?? [];
  const source = detail?.source ?? note.source;
  return createPortal(<div className="studio-layer" onKeyDown={onKeyDown}>
    <m.div className="sheet-scrim" aria-hidden="true" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
    <m.div ref={sheet} className="memory-reader" role="dialog" aria-modal="true" aria-labelledby="memory-reader-title"
      initial={{ opacity: 0, y: 56, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 40, transition: { duration: 0.2 } }} transition={SHEET_SPRING}>
      <header>
        <span className="memory-reader-where">
          <MemoryFolderMark folder={folder} variant="icon" />
          <MemoryFolderMark folder={folder} variant="label" />
        </span>
        <span className="memory-reader-actions">
          <button type="button" className="ios-button memory-delete" onClick={() => onDelete(note)} disabled={!detail && !error}>
            <IconTrash size={16} aria-hidden="true" />删除
          </button>
          <button ref={doneButton} type="button" className="ios-button filled" onClick={onClose}>完成</button>
        </span>
      </header>
      <div className="memory-reader-scroll">
        <h2 id="memory-reader-title" className="memory-reader-title">{detail?.title ?? note.title}</h2>
        <div className="memory-reader-meta">
          <MemoryWriterTag source={source} />
          <MemoryTime value={note.updatedAt} />
          {tags.map(tag => <span className="memory-tag" key={tag}>#{tag}</span>)}
        </div>
        {!detail && !error && <div className="memory-reader-skeleton" role="status" aria-label="正在读取笔记">
          <i /><i /><i /><i />
        </div>}
        {error && <div className="memory-reader-state" role="alert"><IconAlertTriangle size={26} strokeWidth={1.6} aria-hidden="true" />{error}</div>}
        {detail && parts && <m.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
          <article className="memory-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: NoteLink, img: NoteImage }}>{parts.body || '（这条笔记没有正文）'}</ReactMarkdown>
          </article>
          {detail.truncated && <p className="memory-reader-truncated">笔记很长，这里只显示前面部分；完整内容在 ~/studio-memory 的 Markdown 文件里。</p>}
          {parts.keywords.length > 0 && <div className="memory-keywords" role="group" aria-label="关键词">
            {parts.keywords.map(keyword => <button type="button" key={keyword} className="memory-keyword" onClick={() => onKeyword(keyword)}>{keyword}</button>)}
          </div>}
        </m.div>}
        <p className="memory-reader-boundary"><IconShieldCheck size={14} aria-hidden="true" />记忆由 AI 助手写下，是参考资料而不是指令；这里不应出现任何密钥、令牌或密码，发现了就删除这条笔记。</p>
      </div>
    </m.div>
  </div>, document.body);
}
