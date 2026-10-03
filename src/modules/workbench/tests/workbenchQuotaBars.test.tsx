import { cleanup, render, screen } from '@testing-library/react';
import { LazyMotion, domMax } from 'motion/react';
import { afterEach, expect, test, vi } from 'vitest';

// jsdom never upgrades NumberFlow's custom element; this stand-in prints the figure.
vi.mock('@number-flow/react', () => ({
  default: ({ value, suffix = '' }: { value: number; suffix?: string }) => <span>{`${value}${suffix}`}</span>,
}));

import { WorkbenchQuotaBars } from '@/modules/workbench/WorkbenchQuotaBars';
import type { StudioQuotaSnapshot } from '@/shared/types';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const NOTE = 'Claude 用量接口暂时限流，显示 38 分钟前的读数。';
// The last good Claude reading standing in while the usage API is rate limited, flagged as old.
const SNAPSHOTS: StudioQuotaSnapshot[] = [
  {
    provider: 'claude', available: true, balances: [], source: 'usage-api', observedAt: new Date(Date.now() - 38 * 60_000).toISOString(), stale: true, note: NOTE,
    windows: [
      { id: 'five_hour', label: '5 小时', usedPercent: 9, windowMinutes: 300, resetsAt: null },
      { id: 'seven_day', label: '每周', usedPercent: 4, windowMinutes: 10080, resetsAt: null },
    ],
  },
  { provider: 'codex', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '暂无 Codex 用量' },
  { provider: 'deepseek', available: false, windows: [], balances: [], source: 'unavailable', observedAt: null, stale: false, note: '未配置' },
];

test('figures from an earlier read keep their bars, and the stale flag and each line give the reason in their tooltip', () => {
  render(<LazyMotion features={domMax} strict><WorkbenchQuotaBars snapshots={SNAPSHOTS} onOpenSettings={vi.fn()} /></LazyMotion>);
  const lines = screen.getAllByRole('listitem');
  const session = lines.find(line => line.textContent?.includes('Claude 5 小时'));
  expect(session?.textContent).toContain('91%');
  expect(session?.getAttribute('title')).toBe(`Claude 5 小时 剩余 91%（可能过期）\n${NOTE}`);
  expect(screen.getByText('可能过期').getAttribute('title')).toBe(NOTE);
  // Codex reported nothing, so it keeps its own line and no one else's note.
  const codex = lines.find(line => line.textContent?.includes('Codex'));
  expect(codex?.textContent).toContain('未接入');
  expect(codex?.getAttribute('title')).toBeNull();
});
