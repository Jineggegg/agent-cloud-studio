import type { StudioMemoryFolder, StudioMemorySource } from '@/shared/types';
import { StudioTileIcon } from '@/modules/studio/StudioTileIcon';

// The same names and icon tones the agents page uses for these agents.
const WRITERS: Record<StudioMemorySource, string> = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };

/** Used by StudioMemory and StudioMemoryReader: the tinted tag naming the agent that wrote a note. */
export function MemoryWriterTag({ source }: { source: StudioMemorySource | null }) {
  if (!source) return null;
  return <span className={`memory-writer writer-${source}`}>{WRITERS[source]}</span>;
}

/**
 * Used by StudioMemory and StudioMemoryReader to show a memory folder the way the owner knows it: a hub project's
 * own icon and name, 全局 for `global`, and the bare folder name otherwise. `icon` draws only the icon.
 */
export function MemoryFolderMark({ folder, variant }: { folder: StudioMemoryFolder; variant: 'icon' | 'label' }) {
  const isGlobal = folder.name === 'global';
  const label = folder.project?.name ?? (isGlobal ? '全局' : folder.name || '未归档');
  if (variant === 'label') return <span className="memory-folder-label">{label}</span>;
  return <StudioTileIcon tone={folder.project?.tone ?? 'stone'} glyph={folder.project?.glyph ?? (isGlobal ? 'globe' : 'folder')} size={17} variant="small" />;
}

// "刚刚", "12 分钟前", "今天 14:05", "昨天 09:30", "10月2日", "2025年3月1日".
function relative(value: string, now: Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return `今天 ${time}`;
  if (date.getTime() >= startOfToday - 86_400_000) return `昨天 ${time}`;
  return date.toLocaleDateString('zh-CN', { year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
}

/** Used by StudioMemory and StudioMemoryReader for a note's last update, relative to now. */
export function MemoryTime({ value }: { value: string | null }) {
  const text = value ? relative(value, new Date()) : '';
  return text ? <time dateTime={value ?? undefined}>{text}</time> : null;
}
