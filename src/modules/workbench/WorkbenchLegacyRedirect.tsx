import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MessageSquareOff } from 'lucide-react';

import { StudioSpinner } from '@/modules/studio';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider } from '@/shared/types';
import { parseNewProvider, resolveLegacySessionPath, workbenchPath } from '@/modules/workbench/utils/workbenchRoutes';

// Agents the old /workspace deep link could name; the workbench starts a new chat with any of them.
const LEGACY_AGENTS: readonly string[] = ['claude', 'codex', 'cursor', 'opencode'];

/**
 * Used by WorkbenchRoute for the inherited IDE's addresses: `/workspace?projectId=&provider=` becomes
 * `/work/:projectId?new=provider`, `/workspace` becomes `/work`, and `/session/:sessionId` is resolved to its project
 * and opened at `/work/:projectId/s/:sessionId`. A session the server no longer knows gets an honest message.
 */
export function WorkbenchLegacyRedirect({ kind }: { kind: 'workspace' | 'session' }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { sessionId } = useParams<{ sessionId?: string }>();
  // The old session link could not be resolved to a project.
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (kind === 'workspace') {
      const projectId = searchParams.get('projectId');
      const requested = searchParams.get('provider');
      // The chat engine reads the agent from this shared preference when a new chat mounts.
      if (requested && LEGACY_AGENTS.includes(requested)) writeSelectedProvider(requested as LLMProvider);
      navigate(projectId ? workbenchPath(projectId, null, parseNewProvider(requested)) : '/work', { replace: true });
      return undefined;
    }
    let alive = true;
    if (!sessionId) { navigate('/work', { replace: true }); return undefined; }
    void resolveLegacySessionPath(sessionId).then(path => {
      if (!alive) return;
      if (path) navigate(path, { replace: true }); else setMissing(true);
    });
    return () => { alive = false; };
  }, [kind, searchParams, sessionId, navigate]);

  return <div className="studio workbench is-redirect">
    {missing
      ? <div className="wb-stage-empty" role="alert">
        <MessageSquareOff size={34} strokeWidth={1.4} aria-hidden="true" />
        <h2>找不到这个会话</h2>
        <p>它可能已被删除，或这个链接来自另一台电脑。</p>
        <div className="wb-stage-actions"><Link to="/work" replace className="ios-button tinted">打开工作台</Link></div>
      </div>
      : <div className="wb-stage-empty"><StudioSpinner size={24} label="正在打开工作台" /></div>}
  </div>;
}
