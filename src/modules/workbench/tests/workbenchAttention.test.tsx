import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { ServerEvent } from '@/shared/types';

// The busy set and the websocket are the hook's only inputs; both are driven by hand here.
const fakes = vi.hoisted(() => ({
  busy: new Set<string>() as ReadonlySet<string>,
  listeners: [] as ((event: ServerEvent) => void)[],
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({ useBusySessionIdSet: () => fakes.busy }));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribe: (listener: (event: ServerEvent) => void) => {
      fakes.listeners.push(listener);
      return () => { fakes.listeners = fakes.listeners.filter(item => item !== listener); };
    },
  }),
}));

const { useWorkbenchAttention } = await import('@/modules/workbench/hooks/useWorkbenchAttention');

const STORAGE_KEY = 'acs-workbench-attention-v1';
const emit = (event: ServerEvent) => act(() => fakes.listeners.forEach(listener => listener(event)));
const renderAttention = (viewed: string[]) => renderHook(({ ids }) => useWorkbenchAttention(ids), { initialProps: { ids: viewed } });
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;

beforeEach(() => {
  localStorage.clear();
  fakes.busy = new Set();
  fakes.listeners = [];
});

test('a run that ends while another session is open needs attention; the open session does not', () => {
  fakes.busy = new Set(['open', 'elsewhere', 'still-running']);
  const { result, rerender } = renderAttention(['open']);
  expect([...result.current]).toEqual([]);

  fakes.busy = new Set(['still-running']);
  rerender({ ids: ['open'] });
  expect([...result.current]).toEqual(['elsewhere']);
  expect(stored()).toEqual(['elsewhere']);
});

test('a permission request needs an answer unless its session is open; opening clears it, and the dots survive a reload', () => {
  const first = renderAttention(['open']);
  emit({ kind: 'permission_request', sessionId: 'asking', requestId: 'r1' });
  emit({ kind: 'permission_request', sessionId: 'open', requestId: 'r2' });
  // Other frames are not a reason to look.
  emit({ kind: 'status', sessionId: 'chatty' });
  expect([...first.result.current]).toEqual(['asking']);
  first.unmount();

  // A reload (a fresh mount) keeps the dot.
  const second = renderAttention([]);
  expect([...second.result.current]).toEqual(['asking']);
  // Opening a handed-over conversation clears every stretch of it.
  second.rerender({ ids: ['earlier-stretch', 'asking'] });
  expect([...second.result.current]).toEqual([]);
  expect(stored()).toEqual([]);
  // Leaving it again does not bring the dot back.
  second.rerender({ ids: [] });
  expect([...second.result.current]).toEqual([]);
});

test('unreadable or unavailable storage only costs the memory, never the dots', () => {
  localStorage.setItem(STORAGE_KEY, '{not json');
  const { result } = renderAttention([]);
  expect([...result.current]).toEqual([]);

  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  emit({ kind: 'permission_request', sessionId: 'asking', requestId: 'r1' });
  expect([...result.current]).toEqual(['asking']);
});
