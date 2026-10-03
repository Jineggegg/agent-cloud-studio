/*
 * The home wallpaper's light beams (StudioFluidBackground), as pure functions: blurred diagonal beams that rise slowly
 * and pulse, in the style of the BeamsBackground component. Their colours come from one family at a time, spread ±25°
 * around the family's hue; the family changes about every 40 s and each beam's hue eases toward the new family over
 * about 10 s, so a change is gradual. Positions and sizes are in CSS px; speeds are px per 60 fps frame.
 */

/** One colour family of the beams: its name and centre hue in degrees. */
type BeamFamily = { name: string; hue: number };

/** One beam: a rotated rectangle filled with a gradient that fades in and out along its length. */
type Beam = {
  x: number; y: number; width: number; length: number;
  // Degrees; negative leans the beam's top to the right.
  angle: number;
  // Px per 60 fps frame, upwards.
  speed: number;
  // Peak opacity before the pulse and the theme's strength.
  opacity: number;
  // The hue drawn now, and this beam's fixed offset from its family's hue.
  hue: number; spread: number;
  // Phase and speed (radians per 60 fps frame) of the ±20 % opacity pulse.
  pulse: number; pulseSpeed: number;
};

/** A source of random numbers in [0, 1); injectable so tests can pin the beams. */
type Random = () => number;

// The order the families take turns in, then round again (gold back after jade).
const BEAM_FAMILIES: readonly BeamFamily[] = [
  { name: '金', hue: 46 },
  { name: '橙', hue: 28 },
  { name: '珊瑚', hue: 10 },
  { name: '玫瑰', hue: 340 },
  { name: '紫', hue: 275 },
  { name: '靛蓝', hue: 230 },
  { name: '青', hue: 190 },
  { name: '翠', hue: 155 },
];
/** How long one family lasts, in ms of running animation. */
export const BEAM_FAMILY_MS = 40_000;
/** How many beams are on screen. */
export const BEAM_COUNT = 30;
// Beams spread this many degrees either side of their family's hue.
const HUE_SPREAD = 25;
// A beam's hue covers ~98 % of the way to a new family in this time (four time constants of an exponential ease).
const HUE_EASE_MS = 10_000;
// One 60 fps frame: beam speeds and pulse speeds are given per such frame.
const FRAME_MS = 1000 / 60;

/** The family the beams take their colours from after `elapsedMs` of running animation. */
export function beamFamilyAt(elapsedMs: number): BeamFamily {
  const index = Math.floor(Math.max(0, elapsedMs) / BEAM_FAMILY_MS) % BEAM_FAMILIES.length;
  return BEAM_FAMILIES[index];
}

/** A hue in [0, 360). */
const wrapHue = (hue: number) => ((hue % 360) + 360) % 360;

/**
 * Moves `current` toward `target` by the shorter way round the colour wheel, easing exponentially so that after
 * HUE_EASE_MS it has all but arrived, whatever the frame rate.
 */
export function easeHue(current: number, target: number, elapsedMs: number): number {
  const difference = ((wrapHue(target) - wrapHue(current) + 540) % 360) - 180;
  const share = 1 - Math.exp(-Math.max(0, elapsedMs) / (HUE_EASE_MS / 4));
  return wrapHue(current + difference * share);
}

/** A beam anywhere on (and a little around) a `width` × `height` screen, as the wallpaper first appears. */
export function spawnBeam(width: number, height: number, familyHue: number, random: Random = Math.random): Beam {
  const spread = -HUE_SPREAD + random() * HUE_SPREAD * 2;
  return {
    x: random() * width * 1.5 - width * 0.25,
    y: random() * height * 1.5 - height * 0.25,
    width: 30 + random() * 60,
    length: height * 2.5,
    angle: -35 + random() * 10,
    speed: 0.6 + random() * 1.2,
    opacity: 0.12 + random() * 0.16,
    hue: wrapHue(familyHue + spread), spread,
    pulse: random() * Math.PI * 2,
    pulseSpeed: 0.02 + random() * 0.03,
  };
}

/**
 * A beam that has risen off the top starts again below the screen, in one of three columns by its index (so the
 * beams stay spread across the width), wider and slower than at first, its offset spread evenly over the family.
 */
export function resetBeam(beam: Beam, index: number, total: number, width: number, height: number, random: Random = Math.random): Beam {
  const column = index % 3;
  const spacing = width / 3;
  return {
    ...beam,
    y: height + 100,
    x: column * spacing + spacing / 2 + (random() - 0.5) * spacing * 0.5,
    length: height * 2.5,
    width: 100 + random() * 60,
    speed: 0.5 + random() * 0.4,
    opacity: 0.2 + random() * 0.1,
    spread: -HUE_SPREAD + (index * HUE_SPREAD * 2) / Math.max(1, total),
  };
}

/**
 * The beam `elapsedMs` later: risen by its speed, its pulse advanced, its hue eased toward its place in the family
 * (`familyHue` plus its spread); once wholly above the screen it starts again below (resetBeam).
 */
export function stepBeam(beam: Beam, index: number, total: number, width: number, height: number, familyHue: number, elapsedMs: number, random: Random = Math.random): Beam {
  const frames = Math.max(0, elapsedMs) / FRAME_MS;
  const moved = {
    ...beam,
    y: beam.y - beam.speed * frames,
    pulse: beam.pulse + beam.pulseSpeed * frames,
    hue: easeHue(beam.hue, familyHue + beam.spread, elapsedMs),
  };
  return moved.y + moved.length < -100 ? resetBeam(moved, index, total, width, height, random) : moved;
}

/**
 * The colour stops of a beam's gradient, from its foot to its tip: transparent ends, half strength near them and full
 * strength through the middle. The peak pulses ±20 % and is scaled by `strength` (lower on the light wallpaper).
 */
export function beamStops(beam: Pick<Beam, 'hue' | 'opacity' | 'pulse'>, strength: number): [offset: number, color: string][] {
  const peak = beam.opacity * (0.8 + Math.sin(beam.pulse) * 0.2) * strength;
  const color = (alpha: number) => `hsla(${beam.hue.toFixed(1)}, 85%, 65%, ${alpha.toFixed(4)})`;
  return [[0, color(0)], [0.1, color(peak * 0.5)], [0.4, color(peak)], [0.6, color(peak)], [0.9, color(peak * 0.5)], [1, color(0)]];
}

/**
 * The shortest time between two drawn frames: 30 fps on high-density screens and devices that ask for less (reduced
 * data, few cores), where the blurred beams look the same at half the work; otherwise every display frame.
 */
export function beamFrameInterval({ devicePixelRatio, prefersLess }: { devicePixelRatio: number; prefersLess: boolean }): number {
  return prefersLess || devicePixelRatio >= 2 ? 1000 / 30 : 0;
}
