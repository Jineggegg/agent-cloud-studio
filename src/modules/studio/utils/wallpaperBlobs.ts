/*
 * The home wallpaper's liquid colour bubbles (StudioFluidBackground), as pure functions of the running time: three
 * round bubbles that drift slowly in their own part of the screen, breathe, squash and stretch, and wobble at their
 * edges like drops of liquid, heavily blurred, on a plain white or black base (colour fills only about a quarter of
 * the screen). The scene has one colour at a time (every bubble is a shade of it);
 * the colour holds for about 15 s, then eases over 6 s into the next fresh iOS-wallpaper colour, and round again.
 * Everything is a function of elapsed ms, so a frame's look never depends on the frame rate. Sizes are in CSS px.
 */

/** One colour of the scene: its name, and its hue (degrees), saturation and lightness (%) as the blobs glow at night. */
export type WallpaperColour = { name: string; hue: number; saturation: number; lightness: number };

/** The scene's colour at one moment, plus `glow`: 1 normally, lower part-way through a long change of hue. */
export type SceneColour = WallpaperColour & { glow: number };

/** One blob's character: where it wanders, how big it is and how it breathes and wobbles. Periods are in ms. */
export type Blob = {
  // Centre of its wandering and how far it strays, as fractions of the screen's width and height.
  homeX: number; homeY: number; rangeX: number; rangeY: number;
  periodX: number; periodY: number; phaseX: number; phaseY: number;
  // Resting radius as a fraction of the screen's longer side.
  radius: number;
  // A slow ±breathe swell of the radius.
  breathe: number; breathePeriod: number;
  // Squash and stretch: the blob widens while it flattens (and the other way), and the axis slowly turns.
  squash: number; squashPeriod: number; turnPeriod: number;
  // Soft bulges round the rim: k lobes of `amount` (share of the radius), each drifting round at its own period.
  wobble: readonly { lobes: number; amount: number; period: number; phase: number }[];
  // Small shifts from the scene colour, so the two blobs read as one colour in two shades.
  hueShift: number; lightnessShift: number;
  // Peak opacity on the dark wallpaper.
  opacity: number;
};

/**
 * The order the colours take turns in, then round again. Every hue lies between orange (30°) and azure (206°), and
 * changes run straight along the wheel between them, so no change ever passes through purple, pink or red.
 */
export const WALLPAPER_COLOURS: readonly WallpaperColour[] = [
  { name: '天蓝', hue: 206, saturation: 92, lightness: 56 },
  { name: '薄荷', hue: 164, saturation: 72, lightness: 48 },
  { name: '草绿', hue: 100, saturation: 62, lightness: 48 },
  { name: '橙', hue: 30, saturation: 98, lightness: 58 },
];
/** How long one colour lasts (its change into the next included), in ms of running animation. */
export const COLOUR_MS = 21_000;
/** How long a change into the next colour takes, at the end of each colour's turn. */
export const COLOUR_CHANGE_MS = 6_000;
// A change across half the wheel (orange back to azure) dims the blobs by this much at its middle, so the colours
// it sweeps through on the way barely show: the old colour fades out and the new one blooms.
const LONG_CHANGE_DIP = 0.55;

/**
 * Three bubbles of one colour in three shades, floating on a plain white (by day) or black (at night) wallpaper. Each
 * keeps to its own part of the screen and fades to nothing at its rim, so together they colour about a quarter of
 * it and the rest stays empty.
 */
export const WALLPAPER_BLOBS: readonly Blob[] = [
  {
    homeX: 0.3, homeY: 0.32, rangeX: 0.16, rangeY: 0.14, periodX: 67_000, periodY: 83_000, phaseX: 0, phaseY: 1.2,
    radius: 0.17, breathe: 0.07, breathePeriod: 11_000, squash: 0.08, squashPeriod: 13_000, turnPeriod: 90_000,
    wobble: [
      { lobes: 2, amount: 0.07, period: 17_000, phase: 0 },
      { lobes: 3, amount: 0.045, period: 11_000, phase: 1.7 },
      { lobes: 4, amount: 0.02, period: 7_500, phase: 0.6 },
    ],
    hueShift: 0, lightnessShift: 0, opacity: 0.8,
  },
  {
    homeX: 0.72, homeY: 0.7, rangeX: 0.14, rangeY: 0.15, periodX: 74_000, periodY: 59_000, phaseX: 2.4, phaseY: 4.1,
    radius: 0.14, breathe: 0.08, breathePeriod: 9_000, squash: 0.09, squashPeriod: 15_500, turnPeriod: -105_000,
    wobble: [
      { lobes: 2, amount: 0.06, period: 19_000, phase: 2.2 },
      { lobes: 3, amount: 0.05, period: 12_500, phase: 0.3 },
      { lobes: 5, amount: 0.018, period: 8_000, phase: 3.1 },
    ],
    hueShift: 6, lightnessShift: 9, opacity: 0.7,
  },
  {
    homeX: 0.78, homeY: 0.22, rangeX: 0.1, rangeY: 0.1, periodX: 81_000, periodY: 69_000, phaseX: 4.0, phaseY: 0.5,
    radius: 0.09, breathe: 0.09, breathePeriod: 12_500, squash: 0.07, squashPeriod: 10_500, turnPeriod: 120_000,
    wobble: [
      { lobes: 2, amount: 0.06, period: 15_000, phase: 1.1 },
      { lobes: 3, amount: 0.04, period: 9_500, phase: 2.6 },
    ],
    hueShift: -8, lightnessShift: -4, opacity: 0.6,
  },
];
/** How many points trace a blob's rim (joined by smooth curves). */
export const BLOB_POINTS = 24;

