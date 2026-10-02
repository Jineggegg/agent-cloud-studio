import { expect, test } from 'vitest';

import type { WorkbenchSessionItem } from '@/shared/types';
import { filterSessions, formatSessionTime, groupSessionsByDay, sortSessionsByRecency } from '@/modules/workbench/utils/workbenchSessionGroups';
import { parseNewProvider, toAgentItem, workbenchPath } from '@/modules/workbench/utils/workbenchRoutes';

// Friday 2 October 2026, 15:30 local time.
const NOW = new Date(2026, 9, 2, 15, 30);
const at = (days: number, hours = 12) => new Date(2026, 9, 2 - days, hours, 5).toISOString();
const row = (id: string, title: string, updatedAt: string | null, provider: WorkbenchSessionItem['provider'] = 'claude'): WorkbenchSessionItem => ({
  id, title, updatedAt, provider, kind: provider === 'deepseek' ? 'deepseek' : 'agent',
});

const ROWS = [
  row('old', '整理旧接口', at(30)),
  row('today-late', '修复登录', at(0, 15)),
  row('yesterday', '重构侧栏', at(1, 23)),
  row('week', '写周报', at(6, 9), 'deepseek'),
  row('eight-days', '发布 v5', at(7, 9), 'codex'),
  row('today-early', '晨会记录', at(0, 0)),
  row('undated', '没有时间的会话', null),
];

test('sessions are grouped into 今天 / 昨天 / 本周 / 更早 by local calendar day, newest first', () => {
  const groups = groupSessionsByDay(ROWS, NOW);
  expect(groups.map(group => group.label)).toEqual(['今天', '昨天', '本周', '更早']);
  expect(groups.map(group => group.items.map(item => item.id))).toEqual([
    ['today-late', 'today-early'],
    ['yesterday'],
    ['week'],
    ['eight-days', 'old', 'undated'],
  ]);
});

test('empty buckets are left out', () => {
  expect(groupSessionsByDay([row('a', 'A', at(0)), row('b', 'B', at(40))], NOW).map(group => group.id)).toEqual(['today', 'earlier']);
  expect(groupSessionsByDay([], NOW)).toEqual([]);
});

test('search matches every word of the query in the title, ignoring case and spacing', () => {
  expect(filterSessions(ROWS, '  ').map(item => item.id)).toHaveLength(ROWS.length);
  expect(filterSessions(ROWS, '登录').map(item => item.id)).toEqual(['today-late']);
  expect(filterSessions([row('x', 'Fix Login Bug', at(0))], 'login  FIX').map(item => item.id)).toEqual(['x']);
  expect(filterSessions(ROWS, '不存在')).toEqual([]);
});

test('row times read as a clock today and yesterday, a weekday this week and a date before that', () => {
  expect(formatSessionTime(at(0, 9), NOW)).toBe('09:05');
  expect(formatSessionTime(at(1, 23), NOW)).toBe('23:05');
  expect(formatSessionTime(at(6, 9), NOW)).toBe('周六');
  expect(formatSessionTime(at(30), NOW)).toBe('9月2日');
  expect(formatSessionTime(new Date(2025, 2, 1).toISOString(), NOW)).toBe('2025年3月');
  expect(formatSessionTime(null, NOW)).toBe('');
});

test('rows without a time sort last and the order is otherwise newest first', () => {
  expect(sortSessionsByRecency(ROWS).map(item => item.id)).toEqual(['today-late', 'today-early', 'yesterday', 'week', 'eight-days', 'old', 'undated']);
});

test('route helpers build workbench URLs and accept only workbench providers', () => {
  expect(workbenchPath('p 1')).toBe('/work/p%201');
  expect(workbenchPath('p1', null, 'codex')).toBe('/work/p1?new=codex');
  expect(workbenchPath('p1', { kind: 'agent', id: 's1' })).toBe('/work/p1/s/s1');
  expect(workbenchPath('p1', { kind: 'deepseek', id: 'c1' })).toBe('/work/p1/d/c1');
  expect(parseNewProvider('deepseek')).toBe('deepseek');
  expect(parseNewProvider('cursor')).toBeNull();
  expect(parseNewProvider(null)).toBeNull();
  expect(toAgentItem({ id: 's', provider: 'mystery', summary: '  ' })).toEqual({ id: 's', kind: 'agent', provider: 'claude', title: '新会话', updatedAt: null });
});
