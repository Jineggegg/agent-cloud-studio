import type { ComponentType, ReactNode } from 'react';
import {
  Activity, BookOpen, CandlestickChart, ChartLine, Folder, GitPullRequest, Globe, GraduationCap, Mail, Plug, Settings, Sparkles, SquareTerminal,
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';

import type { StudioHomeTile } from '@/shared/types';

// System apps may use glyphs that projects cannot pick (settings, plug, pull-request for GitHub).
type Glyph = StudioHomeTile['glyph'];
const ICONS: Record<Glyph, ComponentType<LucideProps>> = {
  activity: Activity, graduation: GraduationCap, candles: CandlestickChart, mail: Mail, folder: Folder,
  terminal: SquareTerminal, sparkles: Sparkles, book: BookOpen, chart: ChartLine, globe: Globe,
  settings: Settings, plug: Plug, 'pull-request': GitPullRequest,
};

/**
 * Used across the studio module (home screen, project app, editor, chat list) and by the workbench project switcher to draw one muted app icon.
 * `children` are drawn on the icon's face, clipped to its rounded shape (the AI build veil and ring).
 */
export function StudioTileIcon({ tone, glyph, size = 40, variant, children }: {
  tone: string; glyph: Glyph | string; size?: number; variant?: 'small' | 'large'; children?: ReactNode;
}) {
  const Icon = ICONS[glyph as Glyph] ?? Folder;
  return <span className={`home-icon ${variant ?? ''} tone-${tone}`} aria-hidden="true"><Icon size={size} strokeWidth={1.6} />{children}</span>;
}
