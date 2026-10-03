import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { useNotificationNavigation } from '@/shared/hooks/useNotificationNavigation';

// jsdom has no service worker container; a plain EventTarget stands in for navigator.serviceWorker.
let container: EventTarget;
const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

beforeEach(() => {
  container = new EventTarget();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
});

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

function Probe() {
  useNotificationNavigation();
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

function post(data: unknown) {
  act(() => { container.dispatchEvent(new MessageEvent('message', { data })); });
}

test('a tapped notification opens its page in the open window, through the router', () => {
  render(<MemoryRouter initialEntries={['/']}><Probe /></MemoryRouter>);
  const location = screen.getByLabelText('location');

  post({ type: 'notification:navigate', url: '/projects/prof?tab=automations' });
  expect(location.textContent).toBe('/projects/prof?tab=automations');

  post({ type: 'notification:navigate', url: '/work/p1/s/s1', sessionId: 's1' });
  expect(location.textContent).toBe('/work/p1/s/s1');

  // A message from a worker that predates `url` still opens its session.
  post({ type: 'notification:navigate', sessionId: 'abc' });
  expect(location.textContent).toBe('/session/abc');
});

test('foreign URLs open the home screen, and other messages are ignored', () => {
  render(<MemoryRouter initialEntries={['/work/p1']}><Probe /></MemoryRouter>);
  const location = screen.getByLabelText('location');

  post({ type: 'something-else', url: '/projects/x' });
  expect(location.textContent).toBe('/work/p1');

  post({ type: 'notification:navigate', url: 'https://evil.example/phish' });
  expect(location.textContent).toBe('/');

  post({ type: 'notification:navigate', url: '/projects/a' });
  post({ type: 'notification:navigate', url: '//evil.example' });
  expect(location.textContent).toBe('/');
});