const TAU = Math.PI * 2;
/** An S-curve from 0 to 1, flat at both ends, so a change starts and settles gently. */
const smoothstep = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The scene's colour after `elapsedMs` of running animation: each colour holds, then in the last COLOUR_CHANGE_MS
 * of its turn eases into the next, hue, saturation and lightness together. Hue moves in a straight line (never the
 * wrap-around way), and a long change dims the glow at its middle in proportion to how far the hue travels.
 */
export function wallpaperColourAt(elapsedMs: number): SceneColour {
  const time = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const turn = Math.floor(time / COLOUR_MS);
  const from = WALLPAPER_COLOURS[turn % WALLPAPER_COLOURS.length];
  const to = WALLPAPER_COLOURS[(turn + 1) % WALLPAPER_COLOURS.length];
  const into = time - turn * COLOUR_MS - (COLOUR_MS - COLOUR_CHANGE_MS);
  if (into <= 0) return { ...from, glow: 1 };
  const t = smoothstep(into / COLOUR_CHANGE_MS);
  const travel = Math.abs(to.hue - from.hue) / 180;
  return {
    name: t < 0.5 ? from.name : to.name,
    hue: mix(from.hue, to.hue, t),
    saturation: mix(from.saturation, to.saturation, t),
    lightness: mix(from.lightness, to.lightness, t),
    glow: 1 - LONG_CHANGE_DIP * Math.min(1, travel) * Math.sin(Math.PI * t),
  };
}

/**
 * Where a blob is and what shape it has `elapsedMs` in, on a `width` × `height` screen: its centre (a slow
 * Lissajous wander), its resting radius now (breathing), and BLOB_POINTS points round its squashed, wobbling rim.
 */
export function blobOutline(blob: Blob, elapsedMs: number, width: number, height: number) {
  const time = Math.max(0, elapsedMs);
  const wave = (period: number, phase = 0) => Math.sin((TAU * time) / period + phase);
  const x = width * (blob.homeX + blob.rangeX * wave(blob.periodX, blob.phaseX));
  const y = height * (blob.homeY + blob.rangeY * wave(blob.periodY, blob.phaseY));
  const radius = Math.max(width, height) * blob.radius * (1 + blob.breathe * wave(blob.breathePeriod));
  // Squash and stretch keep the area about the same: wider by s, flatter by s.
  const stretch = 1 + blob.squash * wave(blob.squashPeriod);
  const turn = (TAU * time) / blob.turnPeriod;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const points: [x: number, y: number][] = [];
  for (let index = 0; index < BLOB_POINTS; index++) {
    const angle = (TAU * index) / BLOB_POINTS;
    let reach = 1;
    for (const { lobes, amount, period, phase } of blob.wobble) reach += amount * Math.sin(lobes * angle + (TAU * time) / period + phase);
    const localX = Math.cos(angle) * radius * reach * stretch;
    const localY = (Math.sin(angle) * radius * reach) / stretch;
    points.push([x + localX * cos - localY * sin, y + localX * sin + localY * cos]);
  }
  return { x, y, radius, points };
}

/**
 * The colour stops of a blob's radial fill, from its centre to its rim: brightest in the middle, still half-strong at
 * the rim (the blur makes the edge). At night the blobs glow at full colour on the near-black; by day they are lighter
 * and fainter, a vivid pastel on the bright base.
 */
export function blobStops(colour: SceneColour, blob: Pick<Blob, 'hueShift' | 'lightnessShift' | 'opacity'>, dark: boolean): [offset: number, color: string][] {
  const hue = colour.hue + blob.hueShift;
  const saturation = dark ? colour.saturation : Math.min(100, colour.saturation + 4);
  const lightness = dark ? colour.lightness + blob.lightnessShift : Math.min(78, colour.lightness + 10 + blob.lightnessShift * 0.6);
  const peak = blob.opacity * colour.glow * (dark ? 1 : 0.85);
  const color = (alpha: number) => `hsla(${hue.toFixed(1)}, ${saturation.toFixed(1)}%, ${lightness.toFixed(1)}%, ${alpha.toFixed(4)})`;
  // Strong in the middle, gone at the rim: a bubble with no edge, the empty wallpaper all round it.
  return [[0, color(peak)], [0.5, color(peak * 0.7)], [1, color(0)]];
}

/**
 * The base under the blobs, top to bottom: plain near-black at night and near-white by day, only a breath of the
 * scene's hue, so the bubbles are the only colour on screen.
 */
export function wallpaperBase(colour: SceneColour, dark: boolean): [top: string, bottom: string] {
  const hue = colour.hue.toFixed(1);
  return dark
    ? [`hsl(${hue}, 6%, 6.5%)`, `hsl(${hue}, 4%, 3.5%)`]
    : [`hsl(${hue}, 18%, 98%)`, `hsl(${hue}, 10%, 96.5%)`];
}

/**
 * The shortest time between two drawn frames: 30 fps on high-density screens and devices that ask for less (reduced
 * data, few cores), where the slow, blurred blobs look the same at half the work; otherwise every display frame.
 */
export function blobFrameInterval({ devicePixelRatio, prefersLess }: { devicePixelRatio: number; prefersLess: boolean }): number {
  return prefersLess || devicePixelRatio >= 2 ? 1000 / 30 : 0;
}
