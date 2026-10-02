import { MessagesSquare } from 'lucide-react';

import type { WorkbenchSessionItem } from '@/shared/types';
import { providerMeta } from '@/modules/workbench/utils/workbenchRoutes';

/**
 * Used across the workbench module (history rows, new-session menu, title bar) as the provider badge: a small
 * mineral stone like the Studio's app icons, lettered for agents and drawn for DeepSeek. A running session's
 * stone breathes.
 */
export function WorkbenchProviderMark({ provider, running = false, size = 'row' }: {
  provider: WorkbenchSessionItem['provider']; running?: boolean; size?: 'row' | 'menu';
}) {
  const meta = providerMeta(provider);
  return <span className={`wb-mark is-${size} home-icon tone-${meta.tone}`} data-running={running ? 'true' : undefined} aria-hidden="true">
    {meta.mark || <MessagesSquare size={size === 'menu' ? 17 : 13} strokeWidth={1.8} />}
  </span>;
}
