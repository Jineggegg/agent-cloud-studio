import type { ReactNode } from 'react';

import { PluginsProvider } from '@/modules/plugins';
import { TaskMasterProvider, TasksSettingsProvider } from '@/modules/task-master';
import { WebSocketProvider } from '@/shared/context/WebSocketContext';

/**
 * Used by the workbench module (WorkbenchRoute) and by the project-workspace module's legacy
 * ProjectWorkspaceRoute to mount the chat-wide providers (chat websocket, plugins, TaskMaster) inside
 * their lazily loaded chunks. They used to wrap the whole app in App.tsx, which pulled the editor,
 * terminal and chat code into the Studio home screen's entry bundle and opened a websocket plus three
 * status requests the Studio never used.
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
