import type { WorkbenchSessionGroup, WorkbenchSessionItem, WorkbenchThread } from '@/shared/types';

// Display order and headings of the history buckets.
const GROUP_LABELS: Record<WorkbenchSessionGroup['id'], string> = {
  today: '今天', yesterday: '昨天', week: '本周', earlier: '更早',
};
const GROUP_ORDER: WorkbenchSessionGroup['id'][] = ['today', 'yesterday', 'week', 'earlier'];
const DAY_MS = 86_400_000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// Local midnight of the given instant; buckets follow the device's calendar, not 24-hour windows.
function startOfDay(time: number) {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function timestamp(item: WorkbenchSessionItem) {
  const parsed = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function bucketOf(time: number, today: number): WorkbenchSessionGroup['id'] {
  if (!Number.isFinite(time)) return 'earlier';
  if (time >= today) return 'today';
  if (time >= today - DAY_MS) return 'yesterday';
  // "本周" means the seven calendar days up to today, so a Monday never empties the bucket.
  if (time >= today - 6 * DAY_MS) return 'week';
  return 'earlier';
}

/** Newest first; rows without a usable time sink to the end in a stable order. */
export function sortSessionsByRecency(items: WorkbenchSessionItem[]): WorkbenchSessionItem[] {
  return [...items].sort((left, right) => {
    const a = timestamp(left);
    const b = timestamp(right);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
    if (!Number.isFinite(a)) return 1;
    if (!Number.isFinite(b)) return -1;
    return b - a;
  });
}

/**
 * Folds every conversation handed between providers into one row: the thread's title, its latest session's id and
 * provider (so the row opens and marks the session that continues it), the newest time of any of its sessions, and
 * running while any of them runs. The row carries the thread. A thread none of whose sessions are loaded (an older
 * page, or all deleted) adds nothing. Rows of other sessions pass through; the result is newest first.
 */
export function collapseThreads(items: WorkbenchSessionItem[], threads: WorkbenchThread[]): WorkbenchSessionItem[] {
  if (!threads.length) return items;
  const owner = new Map<string, WorkbenchThread>();
  for (const thread of threads) for (const segment of thread.segments) owner.set(`${segment.kind}:${segment.sessionId}`, thread);
  const rowsOf = new Map<string, WorkbenchSessionItem[]>();
  const rows: WorkbenchSessionItem[] = [];
  for (const item of items) {
    const thread = owner.get(`${item.kind}:${item.id}`);
    if (thread) rowsOf.set(thread.id, [...(rowsOf.get(thread.id) ?? []), item]);
    else rows.push(item);
  }
  for (const thread of threads) {
    const members = rowsOf.get(thread.id);
    const latest = thread.segments[thread.segments.length - 1];
    if (!members?.length || !latest) continue;
    const times = [...members.map(timestamp), Date.parse(thread.updatedAt)].filter(Number.isFinite);
    rows.push({
      id: latest.sessionId,
      kind: latest.kind,
      provider: latest.provider,
      title: thread.title,
      updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      running: members.some(member => member.running) || undefined,
      thread,
    });
  }
  return sortSessionsByRecency(rows);
}

/** Splits the history into 今天 / 昨天 / 本周 / 更早 (local calendar days), dropping empty buckets. */
export function groupSessionsByDay(items: WorkbenchSessionItem[], now: Date = new Date()): WorkbenchSessionGroup[] {
  const today = startOfDay(now.getTime());
  const buckets = new Map<WorkbenchSessionGroup['id'], WorkbenchSessionItem[]>();
  for (const item of sortSessionsByRecency(items)) {
    const id = bucketOf(timestamp(item), today);
    buckets.set(id, [...(buckets.get(id) ?? []), item]);
  }
  return GROUP_ORDER.filter(id => buckets.has(id)).map(id => ({ id, label: GROUP_LABELS[id], items: buckets.get(id) ?? [] }));
}

/** Rows whose title contains every word of the query (case-insensitive); an empty query keeps everything. */
export function filterSessions(items: WorkbenchSessionItem[], query: string): WorkbenchSessionItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter(item => {
    const title = item.title.toLocaleLowerCase();
    return words.every(word => title.includes(word));
  });
}

/** The row's time label: clock time today and yesterday, the weekday this week, a date before that. */
export function formatSessionTime(updatedAt: string | null, now: Date = new Date()): string {
  const time = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const today = startOfDay(now.getTime());
  const bucket = bucketOf(time, today);
  if (bucket === 'today' || bucket === 'yesterday') {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  if (bucket === 'week') return WEEKDAYS[date.getDay()];
  return date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月`;
}
