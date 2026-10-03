import type { CSSProperties } from 'react';

import { StudioBrandMark } from '@/modules/studio';
import { providerMeta } from '@/modules/workbench/utils/workbenchRoutes';

// From this size up the stone is drawn like a home-screen icon, with its full drop shadow.
const LARGE_SIZE = 48;
// The official mark fills this share of the stone, the optical size of Studio's other icon glyphs.
const MARK_SCALE = 0.64;

/**
 * Used across the workbench module — history rows, the new-session menu, the shell's fallback title bar, and the
 * chat column's header, model menu, empty state, turn labels and permission sheets — as the one provider badge: a
 * mineral stone like the Studio's app icons, carrying the provider's official mark (Claude, OpenAI for Codex,
 * DeepSeek). `size` is the side in px; a running session's stone breathes.
 */
export function WorkbenchProviderMark({ provider, size = 24, running = false }: { provider: string; size?: number; running?: boolean }) {
  const meta = providerMeta(provider);
  return <span className={`wb-mark home-icon tone-${meta.tone}${size >= LARGE_SIZE ? ' is-large' : ''}`}
    style={{ '--icon': `${size}px` } as CSSProperties} data-running={running ? 'true' : undefined} data-provider={provider} aria-hidden="true">
    <StudioBrandMark brand={meta.brand} size={Math.round(size * MARK_SCALE)} />
  </span>;
}
