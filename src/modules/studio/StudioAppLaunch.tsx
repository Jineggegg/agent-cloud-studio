import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { StarSpark } from '@/shared/ui/StarSpark';
import { STAR_TIP, STAR_ZOOM_MS, freezeStarHalo, placeStarOutline, runStarZoom, starCoverRadius, starTurnRemaining, starWindowPolygon } from '@/shared/ui/starSpark';
import '@/modules/studio/studio-loading.css';

// The star's draw-in over a tapped icon: shorter than the launch screen's, so a tap still feels quick.
export const APP_LAUNCH_DRAW_MS = 650;
// The tapped icon's own glyph shrinks and fades under the star as it starts to draw.
const GLYPH_FADE_MS = 220;
// The star is drawn a little larger than what was tapped, within these bounds (a 32 px gear, a wide widget card).
const STAR_SCALE = 1.15;
const STAR_MIN_PX = 48;
const STAR_MAX_PX = 120;
// While the window opens, the app settles from slightly larger and out of focus.
const SETTLE_EASE = 'cubic-bezier(.2, .8, .2, 1)';

/** Where an app opens from: the centre of what was tapped, in viewport px, the star's size there, and the icon's glyph. */
export type StudioLaunchOrigin = { x: number; y: number; size: number; glyph: Element | null };

/**
 * Used by StudioPage when an icon, a widget or the settings gear opens an app: the launch origin for that tapped box.
 * `glyph` is the icon's own drawing found under its centre (the home screen's icons and its gear), which gives way to
 * the star; a widget card has none.
 */
export function appLaunchOrigin(box: DOMRect): StudioLaunchOrigin {
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const size = Math.min(STAR_MAX_PX, Math.max(STAR_MIN_PX, Math.min(box.width, box.height) * STAR_SCALE));
  const icon = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y)?.closest('.home-icon, .home-gear') : null;
  return { x, y, size, glyph: icon?.firstElementChild ?? null };
}

type Phase = 'drawing' | 'turning' | 'zooming';

/**
 * Used by StudioPage while an app opens from its icon (or a widget, or the gear): one continuous launch instead of an
 * icon zoom followed by a loading screen. The four-pointed star (StarSpark) draws itself over the icon as the icon's
 * glyph gives way; if the app is still `loading` (a sub-app's code or the project list) it turns in quarter turns until
 * it is ready and comes to rest upright; then it grows into a star-shaped window, centred on the icon, through which the
 * app (`app`, rendered underneath all along) is seen, its outline riding the window's edge as a thin line, until the
 * window clears the screen and `onOpened` runs. Until then the app is clipped to a pinpoint, so it neither shows nor
 * catches taps. StudioPage skips all of this under reduced motion and simply shows the app.
 */
export function StudioAppLaunch({ origin, name, loading, app, onOpened }: {
  origin: StudioLaunchOrigin; name: string; loading: boolean; app: RefObject<HTMLElement>; onOpened: () => void;
}) {
  const labelId = useId();
  const starRef = useRef<SVGSVGElement>(null);
  const [phase, setPhase] = useState<Phase>('drawing');
  // The latest props, for timers that outlive a render.
  const latest = useRef({ loading, onOpened });
  latest.current = { loading, onOpened };
  // When the star started turning, for browsers that cannot report their animations.
  const turningSince = useRef(0);

  // Before the first paint: the app shrinks to a pinpoint window at the icon's centre and the icon's glyph gives way.
  useLayoutEffect(() => {
    const element = app.current;
    if (element) {
      const box = element.getBoundingClientRect();
      element.style.clipPath = starWindowPolygon(origin.x - box.left, origin.y - box.top, 0);
    }
    const glyph = origin.glyph && typeof origin.glyph.animate === 'function'
      ? origin.glyph.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.6)' }], { duration: GLYPH_FADE_MS, easing: 'ease-out', fill: 'forwards' })
      : null;
    return () => {
      if (element) element.style.clipPath = '';
      glyph?.cancel();
    };
  }, [app, origin]);

  // Drawn in: straight on to the zoom when the app is ready, else turn until it is.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      turningSince.current = performance.now();
      setPhase(latest.current.loading ? 'turning' : 'zooming');
    }, APP_LAUNCH_DRAW_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Loaded while turning: finish the current quarter turn, so the star always comes to rest upright, then zoom.
  useEffect(() => {
    if (phase !== 'turning' || loading) return undefined;
    const elapsed = () => performance.now() - turningSince.current;
    const star = starRef.current;
    const timer = window.setTimeout(() => {
      if (star) freezeStarHalo(star, elapsed());
      setPhase('zooming');
    }, star ? starTurnRemaining(star, elapsed()) : 0);
    return () => window.clearTimeout(timer);
  }, [phase, loading]);

  // The one zoom: the star window grows from the icon until even its inner curves clear the screen's corners.
  useEffect(() => {
    if (phase !== 'zooming') return undefined;
    const element = app.current;
    const star = starRef.current;
    if (!element || !star || document.visibilityState === 'hidden') {
      latest.current.onOpened();
      return undefined;
    }
    const box = element.getBoundingClientRect();
    const x = origin.x - box.left;
    const y = origin.y - box.top;
    const content = element.firstElementChild;
    const transformOrigin = `${x}px ${y}px`;
    const settle = content && typeof content.animate === 'function'
      ? content.animate([{ transformOrigin, transform: 'scale(1.1)', filter: 'blur(6px)' }, { transformOrigin, transform: 'none', filter: 'none' }], { duration: STAR_ZOOM_MS, easing: SETTLE_EASE })
      : null;
    const stop = runStarZoom({
      from: (origin.size * STAR_TIP) / 100,
      to: starCoverRadius(x, y, box.width, box.height),
      onFrame: (radius, progress) => {
        element.style.clipPath = starWindowPolygon(x, y, radius);
        placeStarOutline(star, origin.x, origin.y, radius, progress);
      },
      onDone: () => {
        element.style.clipPath = '';
        settle?.cancel();
        latest.current.onOpened();
      },
    });
    return () => {
      stop();
      settle?.cancel();
    };
  }, [phase, app, origin]);

  const half = origin.size / 2;
  return <div className="studio-app-launch" role="status" aria-busy={phase !== 'zooming'} aria-labelledby={labelId}>
    <span id={labelId} className="studio-visually-hidden">正在打开 {name}</span>
    <StarSpark ref={starRef} drawMs={APP_LAUNCH_DRAW_MS} stroke={5.5} turning={phase === 'turning'} zooming={phase === 'zooming'}
      style={{ left: origin.x - half, top: origin.y - half, width: origin.size, height: origin.size }} />
  </div>;
}
