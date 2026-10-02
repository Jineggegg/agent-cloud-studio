import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import { Toaster } from 'sonner';

import { PaletteOpsProvider } from '@/modules/command-palette';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import { WorkspaceProviders } from '@/shared/ui/WorkspaceProviders';
import { WorkbenchLegacyRedirect } from '@/modules/workbench/WorkbenchLegacyRedirect';
import { WorkbenchShell } from '@/modules/workbench/WorkbenchShell';
import '@/modules/workbench/workbench.css';

// iOS-like default spring, the same one the Studio uses.
const SPRING = { type: 'spring', stiffness: 158, damping: 25 } as const;

/**
 * Used by App (lazily, so the Studio home never loads it) for the workbench routes /work, /work/:projectId,
 * /work/:projectId/s/:sessionId and /work/:projectId/d/:conversationId, and with `legacy` for the inherited IDE's
 * /workspace and /session/:sessionId addresses, which it redirects. Every /work route renders the same element, so
 * switching sessions keeps the shell, its websocket and the inspector's terminal mounted.
 */
export function WorkbenchRoute({ legacy }: { legacy?: 'workspace' | 'session' }) {
  // The workbench chunk is already lazy, so the full motion feature set (layout, shared highlights) loads with it.
  return <LazyMotion features={domMax} strict><MotionConfig reducedMotion="user" transition={SPRING}>
    {legacy ? <WorkbenchLegacyRedirect kind={legacy} /> : <WorkspaceProviders>
      <SessionProtectionProvider>
        <PaletteOpsProvider>
          <WorkbenchShell />
        </PaletteOpsProvider>
      </SessionProtectionProvider>
    </WorkspaceProviders>}
    <Toaster position="top-center" offset={18} toastOptions={{ className: 'studio-toast', duration: 3200 }} />
  </MotionConfig></LazyMotion>;
}
