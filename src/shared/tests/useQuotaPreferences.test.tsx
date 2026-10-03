import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useQuotaPreferences } from '@/shared/hooks/useQuotaPreferences';

const STORAGE_KEY = 'studio-quota-display-v1';

beforeEach(() => localStorage.removeItem(STORAGE_KEY));

test('with nothing saved figures read as 剩余 and no item has a choice; unreadable storage falls back to that', () => {
  const { result, rerender } = renderHook(() => useQuotaPreferences());
  expect(result.current.preferences).toEqual({ mode: 'remaining', items: {} });

  localStorage.setItem(STORAGE_KEY, '{not json');
  rerender();
  expect(result.current.preferences).toEqual({ mode: 'remaining', items: {} });

  // Only boolean choices survive; an unknown mode is the default.
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'sideways', items: { a: true, b: 'yes', c: false }, extra: 1 }));
  rerender();
  expect(result.current.preferences).toEqual({ mode: 'remaining', items: { a: true, c: false } });
});

test('a choice is saved on this device and every consumer on the page updates at once', () => {
  const home = renderHook(() => useQuotaPreferences());
  const workbench = renderHook(() => useQuotaPreferences());
  act(() => home.result.current.setMode('used'));
  act(() => home.result.current.setItemShown('claude:window:five_hour', false));
  act(() => home.result.current.setItemShown('claude:credit:cinder_cove', true));

  const expected = { mode: 'used', items: { 'claude:window:five_hour': false, 'claude:credit:cinder_cove': true } };
  expect(workbench.result.current.preferences).toEqual(expected);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(expected);
  // A fresh mount (the next visit) reads it back.
  expect(renderHook(() => useQuotaPreferences()).result.current.preferences).toEqual(expected);
});

test('a change made in another tab is picked up', () => {
  const { result } = renderHook(() => useQuotaPreferences());
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'used', items: { 'deepseek:balance': false } }));
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })); });
  expect(result.current.preferences).toEqual({ mode: 'used', items: { 'deepseek:balance': false } });
});

test('when storage refuses the write the choice still holds for this visit', () => {
  const { result } = renderHook(() => useQuotaPreferences());
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  act(() => result.current.setMode('used'));
  expect(result.current.preferences.mode).toBe('used');
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  refuse.mockRestore();
  // Once storage works again the next choice is saved, and it is what is read.
  act(() => result.current.setItemShown('deepseek:balance', false));
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ mode: 'used', items: { 'deepseek:balance': false } });
  expect(result.current.preferences).toEqual({ mode: 'used', items: { 'deepseek:balance': false } });
});
