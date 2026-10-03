import type { ReactNode } from 'react';

import { IconActivity, IconBook, IconChartCandle, IconChartLine, IconFolder, IconGitPullRequest, IconMail, IconPlug, IconSchool, IconSettings, IconSparkles, IconTerminal2, IconWorld } from '@/modules/studio/icons/tabler';
import type { StudioBrand, StudioHomeTile } from '@/shared/types';
import { StudioBrandMark } from '@/modules/studio/brandIcons';

// Tabler line icons (icons/tabler). System apps may use glyphs that projects cannot pick (settings, plug, pull-request for GitHub).
type Glyph = StudioHomeTile['glyph'];
const ICONS: Record<Glyph, typeof IconFolder> = {
  activity: IconActivity, graduation: IconSchool, candles: IconChartCandle, mail: IconMail, folder: IconFolder,
  terminal: IconTerminal2, sparkles: IconSparkles, book: IconBook, chart: IconChartLine, globe: IconWorld,
  settings: IconSettings, plug: IconPlug, 'pull-request': IconGitPullRequest,
};

// Built-in apps and widgets named after a product with a published mark, by tile id or widget type. Everything else,
// including every project the owner creates (`project:<id>`), keeps its glyph.
const PRODUCT_BRANDS = new Map<string, StudioBrand>([
  ['github', 'github'], ['deepseek', 'deepseek'], ['claude', 'claude'], ['codex', 'openai'],
]);

/**
 * Used across the studio module (home screen, project app, editor, chat list) and by the workbench project switcher to draw one muted app icon.
 * `product` names the built-in app, widget or mail provider the icon stands for; one with an official mark (GitHub,
 * DeepSeek, Claude, Codex) shows that mark in one colour instead of the glyph (brandIcons).
 * `children` are drawn on the icon's face, clipped to its rounded shape (the AI build veil and ring).
 */
export function StudioTileIcon({ tone, glyph, product, size = 40, variant, children }: {
  tone: string; glyph: Glyph | string; product?: string; size?: number; variant?: 'small' | 'large'; children?: ReactNode;
}) {
  const brand = product ? PRODUCT_BRANDS.get(product) : undefined;
  const Icon = ICONS[glyph as Glyph] ?? IconFolder;
  return <span className={`home-icon ${variant ?? ''} tone-${tone}`} aria-hidden="true">
    {brand ? <StudioBrandMark brand={brand} size={size} /> : <Icon size={size} strokeWidth={1.6} />}{children}
  </span>;
}
