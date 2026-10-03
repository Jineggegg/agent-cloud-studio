import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { HubProject, Project, WorkbenchHubLink, WorkbenchProjectEntry } from '@/shared/types';

type IdeProjectRow = { projectId?: unknown; displayName?: unknown; fullPath?: unknown; path?: unknown; isStarred?: unknown };

// Directory spellings differ (trailing slash, Windows separators); compare them in one form.
function normalizeDirectory(value: string) {
  const unified = value.trim().replace(/\\/g, '/');
  return unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
}

function toProject(row: IdeProjectRow): Project | null {
  if (typeof row.projectId !== 'string' || !row.projectId || typeof row.fullPath !== 'string') return null;
  const displayName = typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName : row.fullPath.split('/').filter(Boolean).pop() ?? row.fullPath;
  return {
    projectId: row.projectId,
    displayName,
    fullPath: row.fullPath,
    path: typeof row.path === 'string' ? row.path : row.fullPath,
    isStarred: row.isStarred === true,
  };
}

/**
 * Pairs IDE projects with Studio hub projects. The server's hub links (realpath-resolved) win; when they are
 * unavailable the directories are compared as text. Starred projects lead, otherwise the server's order stays.
 */
export function matchHubProjects(projects: Project[], hubs: HubProject[], links: WorkbenchHubLink[] | null): WorkbenchProjectEntry[] {
  const hubById = new Map(hubs.map(hub => [hub.id, hub]));
  const hubByProjectId = new Map<string, HubProject>();
  for (const link of links ?? []) {
    const hub = hubById.get(link.hubId);
    if (hub && link.projectId && !hubByProjectId.has(link.projectId)) hubByProjectId.set(link.projectId, hub);
  }
  const hubByDirectory = new Map<string, HubProject>();
  for (const hub of hubs) {
    if (hub.remoteHost || !hub.workspacePath) continue;
    const directory = normalizeDirectory(hub.workspacePath);
    if (!hubByDirectory.has(directory)) hubByDirectory.set(directory, hub);
  }
  const entries = projects.map(project => ({
    project,
    hub: hubByProjectId.get(project.projectId) ?? (links ? null : hubByDirectory.get(normalizeDirectory(project.fullPath)) ?? null),
  }));
  return [...entries.filter(entry => entry.project.isStarred), ...entries.filter(entry => !entry.project.isStarred)];
}

/**
 * Used by the workbench shell: the IDE projects (GET /api/projects) for the switcher, each with its hub project, and
 * archiving (undoable with restore) or deleting one, which drops it from the list at once and then re-reads it.
 */
export function useWorkbenchProjects() {
  // Projects with their hub match; null until the first load finishes so the switcher can show a skeleton.
  const [entries, setEntries] = useState<WorkbenchProjectEntry[] | null>(null);
  // Why the list could not be loaded, shown with a retry instead of an empty workbench.
  const [error, setError] = useState('');
  // Project objects handed out so far: an unchanged project keeps its identity, so the chat never remounts on a refresh.
  const known = useRef(new Map<string, Project>());
  // The newest read: an older one that lands last (the re-read after an archive, then an undo's) is dropped.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const requested = ++generation.current;
    try {
      const [response, hubs, links] = await Promise.all([
        api.projects(),
        api.studio.projects.list().then(readApiJson<HubProject[]>).catch(() => [] as HubProject[]),
        api.studio.workbench.hubLinks().then(readApiJson<WorkbenchHubLink[]>).catch(() => null),
      ]);
      if (!response.ok) throw new Error(`项目列表加载失败（${response.status}）`);
      const rows = await response.json() as unknown;
      if (requested !== generation.current) return;
      const projects = (Array.isArray(rows) ? rows as IdeProjectRow[] : []).flatMap(row => {
        const next = toProject(row);
        if (!next) return [];
        const previous = known.current.get(next.projectId);
        const stable = previous && previous.fullPath === next.fullPath && previous.displayName === next.displayName && previous.isStarred === next.isStarred
          ? previous : next;
        known.current.set(stable.projectId, stable);
        return [stable];
      });
      setEntries(matchHubProjects(projects, Array.isArray(hubs) ? hubs : [], Array.isArray(links) ? links : null));
      setError('');
    } catch (failure) {
      if (requested !== generation.current) return;
      setError(failure instanceof Error ? failure.message : '项目列表加载失败');
      setEntries(previous => previous ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const drop = useCallback((projectId: string) => {
    setEntries(previous => previous?.filter(entry => entry.project.projectId !== projectId) ?? previous);
    void load();
  }, [load]);

  // Archiving only hides the project (DELETE without force marks it archived); restore brings it back.
  const archive = useCallback(async (projectId: string) => {
    await api.deleteProject(projectId).then(readApiJson);
    drop(projectId);
  }, [drop]);

  const restore = useCallback(async (projectId: string) => {
    await api.restoreProject(projectId).then(readApiJson);
    await load();
  }, [load]);

  // Deleting removes the project and its session records (the agents' transcript files); the folder on disk stays.
  const remove = useCallback(async (projectId: string) => {
    await api.deleteProject(projectId, true).then(readApiJson);
    drop(projectId);
  }, [drop]);

  return { entries, error, refresh: load, archive, restore, remove };
}
