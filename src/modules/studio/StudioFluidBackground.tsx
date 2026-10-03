import { useEffect, useRef, useSyncExternalStore } from 'react';

import { BEAM_COUNT, beamFamilyAt, beamFrameInterval, beamStops, spawnBeam, stepBeam } from '@/modules/studio/utils/wallpaperBeams';

// The beams are drawn at about a third of the screen's CSS resolution and a CSS blur softens the upscale: they look
// the same as at full resolution for a fraction of the work, which keeps an iPad cool.
const CANVAS_SCALE = 0.35;
// How much the beams are blurred, in CSS px (scaled to the canvas where the 2D canvas applies filters).
const BEAM_BLUR_PX = 35;
// Beam strength on each wallpaper: full on the near-black, about half on the near-white so they read as soft pastel.
const DARK_STRENGTH = 1;
const LIGHT_STRENGTH = 0.55;
// A frame later than this (a stalled tab, a slow device) moves the beams no further, so they never jump.
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
 * Used by StudioHomeScreen as the home wallpaper: blurred diagonal light beams rising slowly over a calm gradient,
 * their colours one family at a time (utils/wallpaperBeams). The gradient and grain are CSS (studio.css,
 * .home-wallpaper), so the wallpaper still looks right where the 2D canvas fails; there is no WebGL. The beams stop
 * while the page is hidden or an app covers the home screen (`paused`), and hold one still frame under reduced motion.
 */
export function StudioFluidBackground({ dark, paused }: { dark: boolean; paused: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The beams and how long they have run (which picks the colour family) outlive a pause, so the wallpaper resumes
  // where it stopped instead of starting over.
  const scene = useRef<{ beams: ReturnType<typeof spawnBeam>[]; elapsed: number; width: number; height: number } | null>(null);
  const hidden = useSyncExternalStore(subscribeVisibility, readHidden, readStill);
  const reduced = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, readStill);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d') ?? null;
    if (!canvas || !context) return undefined;
    const filters = canvasAppliesFilters(context);
    // The CSS blur is stronger where the canvas cannot blur the beams itself.
    canvas.dataset.blur = filters ? 'canvas' : 'css';
    const strength = dark ? DARK_STRENGTH : LIGHT_STRENGTH;

    // Sizes the canvas to its box (a new size scatters a fresh set of beams over it, in the current family).
    const fit = () => {
      const width = canvas.clientWidth || window.innerWidth;
      const height = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.round(width * CANVAS_SCALE));
      canvas.height = Math.max(1, Math.round(height * CANVAS_SCALE));
      const current = scene.current;
      if (current && Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1) return current;
      const elapsed = current?.elapsed ?? 0;
      const hue = beamFamilyAt(elapsed).hue;
      scene.current = { beams: Array.from({ length: BEAM_COUNT }, () => spawnBeam(width, height, hue)), elapsed, width, height };
      return scene.current;
    };
    const draw = () => {
      const { beams, width } = scene.current ?? fit();
      const scale = canvas.width / width;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      if (filters) context.filter = `blur(${(BEAM_BLUR_PX * scale).toFixed(1)}px)`;
      for (const beam of beams) {
        context.save();
        context.translate(beam.x, beam.y);
        context.rotate((beam.angle * Math.PI) / 180);
        const gradient = context.createLinearGradient(0, 0, 0, beam.length);
        for (const [offset, color] of beamStops(beam, strength)) gradient.addColorStop(offset, color);
        context.fillStyle = gradient;
        context.fillRect(-beam.width / 2, 0, beam.width, beam.length);
        context.restore();
      }
    };
    const refit = () => { fit(); draw(); };
    refit();
    window.addEventListener('resize', refit);
    // Still: one frame (reduced motion), or nothing more until the home screen is seen again.
    if (reduced || paused || hidden) return () => window.removeEventListener('resize', refit);

    const interval = beamFrameInterval({ devicePixelRatio: window.devicePixelRatio || 1, prefersLess: devicePrefersLess() });
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // A millisecond of slack keeps a 60 Hz display at a steady 30 fps when capped.
      if (now - last < interval - 1) return;
      const step = Math.min(now - last, MAX_STEP_MS);
      last = now;
      const current = scene.current ?? fit();
      current.elapsed += step;
      const hue = beamFamilyAt(current.elapsed).hue;
      current.beams = current.beams.map((beam, index) => stepBeam(beam, index, current.beams.length, current.width, current.height, hue, step));
      draw();
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', refit);
    };
  }, [dark, hidden, paused, reduced]);

  return <div className={`home-wallpaper ${paused || hidden ? 'is-paused' : ''}`} aria-hidden="true">
    <canvas ref={canvasRef} className="home-beams" />
    <span className="home-beams-dim" />
  </div>;
}
