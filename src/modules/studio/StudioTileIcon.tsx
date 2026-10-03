import { useId } from 'react';
import type { ReactNode } from 'react';

import { IconActivity, IconBook, IconChartCandle, IconChartLine, IconFolder, IconGitPullRequest, IconMail, IconPlug, IconSchool, IconSettings, IconSparkles, IconTerminal2, IconWorld } from '@/modules/studio/icons/tabler';
import type { StudioBrand, StudioHomeTile } from '@/shared/types';
import { StudioBrandMark } from '@/modules/studio/brandIcons';
import { HALO_PATHS, STAR_GRADIENT, STAR_PATH } from '@/shared/ui/starSpark';

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

// Built-in apps that wear Studio's own logo, the four-pointed spark, instead of a glyph or a product mark.
const SPARK_PRODUCTS = new Set(['harness']);

// The spark and its halo, still and in the logo's own gradient (shared/ui StarSpark is the animated one).
function SparkMark({ size }: { size: number }) {
  // An id per instance (React's own contains characters that url(#…) would have to escape).
  const gradient = `tile-spark-${useId().replace(/[^\w-]/g, '')}`;
  return <svg className="home-spark" data-icon="spark" width={size * 1.1} height={size * 1.1} viewBox="0 0 100 100" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
        {STAR_GRADIENT.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
      </linearGradient>
    </defs>
    {HALO_PATHS.map(path => <path key={path} d={path} stroke={`url(#${gradient})`} strokeWidth={5} />)}
    <path d={STAR_PATH} stroke={`url(#${gradient})`} strokeWidth={6} />
  </svg>;
}

/**
 * Used across the studio module (home screen, project app, editor, chat list) and by the workbench project switcher to draw one muted app icon.
 * `product` names the built-in app, widget or mail provider the icon stands for; one with an official mark (GitHub,
 * DeepSeek, Claude, Codex) shows that mark in one colour instead of the glyph (brandIcons); Harness wears Studio's spark.
 * `children` are drawn on the icon's face, clipped to its rounded shape (the AI build veil and ring).
 */
export function StudioTileIcon({ tone, glyph, product, size = 40, variant, children }: {
  // `mini` is an icon in miniature on a home-screen folder.
  tone: string; glyph: Glyph | string; product?: string; size?: number; variant?: 'small' | 'large' | 'mini'; children?: ReactNode;
}) {
  const brand = product ? PRODUCT_BRANDS.get(product) : undefined;
  const Icon = ICONS[glyph as Glyph] ?? IconFolder;
  return <span className={`home-icon ${variant ?? ''} tone-${tone}`} aria-hidden="true">
    {product && SPARK_PRODUCTS.has(product) ? <SparkMark size={size} />
      : brand ? <StudioBrandMark brand={brand} size={size} /> : <Icon size={size} strokeWidth={1.6} />}{children}
  </span>;
}
