import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@/modules/project-workspace/controllers/ProjectEffects', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectSidebarRegion', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectMainRegion', () => ({ default: () => <div>IDE content</div> }));
vi.mock('@/modules/project-workspace/ProjectCommandPalette', () => ({ default: () => null }));
vi.mock('@/modules/project-workspace/ProjectQuickSettingsRegion', () => ({ default: () => null }));

const { default: ProjectWorkspaceShell } = await import('@/modules/project-workspace/ProjectWorkspaceShell');
afterEach(cleanup);

test('the inherited IDE has an explicit return link to Studio', () => {
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Routes>
        <Route path="/" element={<div>Studio home</div>} />
        <Route path="/workspace" element={
          <ProjectWorkspaceShell isMobile ws={null} sendMessage={vi.fn()} navigate={vi.fn()} />
        } />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByText('IDE content')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: '返回 Studio' }));
  expect(screen.getByText('Studio home')).toBeTruthy();
  expect(screen.queryByText('IDE content')).toBeNull();
});
