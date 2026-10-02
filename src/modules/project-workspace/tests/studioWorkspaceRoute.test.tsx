import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@/modules/command-palette', () => ({ PaletteOpsProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({ ProjectsStateProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  SessionProtectionProvider: ({ children }: { children: ReactNode }) => children,
  useSessionProtectionActions: () => ({ isSessionProcessing: () => false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ ws: null, sendMessage: vi.fn(), subscribe: vi.fn() }) }));
vi.mock('@/shared/hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isMobile: false }) }));
vi.mock('@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset', () => ({ useVisualViewportKeyboardOffset: () => {} }));
vi.mock('@/modules/project-workspace/controllers/WorkspaceProjectIntent', () => ({ WorkspaceProjectIntent: () => null }));
// The IDE-wide providers (websocket, plugins, TaskMaster) moved from App into this lazily loaded route.
vi.mock('@/shared/ui/WorkspaceProviders', () => ({
  WorkspaceProviders: ({ children }: { children: ReactNode }) => <section aria-label="IDE providers">{children}</section>,
}));
vi.mock('@/modules/project-workspace/ProjectWorkspaceShell', () => ({
  default: ({ navigate }: { navigate: NavigateFunction }) => <div>IDE<button onClick={() => navigate('/')}>Clear session</button>
    <button onClick={() => navigate('/session/other')}>Open session</button></div>,
}));
const { default: ProjectWorkspaceRoute } = await import('@/modules/project-workspace/ProjectWorkspaceRoute');
afterEach(cleanup);

for (const initial of ['/legacy/workspace', '/legacy/session/example']) {
  test(`clearing or opening a session from ${initial} stays inside the hidden legacy IDE`, () => {
    render(<MemoryRouter initialEntries={[initial]}><Routes>
      <Route path="/" element={<div>Studio home</div>} />
      <Route path="/session/:sessionId" element={<div>Workbench redirect</div>} />
      <Route path="/legacy/workspace" element={<ProjectWorkspaceRoute />} />
      <Route path="/legacy/session/:sessionId" element={<ProjectWorkspaceRoute />} />
    </Routes></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Clear session' }));
    expect(screen.queryByText('Studio home')).toBeNull();
    expect(screen.getByText('IDE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    expect(screen.queryByText('Workbench redirect')).toBeNull();
    expect(screen.getByText('IDE')).toBeTruthy();
  });
}

test('the IDE renders inside its own websocket, plugin and TaskMaster providers', () => {
  render(<MemoryRouter initialEntries={['/legacy/workspace']}><Routes>
    <Route path="/legacy/workspace" element={<ProjectWorkspaceRoute />} />
  </Routes></MemoryRouter>);
  expect(within(screen.getByRole('region', { name: 'IDE providers' })).getByText('IDE')).toBeTruthy();
});
