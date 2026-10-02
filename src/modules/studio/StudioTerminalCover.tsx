import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';

import type { HubProject, StudioRemoteLaunch } from '@/shared/types';
import { StandaloneShell } from '@/modules/standalone-shell';

type TerminalCoverProps = { onClose: () => void } & (
  // A remote agent session: the server-built `ssh … tmux new-session -A …` command on the project's host.
  | { mode: 'remote'; launch: StudioRemoteLaunch; hostLabel: string }
  // The owner's own interactive shell on this computer, started in the project directory.
  | { mode: 'local'; project: HubProject }
);

/**
 * Used by StudioProjectAgents (lazy-loaded, so xterm stays out of the home screen bundle) to show a terminal full
 * screen. Remote: closing the cover only detaches, the agent keeps running in tmux on the remote host and reopening
 * reattaches to it. Local: a login shell in the project directory where the owner can run anything, sudo included
 * (the password is typed into the terminal itself); the server keeps it alive for 30 minutes after the cover closes,
 * so reopening returns to the same shell.
 */
export default function StudioTerminalCover(props: TerminalCoverProps) {
  const view = props.mode === 'remote'
    ? {
      label: props.launch.title, heading: props.launch.title, caption: `${props.hostLabel} · SSH`, command: props.launch.command,
      // Remote sessions have no local directory; their PTY starts in the server's working directory.
      projectId: `remote:${props.launch.title}`, displayName: props.launch.title, directory: '',
    }
    : {
      label: `${props.project.name} 终端`, heading: '终端', caption: `本机 · ${props.project.name}`,
      // No command: the server starts an interactive login shell instead of running one.
      command: null,
      projectId: props.project.id, displayName: props.project.name, directory: props.project.workspacePath,
    };
  // The shell takes a project shape; memoised because a new object makes it reconnect.
  const shellProject = useMemo(
    () => ({ projectId: view.projectId, displayName: view.displayName, fullPath: view.directory, path: view.directory }),
    [view.projectId, view.displayName, view.directory],
  );

  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape' && event.target === event.currentTarget) props.onClose(); }}>
    <div className="studio-cover terminal-cover" role="dialog" aria-modal="true" aria-label={view.label}>
      <header>
        <button type="button" className="navbar-back ios-press" onClick={props.onClose}><ChevronDown size={22} aria-hidden="true" />完成</button>
        <strong>{view.heading}</strong>
        <span>{view.caption}</span>
      </header>
      <div className="terminal-cover-body">
        <StandaloneShell project={shellProject} command={view.command} isPlainShell minimal />
      </div>
    </div>
  </div>, document.body);
}
