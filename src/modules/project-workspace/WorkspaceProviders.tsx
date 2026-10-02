import type { ReactNode } from 'react';

import { PluginsProvider } from '@/modules/plugins';
import { TaskMasterProvider, TasksSettingsProvider } from '@/modules/task-master';
import { WebSocketProvider } from '@/shared/context/WebSocketContext';

/**
 * Used by this module's ProjectWorkspaceRoute to mount the IDE-wide providers (chat websocket,
 * plugins, TaskMaster) inside the lazily loaded IDE chunk. They used to wrap the whole app in
 * App.tsx, which pulled the editor, terminal and chat code into the Studio home screen's entry
 * bundle and opened a websocket plus three status requests the Studio never used.
 */
export function WorkspaceProviders({ children }: { children: ReactNode }) {
  return (
    <WebSocketProvider>
      <PluginsProvider>
        <TasksSettingsProvider>
          <TaskMasterProvider>{children}</TaskMasterProvider>
        </TasksSettingsProvider>
      </PluginsProvider>
    </WebSocketProvider>
  );
}
