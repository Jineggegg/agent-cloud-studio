import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';

import { WorkspaceProjectIntent } from '@/modules/project-workspace/controllers/WorkspaceProjectIntent';

const state = vi.hoisted(() => ({
  projects: [] as { projectId: string; displayName: string }[],
  newSession: vi.fn(),
  provider: vi.fn(),
}));
vi.mock('@/shared/selectedProvider', () => ({ writeSelectedProvider: state.provider }));
vi.mock('@/modules/project-workspace/context/ProjectsStateContext', () => ({
  useProjectSidebarState: () => ({ sidebarSharedProps: { projects: state.projects } }),
  useProjectCommandState: () => ({ handleNewSession: state.newSession }),
}));
beforeEach(() => { state.projects = []; vi.clearAllMocks(); });

it('waits for native projects, selects the requested provider and project exactly once', () => {
  const ui = <MemoryRouter initialEntries={['/workspace?projectId=professor&provider=codex']}><WorkspaceProjectIntent /></MemoryRouter>;
  const rendered = render(ui);
  expect(state.newSession).not.toHaveBeenCalled();
  const project = { projectId: 'professor', displayName: '超级教授' };
  state.projects = [project];
  act(() => rendered.rerender(<MemoryRouter initialEntries={['/workspace?projectId=professor&provider=codex']}><WorkspaceProjectIntent /></MemoryRouter>));
  expect(state.provider).toHaveBeenCalledWith('codex');
  expect(state.newSession).toHaveBeenCalledWith(project);
  act(() => rendered.rerender(<MemoryRouter initialEntries={['/workspace?projectId=professor&provider=codex']}><WorkspaceProjectIntent /></MemoryRouter>));
  expect(state.newSession).toHaveBeenCalledTimes(1);
});

it('ignores unknown providers instead of switching a native session', () => {
  state.projects = [{ projectId: 'professor', displayName: '超级教授' }];
  render(<MemoryRouter initialEntries={['/workspace?projectId=professor&provider=untrusted']}><WorkspaceProjectIntent /></MemoryRouter>);
  expect(state.provider).not.toHaveBeenCalled();
  expect(state.newSession).not.toHaveBeenCalled();
});
