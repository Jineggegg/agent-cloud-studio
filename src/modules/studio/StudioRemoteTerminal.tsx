import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';

import type { StudioRemoteLaunch } from '@/shared/types';
import { StandaloneShell } from '@/modules/standalone-shell';

/**
 * Used by StudioProjectAgents (lazy-loaded, so xterm stays out of the home screen bundle) to show a remote
 * agent session full screen. The command is the server-built `ssh … tmux new-session -A …`, so closing the
 * cover only detaches: the agent keeps running on the remote host and reopening reattaches to it.
 */
export default function StudioRemoteTerminal({ launch, hostLabel, onClose }: { launch: StudioRemoteLaunch; hostLabel: string; onClose: () => void }) {
  // The shell needs a project shape; remote sessions have no local directory, so the PTY starts in the home folder.
  const project = useMemo(() => ({ projectId: `remote:${launch.title}`, displayName: launch.title, fullPath: '', path: '' }), [launch.title]);
  return createPortal(<div className="studio-layer" onKeyDown={event => { if (event.key === 'Escape' && event.target === event.currentTarget) onClose(); }}>
    <div className="studio-cover terminal-cover" role="dialog" aria-modal="true" aria-label={launch.title}>
      <header>
        <button type="button" className="navbar-back ios-press" onClick={onClose}><ChevronDown size={22} aria-hidden="true" />完成</button>
        <strong>{launch.title}</strong>
        <span>{hostLabel} · SSH</span>
      </header>
      <div className="terminal-cover-body">
        <StandaloneShell project={project} command={launch.command} isPlainShell minimal />
      </div>
    </div>
  </div>, document.body);
}
