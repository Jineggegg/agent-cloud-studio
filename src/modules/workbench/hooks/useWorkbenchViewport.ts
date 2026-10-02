import { useEffect, useState } from 'react';

import type { WorkbenchViewport } from '@/shared/types';

// Same breakpoints as the Studio (studio.css): phones below 700px, iPad portrait below 1024px.
function classify(width: number): WorkbenchViewport {
  if (width < 700) return 'phone';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

/** Used by the workbench shell to pick sheets (phone), an overlay inspector (tablet) or docked columns (desktop). */
export function useWorkbenchViewport(): WorkbenchViewport {
  // Re-evaluated on resize and rotation; only a class change re-renders the shell.
  const [viewport, setViewport] = useState<WorkbenchViewport>(() => classify(window.innerWidth));
  useEffect(() => {
    const update = () => setViewport(classify(window.innerWidth));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return viewport;
}
