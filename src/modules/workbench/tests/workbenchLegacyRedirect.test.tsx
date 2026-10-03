import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Type-only, so it is erased before vi.mock's hoisted factory runs.
import type * as SharedApi from '@/shared/api';

const mocks = vi.hoisted(() => ({ sessionDetails: vi.fn(), writeSelectedProvider: vi.fn() }));
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

vi.mock('@/shared/api', async original => ({
  ...(await original<typeof SharedApi>()),
  api: { sessionDetails: (id: string) => mocks.sessionDetails(id), studio: {} },
}));
vi.mock('@/shared/selectedProvider', () => ({ writeSelectedProvider: mocks.writeSelectedProvider }));
vi.mock('@/modules/studio', () => ({ StudioSpinner: ({ label }: { label?: string }) => <span role="status">{label}</span> }));

const { WorkbenchLegacyRedirect } = await import('@/modules/workbench/WorkbenchLegacyRedirect');

function Location() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderAt(path: string) {
  render(<MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/workspace" element={<WorkbenchLegacyRedirect kind="workspace" />} />
      <Route path="/session/:sessionId" element={<WorkbenchLegacyRedirect kind="session" />} />
      <Route path="/work/*" element={<div>workbench</div>} />
    </Routes>
    <Location />
  </MemoryRouter>);
}
const location = () => screen.getByTestId('location').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionDetails.mockImplementation((id: string) => (id === 'native-id' || id === 'app-id'
    ? json({ success: true, data: { sessionId: 'app-id', provider: 'claude', summary: '修复登录', project: { projectId: 'p1' } } })
    : json({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'not found' } }, 404)));
});
afterEach(cleanup);

test('/workspace with a project and provider opens a new workbench chat with that agent', async () => {
  renderAt('/workspace?projectId=p1&provider=codex');
  await waitFor(() => expect(location()).toBe('/work/p1?new=codex'));
  expect(mocks.writeSelectedProvider).toHaveBeenCalledWith('codex');
});

test('/workspace alone opens the workbench; Cursor and OpenCode links keep their agent, anything else is dropped', async () => {
  renderAt('/workspace');
  await waitFor(() => expect(location()).toBe('/work'));
  cleanup();
  renderAt('/workspace?projectId=p1&provider=cursor');
  await waitFor(() => expect(location()).toBe('/work/p1?new=cursor'));
  expect(mocks.writeSelectedProvider).toHaveBeenCalledWith('cursor');
  cleanup();
  renderAt('/workspace?projectId=p1&provider=opencode');
  await waitFor(() => expect(location()).toBe('/work/p1?new=opencode'));
  cleanup();
  mocks.writeSelectedProvider.mockClear();
  renderAt('/workspace?projectId=p1&provider=rm%20-rf');
  await waitFor(() => expect(location()).toBe('/work/p1'));
  expect(mocks.writeSelectedProvider).not.toHaveBeenCalled();
});

test('/session/:id resolves the session to its project, preferring the canonical app id', async () => {
  renderAt('/session/native-id');
  await waitFor(() => expect(location()).toBe('/work/p1/s/app-id'));
  expect(mocks.sessionDetails).toHaveBeenCalledWith('native-id');
});

test('an unknown session explains itself instead of redirecting silently', async () => {
  renderAt('/session/ghost');
  expect(await screen.findByRole('heading', { name: '找不到这个会话' })).toBeTruthy();
  expect(location()).toBe('/session/ghost');
  expect(screen.getByRole('link', { name: '打开工作台' }).getAttribute('href')).toBe('/work');
});
