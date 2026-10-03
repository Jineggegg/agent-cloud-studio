import { forwardRef, useId } from 'react';
import type { CSSProperties } from 'react';

import { HALO_PATHS, STAR_GRADIENT, STAR_PATH } from '@/shared/ui/starSpark';

type StarSparkProps = {
  className?: string;
  style?: CSSProperties;
  // How long the lines take to draw in (the halo first, then the star in one stroke).
  drawMs?: number;
  // The stroke width in viewBox units (the mark is 100 across).
  stroke?: number;
  // Turning in quarter turns, the halo the other way: while something loads.
  turning?: boolean;
  // Start turning only once the lines have drawn in (otherwise at once, as when turning is switched on later).
  turnAfterDraw?: boolean;
  // Growing into a star window (starSpark.ts): the halo flies off and the star becomes a thin constant-width line.
  zooming?: boolean;
};

/**
 * The four-pointed spark with its halo, as an inline svg: the same markup as the launch splash in index.html (keep the
 * two in step), whose inline `.acs-star` styles animate it. Used by LaunchScreen (shared/ui) and by the studio module's
 * app launch and loading placeholder.
 */
export const StarSpark = forwardRef<SVGSVGElement, StarSparkProps>(function StarSpark(
  { className, style, drawMs = 1100, stroke = 4.5, turning = false, turnAfterDraw = false, zooming = false }, ref,
) {
  // An id per instance (React's own contains characters that url(#…) would have to escape).
  const gradient = `acs-star-${useId().replace(/[^\w-]/g, '')}`;
  const vars = {
    '--star-draw': `${drawMs}ms`,
    '--star-stroke': stroke,
    ...(turnAfterDraw ? { '--star-turn-delay': `${drawMs}ms` } : {}),
    ...style,
  } as CSSProperties;
  const classes = ['acs-star', turning && 'is-turning', zooming && 'is-zooming', className].filter(Boolean).join(' ');
  return <svg ref={ref} className={classes} style={vars} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
        {STAR_GRADIENT.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
      </linearGradient>
    </defs>
    <g className="acs-star-halo">
      {HALO_PATHS.map(path => <path key={path} className="acs-star-arc" d={path} pathLength={1} stroke={`url(#${gradient})`} />)}
    </g>
    <g className="acs-star-spark"><path d={STAR_PATH} pathLength={1} stroke={`url(#${gradient})`} /></g>
  </svg>;
});
