import type { CSSProperties } from 'react';
import { Sparkles } from 'lucide-react';

import { providerMeta } from '@/modules/workbench/utils/workbenchRoutes';

// From this size up the stone is drawn like a home-screen icon, with its full drop shadow.
const LARGE_SIZE = 48;

/**
 * Used across the workbench module — history rows, the new-session menu, the shell's fallback title bar, and the
 * chat column's header, menus, empty state, turn labels and permission sheets — as the one provider badge: a
 * mineral stone like the Studio's app icons, lettered for the agents and drawn with the DeepSeek app's sparkle.
 * `size` is the side in px; a running session's stone breathes.
 */
export function WorkbenchProviderMark({ provider, size = 24, running = false }: { provider: string; size?: number; running?: boolean }) {
  const meta = providerMeta(provider);
  return <span className={`wb-mark home-icon tone-${meta.tone}${size >= LARGE_SIZE ? ' is-large' : ''}`}
    style={{ '--icon': `${size}px` } as CSSProperties} data-running={running ? 'true' : undefined} aria-hidden="true">
    {meta.mark || <Sparkles size={Math.round(size * 0.56)} strokeWidth={size >= LARGE_SIZE ? 1.7 : 2} />}
  </span>;
}
