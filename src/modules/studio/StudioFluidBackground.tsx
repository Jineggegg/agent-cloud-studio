import { useEffect, useRef, useSyncExternalStore } from 'react';

import { WALLPAPER_BLOBS, blobFrameInterval, blobOutline, blobStops, wallpaperBase, wallpaperColourAt } from '@/modules/studio/utils/wallpaperBlobs';

// The blobs are drawn at a quarter of the screen's CSS resolution and a CSS blur softens the upscale: for shapes this
// soft it looks the same as full resolution for a sixteenth of the pixels, which keeps an iPad cool.
const CANVAS_SCALE = 0.25;
// How much the blobs are blurred, in CSS px (scaled to the canvas where the 2D canvas applies filters): heavy, so
// they read as glowing light rather than shapes, while their slow wobble still shows.
const BLOB_BLUR_PX = 90;
// A frame later than this (a stalled tab, a slow device) moves the blobs no further, so they never jump.
const MAX_STEP_MS = 100;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const subscribeVisibility = (notify: () => void) => {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
};
const readHidden = () => document.hidden;
const subscribeReducedMotion = (notify: () => void) => {
  const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
  query?.addEventListener?.('change', notify);
  return () => query?.removeEventListener?.('change', notify);
};
const readReducedMotion = () => Boolean(window.matchMedia?.(REDUCED_MOTION_QUERY).matches);
const readStill = () => false;

// Whether this 2D canvas applies `filter` (Safari before 18 ignores it); without it the CSS blur does all the softening.
function canvasAppliesFilters(context: CanvasRenderingContext2D) {
  if (!('filter' in context)) return false;
  context.filter = 'blur(2px)';
  const applied = context.filter === 'blur(2px)';
  context.filter = 'none';
  return applied;
}

// Devices that ask for less work (reduced data, few cores) get 30 fps.
function devicePrefersLess() {
  const cores = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency || 0;
  return Boolean(window.matchMedia?.('(prefers-reduced-data: reduce)').matches) || (cores > 0 && cores <= 4);
}

/**
 * Used by StudioHomeScreen as the home wallpaper: three heavily blurred liquid bubbles that drift, breathe and wobble
 * over a plain white or black base, one fresh colour at a time, changing slowly (utils/wallpaperBlobs).
 * A calm CSS gradient and grain sit under and over the canvas (studio.css, .home-wallpaper), so the wallpaper still
 * looks right where the 2D canvas fails; there is no WebGL. The blobs stop while the page is hidden or an app covers
 * the home screen (`paused`), and hold one still frame under reduced motion.
 */
export function StudioFluidBackground({ dark, paused }: { dark: boolean; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // How long the blobs have run: their places, shapes and colour all follow from it. It outlives a pause, so the
  // wallpaper resumes where it stopped instead of starting over.
  const elapsed = useRef(0);
  const hidden = useSyncExternalStore(subscribeVisibility, readHidden, readStill);
  const reduced = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, readStill);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d') ?? null;
    if (!canvas || !context) return undefined;
    const filters = canvasAppliesFilters(context);
    // The CSS blur is stronger where the canvas cannot blur the blobs itself.
    canvas.dataset.blur = filters ? 'canvas' : 'css';
    let width = 1;
    let height = 1;

    // Sizes the canvas to its box (in CSS px; the canvas itself holds a quarter of that).
    const fit = () => {
      width = canvas.clientWidth || window.innerWidth;
      height = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * CANVAS_SCALE));
      canvas.height = Math.max(1, Math.round(height * CANVAS_SCALE));
    };
    const draw = () => {
      const colour = wallpaperColourAt(elapsed.current);
      const scale = canvas.width / width;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      // The base: the scene colour, deep at night and airy by day, fills the whole canvas (no blur needed).
      if (filters) context.filter = 'none';
      const [top, bottom] = wallpaperBase(colour, dark);
      const base = context.createLinearGradient(0, 0, 0, height);
      base.addColorStop(0, top);
      base.addColorStop(1, bottom);
      context.fillStyle = base;
      context.fillRect(0, 0, width, height);
      // The blobs: each rim traced through its points with curves via the midpoints, so it stays round and smooth.
      if (filters) context.filter = `blur(${(BLOB_BLUR_PX * scale).toFixed(1)}px)`;
      for (const blob of WALLPAPER_BLOBS) {
        const { x, y, radius, points } = blobOutline(blob, elapsed.current, width, height);
        const fill = context.createRadialGradient(x, y, 0, x, y, radius * 1.15);
        for (const [offset, color] of blobStops(colour, blob, dark)) fill.addColorStop(offset, color);
        context.fillStyle = fill;
        context.beginPath();
        const last = points[points.length - 1];
        context.moveTo((last[0] + points[0][0]) / 2, (last[1] + points[0][1]) / 2);
        points.forEach((point, index) => {
          const next = points[(index + 1) % points.length];
          context.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
        });
        context.closePath();
        context.fill();
      }
    };
    const refit = () => { fit(); draw(); };
    refit();
    window.addEventListener('resize', refit);
    // Still: one frame (reduced motion), or nothing more until the home screen is seen again.
    if (reduced || paused || hidden) return () => window.removeEventListener('resize', refit);

    const interval = blobFrameInterval({ devicePixelRatio: window.devicePixelRatio || 1, prefersLess: devicePrefersLess() });
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // A millisecond of slack keeps a 60 Hz display at a steady 30 fps when capped.
      if (now - last < interval - 1) return;
      elapsed.current += Math.min(Math.max(0, now - last), MAX_STEP_MS);
      last = now;
      draw();
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', refit);
    };
  }, [dark, hidden, paused, reduced]);

  return <div className={`home-wallpaper ${paused || hidden ? 'is-paused' : ''}`} aria-hidden="true">
    <canvas ref={canvasRef} className="home-blobs" />
    <span className="home-blobs-veil" />
  </div>;
}
