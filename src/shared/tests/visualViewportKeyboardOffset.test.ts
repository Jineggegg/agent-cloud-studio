import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { useVisualViewportKeyboardOffset } from '@/shared/hooks/useVisualViewportKeyboardOffset';

// A stand-in for Safari's window.visualViewport: the visible part of the page and how far it is panned.
type FakeViewport = EventTarget & { height: number; offsetTop: number; scale: number };
let viewport: FakeViewport;
const root = () => document.documentElement.style;

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
});
afterEach(() => {
  Reflect.deleteProperty(window, 'visualViewport');
});

const move = (next: Partial<Pick<FakeViewport, 'height' | 'offsetTop' | 'scale'>>, event: 'resize' | 'scroll' = 'resize') => act(() => {
  Object.assign(viewport, next);
  viewport.dispatchEvent(new Event(event));
});

test('publishes the keyboard below the visible area and the pan above it, and clears both on unmount', () => {
  const { unmount } = renderHook(() => useVisualViewportKeyboardOffset());
  expect(root().getPropertyValue('--keyboard-height')).toBe('0px');
  expect(root().getPropertyValue('--viewport-offset-top')).toBe('0px');

  move({ height: window.innerHeight - 300 });
  expect(root().getPropertyValue('--keyboard-height')).toBe('300px');

  // Safari pans the page to the focused field: the shell moves down by the pan, the keyboard part shrinks by it.
  move({ offsetTop: 60 }, 'scroll');
  expect(root().getPropertyValue('--viewport-offset-top')).toBe('60px');
  expect(root().getPropertyValue('--keyboard-height')).toBe('240px');

  move({ height: window.innerHeight, offsetTop: 0 });
  expect(root().getPropertyValue('--keyboard-height')).toBe('0px');

  unmount();
  expect(root().getPropertyValue('--keyboard-height')).toBe('');
  expect(root().getPropertyValue('--viewport-offset-top')).toBe('');
});

test('a pinch-zoomed viewport is not mistaken for a keyboard', () => {
  renderHook(() => useVisualViewportKeyboardOffset());
  move({ height: window.innerHeight / 2, offsetTop: 120, scale: 2 });
  expect(root().getPropertyValue('--keyboard-height')).toBe('0px');
  expect(root().getPropertyValue('--viewport-offset-top')).toBe('0px');
});
