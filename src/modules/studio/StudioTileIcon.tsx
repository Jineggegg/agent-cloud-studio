import type { ComponentType } from 'react';
import {
  Activity, BookOpen, CandlestickChart, ChartLine, Folder, Globe, GraduationCap, Mail, Plug, Settings, Sparkles, SquareTerminal,
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';

import type { StudioGlyph } from '@/shared/types';

// System apps may use glyphs that projects cannot pick (settings, plug).
type Glyph = StudioGlyph | 'settings' | 'plug';
const ICONS: Record<Glyph, ComponentType<LucideProps>> = {
  activity: Activity, graduation: GraduationCap, candles: CandlestickChart, mail: Mail, folder: Folder,
  terminal: SquareTerminal, sparkles: Sparkles, book: BookOpen, chart: ChartLine, globe: Globe,
  settings: Settings, plug: Plug,
};

/** Used across the studio module (home screen, project app, editor, chat list) and by the workbench project switcher to draw one muted app icon. */
export function StudioTileIcon({ tone, glyph, size = 40, variant }: {
  tone: string; glyph: Glyph | string; size?: number; variant?: 'small' | 'large';
}) {
  const Icon = ICONS[glyph as Glyph] ?? Folder;
  return <span className={`home-icon ${variant ?? ''} tone-${tone}`} aria-hidden="true"><Icon size={size} strokeWidth={1.6} /></span>;
}
